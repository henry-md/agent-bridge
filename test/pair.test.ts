import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pairChannel } from '../src/client/channel.js';
import { readConfig, writeConfig } from '../src/client/config.js';
import { RelayClient } from '../src/client/relay.js';
import { BridgeError, type ChannelMessage, type ChannelStatus } from '../src/shared/protocol.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-pair-fault-')); const previous = process.env.BRIDGE_CONFIG;
  process.env.BRIDGE_CONFIG = join(directory, 'config.json');
  t.after(async () => { if (previous === undefined) delete process.env.BRIDGE_CONFIG; else process.env.BRIDGE_CONFIG = previous; await rm(directory, { recursive: true, force: true }); });
  await writeConfig({ url: 'http://127.0.0.1:1', token: 'token', device: 'laptop', roots: {} });
  const session = randomUUID(); const peer = randomUUID(); const generation = randomUUID();
  const status: ChannelStatus = { channel: '4040', generation, pairing_id: randomUUID(), session_id: session, secret_word: 'amber-river', status: 'connected', peer: { device: 'vm', session_id: peer }, lease_expires_at: new Date(Date.now() + 90_000).toISOString() };
  const message = (seq: number, text: string): ChannelMessage => ({ id: randomUUID(), seq, channel: '4040', generation, from: 'vm', from_session: peer, to: 'laptop', to_session: session, text, file_ids: [], created_at: new Date().toISOString() });
  return { config: await readConfig(), session, peer, generation, status, message };
}

test('pair retains fresh proof across a failed final status check and retries an unchanged pairing with the same key', async t => {
  const f = await fixture(t); let sends = 0; let reads = 0; let acked = 0; let verificationFailed = false; const keys: string[] = [];
  const client = {
    joinChannel: async () => f.status,
    channelStatus: async () => {
      if (acked && !verificationFailed) { verificationFailed = true; throw new BridgeError(503, 'server_closing', 'Restart'); }
      return f.status;
    },
    sendChannel: async (_channel: string, _input: unknown, key: string) => {
      keys.push(key); sends++;
      if (sends === 1) throw new BridgeError(409, 'channel_not_connected', 'Pairing reset before send');
      return { ...f.message(10, 'probe'), to_session: f.peer };
    },
    channelInbox: async () => {
      reads++; assert.equal(reads, 1, 'Consumed fresh proof must not require a second inbox message');
      return { messages: [f.message(11, 'agent-bridge setup ack: amber-river')], cursor: 11, acknowledged_cursor: 0, connection: f.status };
    },
    acknowledgeChannel: async (_channel: string, _session: string, _generation: string, cursor: number) => { acked = cursor; return { acknowledged_cursor: cursor }; },
  } as unknown as RelayClient;
  const result = await pairChannel(client, f.config, '4040', f.session, 5);
  assert.equal(result.verified, true); assert.equal(result.acknowledged_cursor, 11); assert.equal(verificationFailed, true);
  assert.equal(sends, 2); assert.equal(keys[0], keys[1]);
});

