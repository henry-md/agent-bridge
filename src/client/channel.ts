import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
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
async function confirmStatus(client: RelayClient, initial: ChannelStatus, signal?: AbortSignal): Promise<ChannelStatus> {
  let status = initial;
  for (let attempt = 0; ; attempt++) {
    try { return await client.confirmChannel(status.channel, status.session_id, status.generation, status.secret_word, status.pairing_id, signal); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'channel_pairing_changed' || attempt >= 2) throw error;
      status = await client.channelStatus(status.channel, status.session_id, status.generation, 0, signal);
    }
  }
}
export async function joinChannel(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, waitSeconds = 25, signal?: AbortSignal): Promise<ChannelStatus> {
  const session = await reserveSession(config, channel, sessionId);
  let status = await client.joinChannel(session.channel, session.session_id, session.secret_word, undefined, signal);
  await saveStatus(config, session, status);
  if (status.status !== 'connected') status = await confirmStatus(client, status, signal);
  const deadline = Date.now() + waitSeconds * 1000;
  while (status.status !== 'connected' && Date.now() < deadline) {
    status = await client.channelStatus(status.channel, status.session_id, status.generation, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)), signal);
    // Joining/replacing a peer resets both confirmations. Confirm the word again
    // after a poll so the original participant can complete the mutual handshake.
    status = await confirmStatus(client, status, signal);
  }
  return status;
}
export async function channelStatus(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, waitSeconds = 0, signal?: AbortSignal): Promise<ChannelStatus> {
  const session = requireChannelSession(config, channel, sessionId);
  let status = await client.channelStatus(session.channel, session.session_id, session.generation, waitSeconds, signal);
  if (status.status !== 'connected') status = await confirmStatus(client, status, signal);
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
  if (error instanceof BridgeError) return error.status >= 500 || error.status === 429 || error.code === 'channel_pairing_changed' || (error.status === 404 && error.code === 'HTTP_ERROR');
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || (error instanceof TypeError && error.message === 'fetch failed'));
}
async function rejoin(client: RelayClient, config: BridgeConfig, session: LocalChannelSession, signal?: AbortSignal): Promise<LocalChannelSession & { generation: string }> {
  await joinChannel(client, config, session.channel, session.session_id, 0, signal);
  return requireChannelSession(await readConfig(), session.channel, session.session_id);
}
export interface WatchResult extends ChannelInbox { channel: string; session_id: string; timed_out: boolean }
export const MAX_CHANNEL_TIMEOUT_SECONDS = 2_147_483;
export function validateChannelTimeout(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_CHANNEL_TIMEOUT_SECONDS) throw new BridgeError(0, 'INVALID_ARGUMENT', `Timeout must be between 0 and ${MAX_CHANNEL_TIMEOUT_SECONDS} seconds`);
  return seconds;
}
export async function watchChannel(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, timeoutSeconds = 0): Promise<WatchResult> {
  validateChannelTimeout(timeoutSeconds);
  let session = requireChannelSession(config, channel, sessionId);
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  const controller = new AbortController();
  const timer = timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;
  timer?.unref(); const signal = controller.signal;
  let page: ChannelInbox | undefined; let needsRejoin = false; let failures = 0;
  let legacyInbox = false;
  try { while (Date.now() < deadline && !signal.aborted) {
    try {
      if (needsRejoin) { session = await rejoin(client, config, session, signal); needsRejoin = false; }
      // Current relays include the connection snapshot in the inbox poll, avoiding
      // a separate status request before every receive. Older relays keep working.
      if (legacyInbox) {
        const status = await client.channelStatus(session.channel, session.session_id, session.generation, 0, signal);
        if (status.peer && status.status !== 'connected') await confirmStatus(client, status, signal);
      }
      page = await client.channelInbox(session.channel, session.session_id, session.generation, undefined, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)), !legacyInbox, signal);
      if (!legacyInbox && !page.connection) {
        legacyInbox = true;
        if (!page.messages.length) continue;
      }
      // Already authorized mail should reach the agent immediately. The next
      // empty watch (or send) reconfirms a replacement peer without delaying it.
      if (page.messages.length) return { ...page, channel: session.channel, session_id: session.session_id, timed_out: false };
      if (page.connection?.peer && page.connection.status !== 'connected') await confirmStatus(client, page.connection, signal);
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      if (!legacyInbox && error instanceof BridgeError && error.status === 400 && error.code === 'invalid_input') { legacyInbox = true; continue; }
      if (error instanceof BridgeError && rejoinCodes.has(error.code)) { needsRejoin = true; continue; }
      if (!transientFailure(error)) throw error;
      failures++;
      try { await pause(Math.min(2000, 100 * 2 ** Math.min(failures - 1, 5)) + Math.random() * 100, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  } } finally { clearTimeout(timer); }
  return { messages: [], cursor: page?.cursor ?? 0, acknowledged_cursor: page?.acknowledged_cursor ?? 0, channel: session.channel, session_id: session.session_id, timed_out: true };
}
export interface PairResult extends WatchResult {
  verified: boolean; cancelled: boolean; setup_ms: number; relay_connected_ms?: number; confirmation_ms?: number;
}
const setupControl = (message: ChannelMessage) => message.file_ids.length === 0 ? /^agent-bridge setup( ack)?: ([a-z0-9-]{3,80})$/.exec(message.text) : null;
const connectionIdentity = (status: ChannelStatus) => `${status.generation}/${status.pairing_id}/${status.peer?.session_id ?? ''}`;

// Pairing is one process, so the word exchange does not need intermediate model
// turns. Ordinary mail stays unacknowledged even if controls follow it in a page.
export async function pairChannel(client: RelayClient, config: BridgeConfig, channel: string, sessionId?: string, timeoutSeconds = 600, cancellation?: AbortSignal): Promise<PairResult> {
  validateChannelTimeout(timeoutSeconds); channelId(channel);
  const requestedSession = explicitSession(sessionId);
  const started = performance.now(); const controller = new AbortController();
  const timer = timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;
  timer?.unref(); const signal = cancellation ? AbortSignal.any([controller.signal, cancellation]) : controller.signal;
  let status: ChannelStatus | undefined; let session: LocalChannelSession & { generation: string } | undefined;
  let probe: { identity: string; key: string; seq?: number } | undefined;
  let proofIdentity: string | undefined;
  let scanCursor: number | undefined; let acknowledged = 0; let prefixCursor = 0; let blockedAck = false;
  let relayConnectedMs: number | undefined; let legacyInbox = false; let failures = 0;
  const messages = new Map<string, ChannelMessage>(); const replies = new Map<string, string>();
  const result = (verified: boolean): PairResult => ({
    messages: [...messages.values()], cursor: Math.max(scanCursor ?? acknowledged, ...[...messages.values()].filter(message => message.generation === session?.generation).map(message => message.seq)), acknowledged_cursor: acknowledged,
    channel, session_id: session?.session_id ?? status?.session_id ?? requestedSession ?? '', timed_out: !verified && !cancellation?.aborted, verified, cancelled: !!cancellation?.aborted,
    ...(status ? { connection: status } : {}), setup_ms: performance.now() - started,
    ...(relayConnectedMs === undefined ? {} : { relay_connected_ms: relayConnectedMs, confirmation_ms: performance.now() - started - relayConnectedMs }),
  });
  async function ensureProbe() {
    if (status!.status !== 'connected' || !status!.peer) { probe = undefined; proofIdentity = undefined; return; }
    relayConnectedMs ??= performance.now() - started;
    const identity = connectionIdentity(status!);
    if (probe?.identity !== identity) { probe = { identity, key: randomUUID() }; proofIdentity = undefined; }
    if (probe.seq !== undefined) return;
    const sent = await client.sendChannel(channel, { session_id: session!.session_id, generation: session!.generation, text: `agent-bridge setup: ${status!.secret_word}`, file_ids: [] }, probe.key, signal);
    if (sent.to_session !== status!.peer.session_id) throw new BridgeError(409, 'channel_pairing_changed', 'Peer changed while sending the setup probe');
    probe.seq = sent.seq;
  }
  try {
    while (!signal.aborted) {
      try {
        if (!session) {
          status = await joinChannel(client, config, channel, requestedSession, 0, signal);
          session = requireChannelSession(await readConfig(), channel, status.session_id);
        }
        if (!status) status = await client.channelStatus(channel, session.session_id, session.generation, 0, signal);
        if (proofIdentity) {
          status = await client.channelStatus(channel, session.session_id, session.generation, 0, signal);
          if (status.status === 'connected' && connectionIdentity(status) === proofIdentity) return result(true);
          proofIdentity = undefined;
        }
        if (status!.status !== 'connected') {
          status = await client.channelStatus(channel, session.session_id, session.generation, 25, signal);
          if (status.peer && status.status !== 'connected') status = await confirmStatus(client, status, signal);
          if (status.status !== 'connected') continue;
        }
        await ensureProbe();
        const page = await client.channelInbox(channel, session.session_id, session.generation, scanCursor, 25, !legacyInbox, signal);
        status = page.connection ?? await client.channelStatus(channel, session.session_id, session.generation, 0, signal);
        if (!page.connection) legacyInbox = true;
        if (status.peer && status.status !== 'connected') status = await confirmStatus(client, status, signal);
        await ensureProbe();
        acknowledged = page.acknowledged_cursor; prefixCursor = Math.max(prefixCursor, acknowledged);
        let proof = false;
        for (const message of page.messages) if (!setupControl(message)) messages.set(message.id, message);
        for (const message of page.messages) {
          const control = setupControl(message);
          if (!control) { blockedAck = true; messages.set(message.id, message); continue; }
          if (!blockedAck) prefixCursor = message.seq;
          const currentPeer = message.generation === status.generation && message.from_session === status.peer?.session_id;
          if (!currentPeer) continue;
          if (control[2] !== status.secret_word) throw new BridgeError(409, 'CHANNEL_WORD_MISMATCH', 'Peer setup word differs from this channel');
          if (!control[1]) {
            let key = replies.get(message.id); if (!key) { key = randomUUID(); replies.set(message.id, key); }
            const reply = await client.sendChannel(channel, { session_id: session.session_id, generation: session.generation, text: `agent-bridge setup ack: ${status.secret_word}`, file_ids: [] }, key, signal);
            if (reply.to_session !== status.peer?.session_id) throw new BridgeError(409, 'channel_pairing_changed', 'Peer changed while replying to setup');
          }
          if (probe?.seq !== undefined && message.seq > probe.seq) proof = true;
        }
        if (prefixCursor > acknowledged) acknowledged = (await client.acknowledgeChannel(channel, session.session_id, session.generation, prefixCursor, signal)).acknowledged_cursor;
        scanCursor = page.cursor; failures = 0;
        if (proof) {
          proofIdentity = probe!.identity;
          const verifiedStatus = await client.channelStatus(channel, session.session_id, session.generation, 0, signal);
          if (verifiedStatus.status === 'connected' && connectionIdentity(verifiedStatus) === probe?.identity) { status = verifiedStatus; return result(true); }
          status = verifiedStatus; probe = undefined; proofIdentity = undefined;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (!legacyInbox && error instanceof BridgeError && error.status === 400 && error.code === 'invalid_input') { legacyInbox = true; continue; }
        if (error instanceof BridgeError && rejoinCodes.has(error.code)) {
          session = undefined; status = undefined; probe = undefined; proofIdentity = undefined; scanCursor = undefined; acknowledged = 0; prefixCursor = 0; blockedAck = messages.size > 0; continue;
        }
        const reconnectPairing = error instanceof BridgeError && ['channel_pairing_changed', 'channel_not_connected'].includes(error.code);
        if (!transientFailure(error) && !reconnectPairing) throw error;
        if (reconnectPairing) status = undefined;
        failures++;
        try { await pause(Math.min(2000, 100 * 2 ** Math.min(failures - 1, 5)) + Math.random() * 100, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
    return result(false);
  } finally { clearTimeout(timer); }
}

export async function sendChannelMessage(client: RelayClient, config: BridgeConfig, channel: string, sessionId: string | undefined, text: string, fileIds: string[], idempotencyKey: string = randomUUID()): Promise<ChannelMessage> {
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
