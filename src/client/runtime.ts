import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { BridgeError, type ChannelInbox, type ChannelMessage, type ChannelStatus } from '../shared/protocol.js';
import { readConfig, type BridgeConfig } from './config.js';
import { channelId, joinChannel } from './channel.js';
import { RelayClient } from './relay.js';

const prefix = 'agent-bridge control v2: ';
const frameSchema = z.object({ version: z.literal(2), kind: z.enum(['probe', 'echo']), nonce: z.string().uuid(), generation: z.string().uuid(), pairing_id: z.string().uuid(), from_session: z.string().uuid(), to_session: z.string().uuid(), word: z.string().regex(/^[a-z0-9-]{3,80}$/) }).strict();
type Frame = z.infer<typeof frameSchema>;
const identity = (status: ChannelStatus) => `${status.generation}/${status.pairing_id}/${status.peer?.session_id ?? ''}`;
interface Proof { message: ChannelMessage; connection: ChannelStatus; rtt: number }
interface Probe { nonce: string; signal: AbortSignal; identity?: string; seq?: number; started?: number; inFlight?: Promise<void>; candidate?: Proof; proof?: Proof }
export interface RuntimePairResult extends ChannelInbox {
  verified: boolean; timed_out: boolean; channel: string; session_id: string; proof_nonce?: string; proof_message_id?: string; proof_round_trip_ms?: number; runtime_setup_ms: number;
}

