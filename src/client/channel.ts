import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BridgeError, channelIdSchema, type ChannelStatus } from '../shared/protocol.js';
import { updateConfig, type BridgeConfig, type ChannelSessionConfig } from './config.js';
import { RelayClient } from './relay.js';

const uuidSchema = z.string().uuid();
const words = ['amber', 'birch', 'cedar', 'cloud', 'coral', 'dawn', 'fern', 'harbor', 'maple', 'moon', 'ocean', 'pine', 'river', 'silver', 'sun', 'willow'];
export function secretWord(): string { return `${words[randomInt(words.length)]}-${words[randomInt(words.length)]}-${randomBytes(2).toString('hex')}`; }
export function channelId(raw: string): string {
  if (!channelIdSchema.safeParse(raw).success) throw new BridgeError(0, 'INVALID_CHANNEL', 'Channel must contain 1–64 decimal digits with no leading zeroes (except 0)');
  return raw;
}
function explicitSession(raw?: string): string | undefined {
  if (raw !== undefined) {
    if (!uuidSchema.safeParse(raw).success) throw new BridgeError(0, 'INVALID_SESSION', 'Session must be a UUID');
    return raw;
  }
  return uuidSchema.safeParse(process.env.CODEX_THREAD_ID).success ? process.env.CODEX_THREAD_ID : undefined;
}
function sameIdentity(current: BridgeConfig | undefined, expected: BridgeConfig): asserts current is BridgeConfig {
  if (!current || current.url !== expected.url || current.token !== expected.token || current.device !== expected.device) throw new BridgeError(0, 'CONFIG_CHANGED', 'Relay credentials changed during this command; retry with the current configuration');
}
export interface LocalChannelSession extends ChannelSessionConfig { channel: string; session_id: string }
export function requireChannelSession(config: BridgeConfig, rawChannel: string, rawSession?: string): LocalChannelSession & { generation: string } {
  const channel = channelId(rawChannel);
  const saved = config.channel_sessions?.[channel];
  const sessionId = explicitSession(rawSession) ?? saved?.fallback_session_id;
  const session = sessionId ? saved?.sessions[sessionId] : undefined;
  if (!sessionId || !session?.generation) throw new BridgeError(0, 'CHANNEL_SESSION_REQUIRED', `Run bridge channel join ${channel} with this session first`);
  return { ...session, channel, session_id: sessionId, generation: session.generation };
}
async function reserveSession(expected: BridgeConfig, rawChannel: string, rawSession?: string): Promise<LocalChannelSession> {
  const channel = channelId(rawChannel); const requested = explicitSession(rawSession);
  let reserved: LocalChannelSession | undefined;
  await updateConfig(current => {
    sameIdentity(current, expected);
    const saved = current.channel_sessions?.[channel] ?? { sessions: {} };
    const sessionId = requested ?? saved.fallback_session_id ?? randomUUID();
    const previous = saved.sessions[sessionId];
    let candidate = secretWord(); while (candidate === previous?.secret_word) candidate = secretWord();
    // Every invocation proposes a fresh word for a possible new round. Active
    // rounds keep their authoritative word; transport retries reuse this body.
    const session = { ...previous, secret_word: candidate };
    reserved = { ...session, channel, session_id: sessionId };
    return { ...current, channel_sessions: { ...current.channel_sessions, [channel]: { ...saved, ...(!requested ? { fallback_session_id: sessionId } : {}), sessions: { ...saved.sessions, [sessionId]: session } } } };
  });
  return reserved!;
}
async function saveStatus(expected: BridgeConfig, original: LocalChannelSession, status: ChannelStatus): Promise<void> {
  if (status.channel !== original.channel || status.session_id !== original.session_id) throw new BridgeError(0, 'CHANNEL_IDENTITY_MISMATCH', 'Relay returned a different channel or session');
  await updateConfig(current => {
    sameIdentity(current, expected);
    const saved = current.channel_sessions?.[original.channel]; const session = saved?.sessions[original.session_id];
    if (!saved || !session) throw new BridgeError(0, 'SESSION_CHANGED', 'This channel session was removed during the command');
    if (session.generation !== original.generation && session.generation !== status.generation) throw new BridgeError(0, 'SESSION_CHANGED', 'Another command renewed this channel session; retry');
    return { ...current, channel_sessions: { ...current.channel_sessions, [original.channel]: { ...saved, sessions: { ...saved.sessions, [original.session_id]: { generation: status.generation, secret_word: status.secret_word } } } } };
  });
}
async function confirmStatus(client: RelayClient, initial: ChannelStatus): Promise<ChannelStatus> {
  let status = initial;
  for (let attempt = 0; ; attempt++) {
    try { return await client.confirmChannel(status.channel, status.session_id, status.generation, status.secret_word, status.pairing_id); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'channel_pairing_changed' || attempt >= 2) throw error;
      status = await client.channelStatus(status.channel, status.session_id, status.generation, 0);
    }
  }
}
export async function joinChannel(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, waitSeconds = 25): Promise<ChannelStatus> {
  const session = await reserveSession(config, channel, sessionId);
  let status = await client.joinChannel(session.channel, session.session_id, session.secret_word);
  await saveStatus(config, session, status);
  status = await confirmStatus(client, status);
  const deadline = Date.now() + waitSeconds * 1000;
  while (status.status !== 'connected' && Date.now() < deadline) {
    status = await client.channelStatus(status.channel, status.session_id, status.generation, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    // Joining/replacing a peer resets both confirmations. Confirm the word again
    // after a poll so the original participant can complete the mutual handshake.
    status = await confirmStatus(client, status);
  }
  return status;
}
export async function channelStatus(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, waitSeconds = 0): Promise<ChannelStatus> {
  const session = requireChannelSession(config, channel, sessionId);
  let status = await client.channelStatus(session.channel, session.session_id, session.generation, waitSeconds);
  if (status.status !== 'connected') status = await confirmStatus(client, status);
  return status;
}
export async function leaveChannel(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string): Promise<LocalChannelSession> {
  const session = requireChannelSession(config, channel, sessionId);
  let status: ChannelStatus | undefined;
  try { status = await client.channelStatus(session.channel, session.session_id, session.generation, 0); }
  catch (error) { if (!(error instanceof BridgeError) || error.code !== 'channel_session_expired') throw error; }
  if (status) await client.leaveChannel(session.channel, session.session_id, session.generation, status.pairing_id);
  await updateConfig(current => {
    sameIdentity(current, config);
    const saved = current.channel_sessions?.[session.channel];
    if (!saved || saved.sessions[session.session_id]?.generation !== session.generation) return current;
    const sessions = { ...saved.sessions }; delete sessions[session.session_id];
    return { ...current, channel_sessions: { ...current.channel_sessions, [session.channel]: { ...saved, sessions } } };
  });
  return session;
}
export function channelResult(status: ChannelStatus): ChannelStatus & { confirmation: string } {
  return { ...status, confirmation: status.status === 'connected' ? `Connected on channel ${status.channel}. Secret word is ${status.secret_word}.` : `Waiting for peer on channel ${status.channel}.` };
}
