import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BridgeError, channelIdSchema, channelMessageInputSchema, type ChannelInbox, type ChannelMessage, type ChannelStatus } from '../shared/protocol.js';
import { readConfig, updateConfig, type BridgeConfig, type ChannelSessionConfig } from './config.js';
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
// An expired session or ended round is rejoined under the same chat identity.
const rejoinCodes = new Set(['channel_session_expired', 'stale_generation']);
// Network failures, relay restarts and pairing churn pass; authentication and identity errors do not.
function transientFailure(error: unknown): boolean {
  if (error instanceof BridgeError) return error.status >= 500 || error.status === 429 || error.code === 'channel_pairing_changed';
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || (error instanceof TypeError && error.message === 'fetch failed'));
}
const pause = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function rejoin(client: RelayClient, config: BridgeConfig, session: LocalChannelSession): Promise<LocalChannelSession & { generation: string }> {
  await joinChannel(client, config, session.channel, session.session_id, 0);
  return requireChannelSession(await readConfig(), session.channel, session.session_id);
}
export interface WatchResult extends ChannelInbox { channel: string; session_id: string; timed_out: boolean }
export async function watchChannel(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, timeoutSeconds = 0): Promise<WatchResult> {
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  let session = requireChannelSession(config, channel, sessionId);
  let page: ChannelInbox | undefined; let needsRejoin = false; let failures = 0;
  let legacyInbox = false;
  while (Date.now() < deadline) {
    try {
      if (needsRejoin) { session = await rejoin(client, config, session); needsRejoin = false; }
      // Current relays include the connection snapshot in the inbox poll, avoiding
      // a separate status request before every receive. Older relays keep working.
      if (legacyInbox) {
        const status = await client.channelStatus(session.channel, session.session_id, session.generation, 0);
        if (status.peer && status.status !== 'connected') await confirmStatus(client, status);
      }
      page = await client.channelInbox(session.channel, session.session_id, session.generation, undefined, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)), !legacyInbox);
      if (!legacyInbox && !page.connection) {
        legacyInbox = true;
        if (!page.messages.length) continue;
      }
      if (page.connection?.peer && page.connection.status !== 'connected') await confirmStatus(client, page.connection);
      failures = 0;
      if (page.messages.length) return { ...page, channel: session.channel, session_id: session.session_id, timed_out: false };
    } catch (error) {
      if (!legacyInbox && error instanceof BridgeError && error.status === 400 && error.code === 'invalid_input') { legacyInbox = true; continue; }
      if (error instanceof BridgeError && rejoinCodes.has(error.code)) { needsRejoin = true; continue; }
      if (!transientFailure(error)) throw error;
      failures++; await pause(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
  return { messages: [], cursor: page?.cursor ?? 0, acknowledged_cursor: page?.acknowledged_cursor ?? 0, channel: session.channel, session_id: session.session_id, timed_out: true };
}
export async function sendChannelMessage(client: RelayClient, config: BridgeConfig, channel: string, sessionId: string | undefined, text: string, fileIds: string[], idempotencyKey = randomUUID()): Promise<ChannelMessage> {
  let session = requireChannelSession(config, channel, sessionId);
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt++) {
    const input = channelMessageInputSchema.parse({ session_id: session.session_id, generation: session.generation, text, file_ids: fileIds });
    try { return await client.sendChannel(session.channel, input, idempotencyKey); }
    catch (error) {
      if (!(error instanceof BridgeError) || attempt >= 5 || Date.now() >= deadline) throw error;
      if (rejoinCodes.has(error.code)) session = await rejoin(client, config, session);
      else if (error.code !== 'channel_not_connected') throw error;
      // The peer's watcher confirms a reset pairing within one poll; wait for it rather than failing.
      await channelStatus(client, await readConfig(), session.channel, session.session_id, 25);
    }
  }
}
export function channelResult(status: ChannelStatus): ChannelStatus & { confirmation: string } {
  return { ...status, confirmation: status.status === 'connected' ? `Connected on channel ${status.channel}. Secret word is ${status.secret_word}.` : `Waiting for peer on channel ${status.channel}.` };
}