// One runtime owns one inbox reader. Setup is handled in JavaScript while
// ordinary records stay durable and unacknowledged until the agent processes them.
export class ChannelRuntime {
  private readonly controller = new AbortController();
  private readonly changes = new EventEmitter();
  private readonly ordinary = new Map<string, ChannelMessage>();
  private readonly probes = new Map<string, Probe>();
  private connection?: ChannelStatus;
  private cursor = 0;
  private acknowledged = 0;
  private acknowledgmentBlocked = false;
  private failure?: unknown;
  private transport: 'connecting' | 'online' | 'reconnecting' | 'stopped' = 'connecting';
  private verifiedAt?: string;
  private proofMs?: number;
  private closeReason = 'RUNTIME_RESTARTING';
  private readonly ready: Promise<void>;
  private readonly work: Promise<void>;
  constructor(readonly client: RelayClient, readonly config: BridgeConfig, readonly channel: string, readonly session: string) {
    channelId(channel); z.string().uuid().parse(session); this.changes.setMaxListeners(0);
    this.ready = this.initialize(); this.work = this.loop(); void this.work.catch(() => {});
  }
  private async initialize() {
    try {
      while (true) {
        try { this.connection = await joinChannel(this.client, this.config, this.channel, this.session, 0, this.controller.signal); return; }
        catch (error) { if (this.controller.signal.aborted || !this.retryable(error)) throw error; this.transport = 'reconnecting'; await pause(100, undefined, { signal: this.controller.signal }); }
      }
    }
    catch (error) { this.failure = error; this.transport = 'stopped'; this.changes.emit('change'); throw error; }
  }
  private retryable(error: unknown) { return error instanceof BridgeError ? error.status >= 500 || error.status === 429 && error.code !== 'RUNTIME_MAILBOX_FULL' : error instanceof TypeError || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name); }
  private async credentials() {
    const current = await readConfig();
    if (current.url !== this.config.url || current.token !== this.config.token || current.device !== this.config.device) throw new BridgeError(0, 'CONFIG_CHANGED', 'Relay credentials changed; restart the local runtime with the new configuration');
    const saved = current.channel_sessions?.[this.channel]?.sessions[this.session];
    if (saved?.generation !== this.connection?.generation) throw new BridgeError(0, 'SESSION_CHANGED', 'The local channel generation changed outside this runtime');
  }
  private check() {
    if (this.failure) throw this.failure;
    if (this.controller.signal.aborted) throw new BridgeError(409, this.closeReason, 'This runtime channel has stopped or was replaced');
  }
  private update(status: ChannelStatus) {
    if (status.channel !== this.channel || status.session_id !== this.session) throw new BridgeError(0, 'CHANNEL_IDENTITY_MISMATCH', 'Relay returned a different channel or session');
    if (this.connection && identity(this.connection) !== identity(status)) {
      this.verifiedAt = undefined;
      for (const probe of this.probes.values()) { probe.identity = undefined; probe.seq = undefined; probe.candidate = undefined; probe.proof = undefined; }
    }
    this.connection = status;
  }
  private control(message: ChannelMessage, status: ChannelStatus): Frame | 'legacy-probe' | 'legacy-ack' | undefined {
    if (!status.peer || status.status !== 'connected' || message.file_ids.length || message.channel !== this.channel || message.generation !== status.generation
      || message.from !== status.peer.device || message.from_session !== status.peer.session_id || message.to_session !== this.session) return;
    if (message.text === `agent-bridge setup: ${status.secret_word}`) return 'legacy-probe';
    if (message.text === `agent-bridge setup ack: ${status.secret_word}`) return 'legacy-ack';
    if (!message.text.startsWith(prefix)) return;
    let parsed; try { parsed = frameSchema.safeParse(JSON.parse(message.text.slice(prefix.length))); } catch { return; }
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.generation !== status.generation || frame.pairing_id !== status.pairing_id || frame.from_session !== status.peer.session_id || frame.to_session !== this.session || frame.word !== status.secret_word) return;
    return frame;
  }
  private async send(frame: Frame, key: string, signal = this.controller.signal) {
    await this.credentials();
    const sent = await this.client.sendChannel(this.channel, { session_id: this.session, generation: frame.generation, text: prefix + JSON.stringify(frame), file_ids: [] }, key, signal);
    if (sent.to_session !== frame.to_session) throw new BridgeError(409, 'channel_pairing_changed', 'Peer changed while sending the setup frame');
    return sent;
  }
  private complete(probe: Probe) {
    if (probe.signal.aborted) return;
    const candidate = probe.candidate;
    if (candidate && probe.seq !== undefined && candidate.message.seq > probe.seq && probe.identity === identity(candidate.connection) && probe.identity === identity(this.connection!)) {
      probe.proof = { ...candidate, rtt: performance.now() - probe.started! }; this.verifiedAt = new Date().toISOString(); this.proofMs = probe.proof.rtt; this.changes.emit('change');
    }
  }
  private async submit(probe: Probe) {
    if (probe.signal.aborted) return;
    if (probe.inFlight) return probe.inFlight;
    const status = this.connection!;
    if (status.status !== 'connected' || !status.peer) return;
    const tuple = identity(status);
    if (probe.identity === tuple && probe.seq !== undefined) return;
    probe.identity = tuple; probe.candidate = undefined; probe.proof = undefined; probe.started = performance.now();
    probe.inFlight = (async () => {
      const sent = await this.send({ version: 2, kind: 'probe', nonce: probe.nonce, generation: status.generation, pairing_id: status.pairing_id, from_session: this.session, to_session: status.peer!.session_id, word: status.secret_word }, `runtime-probe:${probe.nonce}:${status.pairing_id}`, probe.signal);
      await this.credentials();
      if (probe.identity === tuple) { probe.seq = sent.seq; this.complete(probe); }
    })();
    try { await probe.inFlight; } finally { probe.inFlight = undefined; }
  }
  private async loop() {
    try {
      await this.ready;
      while (!this.controller.signal.aborted) {
        try {
          await this.credentials();
          for (const probe of this.probes.values()) await this.submit(probe);
          const status = this.connection!;
          const page = await this.client.channelInbox(this.channel, this.session, status.generation, this.cursor || undefined, 25, true, this.controller.signal);
          await this.credentials();
          this.update(page.connection ?? await this.client.channelStatus(this.channel, this.session, status.generation, 0, this.controller.signal));
          this.transport = 'online'; this.acknowledged = Math.max(this.acknowledged, page.acknowledged_cursor);
          for (const [id, message] of this.ordinary) if (message.seq <= this.acknowledged) this.ordinary.delete(id);
          if (!this.ordinary.size) this.acknowledgmentBlocked = false;
          const snapshot = this.connection!;
          let prefixCursor = this.acknowledged;
          for (const message of page.messages) {
            if (message.seq <= this.acknowledged) continue;
            const frame = this.control(message, snapshot);
            if (!frame) {
              if (this.ordinary.size >= 1000 && !this.ordinary.has(message.id)) throw new BridgeError(429, 'RUNTIME_MAILBOX_FULL', 'Process the queued mailbox before restarting the runtime reader');
              this.ordinary.set(message.id, message); this.acknowledgmentBlocked = true; continue;
            }
            if (frame === 'legacy-probe') {
              await this.credentials();
              const reply = await this.client.sendChannel(this.channel, { session_id: this.session, generation: snapshot.generation, text: `agent-bridge setup ack: ${snapshot.secret_word}`, file_ids: [] }, `runtime-legacy:${message.id}`, this.controller.signal);
              if (reply.to_session !== snapshot.peer?.session_id) throw new BridgeError(409, 'channel_pairing_changed', 'Peer changed while replying to legacy setup');
            } else if (typeof frame !== 'string' && frame.kind === 'probe') {
              await this.send({ ...frame, kind: 'echo', from_session: this.session, to_session: frame.from_session }, `runtime-echo:${message.id}`);
            } else if (typeof frame !== 'string') {
              await this.credentials();
              const probe = this.probes.get(frame.nonce);
              if (probe && probe.identity === identity(snapshot)) { probe.candidate = { message, connection: snapshot, rtt: 0 }; this.complete(probe); }
            }
            if (!this.acknowledgmentBlocked) prefixCursor = message.seq;
          }
          this.cursor = Math.max(page.cursor, this.acknowledged);
          // Wake proof callers before the optional receipt commit. The nonce
          // frame itself is already in the durable authenticated mailbox.
          this.changes.emit('change');
          if (prefixCursor > this.acknowledged) {
            await this.credentials();
            const ack = await this.client.acknowledgeChannel(this.channel, this.session, snapshot.generation, prefixCursor, this.controller.signal);
            this.acknowledged = Math.max(this.acknowledged, ack.acknowledged_cursor);
          }
          if (snapshot.peer && snapshot.status !== 'connected') this.update(await this.client.confirmChannel(this.channel, this.session, snapshot.generation, snapshot.secret_word, snapshot.pairing_id, this.controller.signal));
          for (const probe of this.probes.values()) await this.submit(probe);
          this.changes.emit('change');
        } catch (error) {
          if (this.controller.signal.aborted) break;
          if (error instanceof BridgeError && ['channel_not_connected', 'channel_pairing_changed'].includes(error.code)) {
            try { this.update(await this.client.channelStatus(this.channel, this.session, this.connection!.generation, 0, this.controller.signal)); }
            catch (refresh) { if (!this.retryable(refresh)) throw refresh; this.transport = 'reconnecting'; await pause(100, undefined, { signal: this.controller.signal }); }
            continue;
          }
          if (error instanceof BridgeError && ['channel_session_expired', 'stale_generation'].includes(error.code)) {
            if (this.ordinary.size) throw new BridgeError(409, 'CHANNEL_GENERATION_CHANGED', 'Pending mail belongs to the expired generation; it remains unacknowledged in the relay');
            let renewed;
            try { renewed = await joinChannel(this.client, this.config, this.channel, this.session, 0, this.controller.signal); }
            catch (refresh) { if (!this.retryable(refresh)) throw refresh; this.transport = 'reconnecting'; await pause(100, undefined, { signal: this.controller.signal }); continue; }
            this.update(renewed);
            this.cursor = 0; this.acknowledged = 0; this.verifiedAt = undefined; continue;
          }
          if (!this.retryable(error)) throw error;
          this.transport = 'reconnecting'; this.verifiedAt = undefined; this.changes.emit('change');
          await pause(100, undefined, { signal: this.controller.signal });
        }
      }
    } catch (error) { if (!this.controller.signal.aborted) this.failure = error; }
    finally { this.transport = 'stopped'; this.verifiedAt = undefined; this.changes.emit('change'); }
  }
  private async changed(signal: AbortSignal) {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { this.changes.off('change', done); signal.removeEventListener('abort', done); resolve(); };
      this.changes.once('change', done); signal.addEventListener('abort', done, { once: true });
    });
  }
  private async until<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) { void work.catch(() => {}); return; }
    return new Promise<T | undefined>((resolve, reject) => {
      const clear = () => signal.removeEventListener('abort', aborted);
      const aborted = () => { clear(); resolve(undefined); };
      signal.addEventListener('abort', aborted, { once: true });
      work.then(value => { clear(); resolve(value); }, error => { clear(); reject(error); });
    });
  }
  async pair(timeoutMs: number, signal?: AbortSignal): Promise<RuntimePairResult> {
    const started = performance.now(), deadline = AbortSignal.timeout(timeoutMs), stop = signal ? AbortSignal.any([deadline, signal, this.controller.signal]) : AbortSignal.any([deadline, this.controller.signal]);
    const timedOut = (): RuntimePairResult => ({ messages: [], cursor: 0, acknowledged_cursor: 0, verified: false, timed_out: true, channel: this.channel, session_id: this.session, runtime_setup_ms: performance.now() - started });
    await this.until(this.ready, stop);
    if (stop.aborted) return timedOut();
    this.check();
    this.verifiedAt = undefined; this.changes.emit('change');
    const probe: Probe = { nonce: randomUUID(), signal: stop }; this.probes.set(probe.nonce, probe);
    try {
      try { await this.until(this.submit(probe), stop); }
      catch (error) { if (!this.retryable(error) && !(error instanceof BridgeError && ['channel_not_connected', 'channel_pairing_changed'].includes(error.code))) throw error; }
      while (!stop.aborted) {
        this.check();
        await this.credentials();
        this.check(); if (stop.aborted) break;
        if (probe.proof && this.transport === 'online' && identity(this.connection!) === probe.identity) {
          return { ...this.inbox(), verified: true, timed_out: false, channel: this.channel, session_id: this.session, connection: probe.proof.connection, proof_nonce: probe.nonce, proof_message_id: probe.proof.message.id, proof_round_trip_ms: probe.proof.rtt, runtime_setup_ms: performance.now() - started };
        }
        await this.changed(stop);
      }
      return timedOut();
    } finally { this.probes.delete(probe.nonce); }
  }
  inbox(): ChannelInbox {
    const messages = [...this.ordinary.values()].sort((a, b) => a.seq - b.seq).slice(0, 100);
    return { messages, cursor: this.ordinary.size > messages.length ? messages.at(-1)!.seq : this.cursor, acknowledged_cursor: this.acknowledged, ...(this.connection ? { connection: this.connection } : {}) };
  }
  async watch(timeoutMs: number, signal?: AbortSignal) {
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs), this.controller.signal]) : AbortSignal.any([AbortSignal.timeout(timeoutMs), this.controller.signal]);
    await this.until(this.ready, stop);
    while (!stop.aborted) { this.check(); await this.credentials(); this.check(); if (stop.aborted) break; const page = this.inbox(); if (page.messages.length) return { ...page, timed_out: false, channel: this.channel, session_id: this.session }; await this.changed(stop); }
    this.check(); return { messages: [], cursor: 0, acknowledged_cursor: 0, timed_out: true, channel: this.channel, session_id: this.session };
  }
  async acknowledge(cursor: number) {
    await this.ready; await this.credentials();
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.inbox().cursor) throw new BridgeError(400, 'INVALID_CURSOR', 'Cursor is beyond this runtime inbox');
    const ack = await this.client.acknowledgeChannel(this.channel, this.session, this.connection!.generation, cursor);
    this.acknowledged = Math.max(this.acknowledged, ack.acknowledged_cursor);
    for (const [id, message] of this.ordinary) if (message.seq <= this.acknowledged) this.ordinary.delete(id);
    if (!this.ordinary.size) this.acknowledgmentBlocked = false;
    this.changes.emit('change'); return ack;
  }
  status() { return { channel: this.channel, session_id: this.session, connection: this.connection, transport: this.transport, verified_at: this.verifiedAt ?? null, pending_messages: this.ordinary.size, proof_round_trip_ms: this.proofMs ?? null }; }
  onChange(listener: () => void) { this.changes.on('change', listener); return () => this.changes.off('change', listener); }
  async close(reason = 'RUNTIME_RESTARTING') { this.closeReason = reason; this.controller.abort(); this.changes.emit('change'); await this.work; }
}