test('pair cancellation preserves all ordinary records and their usable cursor when a setup reply stalls', async t => {
  const f = await fixture(t); const controller = new AbortController(); let replying!: () => void;
  const replyStarted = new Promise<void>(resolve => { replying = resolve; }); let sends = 0; let acks = 0;
  const ordinary = f.message(12, 'first ordinary record'); const trailing = f.message(14, 'last ordinary record');
  const client = {
    joinChannel: async () => f.status,
    sendChannel: async (_channel: string, _input: unknown, _key: string, signal: AbortSignal) => {
      sends++; if (sends === 1) return { ...f.message(10, 'probe'), to_session: f.peer };
      replying(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    channelInbox: async () => ({ messages: [ordinary, f.message(13, 'agent-bridge setup: amber-river'), trailing], cursor: 14, acknowledged_cursor: 0, connection: f.status }),
    acknowledgeChannel: async () => { acks++; throw new Error('Cannot acknowledge beyond ordinary mail'); },
  } as unknown as RelayClient;
  const pending = pairChannel(client, f.config, '4040', f.session, 5, controller.signal);
  await replyStarted; controller.abort(); const result = await pending;
  assert.equal(result.verified, false); assert.equal(result.cancelled, true); assert.equal(result.timed_out, false);
  assert.deepEqual(result.messages, [ordinary, trailing]); assert.equal(result.cursor, 14); assert.equal(result.acknowledged_cursor, 0); assert.equal(acks, 0);
  assert.equal((await readConfig()).channel_sessions!['4040']!.sessions[f.session]!.generation, f.generation, 'Cancellation must keep this chat joined');
});

test('pair discards proof when the peer changes during final verification and confirms the replacement', async t => {
  const f = await fixture(t); const replacement: ChannelStatus = { ...f.status, pairing_id: randomUUID(), peer: { device: 'vm', session_id: randomUUID() } };
  let state = f.status; let reads = 0; let sends = 0; let acknowledged = 0; const keys: string[] = [];
  const client = {
    joinChannel: async () => f.status,
    sendChannel: async (_channel: string, _input: unknown, key: string) => { keys.push(key); sends++; return { ...f.message(sends === 1 ? 10 : 20, 'probe'), to_session: state.peer!.session_id }; },
    channelInbox: async () => {
      reads++; const seq = reads === 1 ? 11 : 21;
      return { messages: [{ ...f.message(seq, 'agent-bridge setup ack: amber-river'), from_session: state.peer!.session_id }], cursor: seq, acknowledged_cursor: acknowledged, connection: state };
    },
    acknowledgeChannel: async (_channel: string, _session: string, _generation: string, cursor: number) => { acknowledged = cursor; return { acknowledged_cursor: cursor }; },
    channelStatus: async () => { if (acknowledged === 11) state = replacement; return state; },
  } as unknown as RelayClient;
  const result = await pairChannel(client, f.config, '4040', f.session, 5);
  assert.equal(result.verified, true); assert.equal(result.connection!.peer!.session_id, replacement.peer!.session_id);
  assert.equal(reads, 2); assert.equal(sends, 2); assert.notEqual(keys[0], keys[1]);
});

test('pair scans multiple pages without acknowledging ordinary mail or repeatedly fetching its first page', async t => {
  const f = await fixture(t); const ordinary = Array.from({ length: 101 }, (_, index) => f.message(index + 2, `context ${index}`));
  let reads = 0; const acked: number[] = []; const after: (number | undefined)[] = [];
  const client = {
    joinChannel: async () => f.status,
    channelStatus: async () => f.status,
    sendChannel: async () => ({ ...f.message(200, 'probe'), to_session: f.peer }),
    channelInbox: async (_channel: string, _session: string, _generation: string, cursor?: number) => {
      after.push(cursor); reads++;
      const messages = reads === 1 ? [f.message(1, 'agent-bridge setup ack: amber-river'), ...ordinary.slice(0, 99)] : [...ordinary.slice(99), f.message(201, 'agent-bridge setup ack: amber-river')];
      assert.ok(reads <= 2, 'Private scan cursor must advance past an unacknowledged page');
      return { messages, cursor: messages.at(-1)!.seq, acknowledged_cursor: reads === 1 ? 0 : 1, connection: f.status };
    },
    acknowledgeChannel: async (_channel: string, _session: string, _generation: string, cursor: number) => { acked.push(cursor); return { acknowledged_cursor: cursor }; },
  } as unknown as RelayClient;
  const result = await pairChannel(client, f.config, '4040', f.session, 5);
  assert.equal(result.verified, true); assert.deepEqual(result.messages, ordinary); assert.equal(result.cursor, 201);
  assert.deepEqual(acked, [1]); assert.deepEqual(after, [undefined, 100]);
});
