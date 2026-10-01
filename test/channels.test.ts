import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type ServerOptions } from '../src/server/server.js';
import type { ChannelMessage, ChannelStatus } from '../src/shared/protocol.js';

const adminToken = 'channel-test-admin-token-at-least-32-characters';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function fixture(t: TestContext, settings: Partial<ServerOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-bridge-channels-'));
  const app = await createServer({ dataDir, adminToken, ...settings });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async (name: string) => {
    const response = await app.inject({ method: 'POST', url: '/v1/devices', headers: auth(adminToken), payload: { name } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().token as string;
  };
  const joinChannel = async (token: string, channel = '4040', session_id = randomUUID(), secret_word = 'amber-river-72ef') => {
    const response = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/join`, headers: auth(token), payload: { session_id, secret_word } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as ChannelStatus;
  };
  const query = (status: ChannelStatus) => `session_id=${status.session_id}&generation=${status.generation}`;
  const status = async (token: string, member: ChannelStatus) => {
    const response = await app.inject({ url: `/v1/channels/${member.channel}?${query(member)}`, headers: auth(token) });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as ChannelStatus;
  };
  const confirm = async (token: string, member: ChannelStatus) => {
    const current = await status(token, member);
    const response = await app.inject({ method: 'POST', url: `/v1/channels/${member.channel}/confirm`, headers: auth(token), payload: {
      session_id: member.session_id, generation: member.generation, pairing_id: current.pairing_id, secret_word: member.secret_word,
    } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as ChannelStatus;
  };
  const pair = async (first: string, second: string, channel = '4040') => {
    const a = await joinChannel(first, channel);
    const b = await joinChannel(second, channel, randomUUID(), 'different-proposal');
    assert.equal((await confirm(first, a)).status, 'waiting');
    assert.equal((await confirm(second, b)).status, 'connected');
    assert.equal((await status(first, a)).status, 'connected');
    return { a, b };
  };
  const send = async (token: string, member: ChannelStatus, text: string, key?: string) => app.inject({
    method: 'POST', url: `/v1/channels/${member.channel}/messages`, headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) },
    payload: { session_id: member.session_id, generation: member.generation, text, file_ids: [] },
  });
  const inbox = async (token: string, member: ChannelStatus, after?: number) => app.inject({
    url: `/v1/channels/${member.channel}/messages?${query(member)}${after === undefined ? '' : `&after=${after}`}`, headers: auth(token),
  });
  const ack = async (token: string, member: ChannelStatus, cursor: number) => app.inject({
    method: 'POST', url: `/v1/channels/${member.channel}/ack`, headers: auth(token), payload: { session_id: member.session_id, generation: member.generation, cursor },
  });
  const leave = async (token: string, member: ChannelStatus) => {
    const current = await app.inject({ url: `/v1/channels/${member.channel}?${query(member)}`, headers: auth(token) });
    const pairingId = current.statusCode === 200 ? current.json().pairing_id : member.pairing_id;
    return app.inject({
      method: 'DELETE', url: `/v1/channels/${member.channel}/sessions/${member.session_id}?generation=${member.generation}&pairing_id=${pairingId}`, headers: auth(token),
    });
  };
  return { app, dataDir, register, joinChannel, query, status, confirm, pair, send, inbox, ack, leave };
}

test('simultaneous joins choose one first word and require both current-peer confirmations', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const [a, b] = await Promise.all([
    f.joinChannel(first, '4040', randomUUID(), 'first-secret'),
    f.joinChannel(second, '4040', randomUUID(), 'second-secret'),
  ]);
  assert.equal(a.secret_word, b.secret_word);
  assert.ok(['first-secret', 'second-secret'].includes(a.secret_word));
  assert.equal(a.generation, b.generation);
  assert.equal(a.status, 'waiting');
  assert.equal(b.status, 'waiting');
  assert.equal((await f.send(first, a, 'premature')).statusCode, 409);
  const wrong = await f.app.inject({ method: 'POST', url: '/v1/channels/4040/confirm', headers: auth(second), payload: {
    session_id: b.session_id, generation: b.generation, pairing_id: b.pairing_id, secret_word: 'wrong-word',
  } });
  assert.equal(wrong.statusCode, 409);
  assert.equal((await f.confirm(first, a)).status, 'waiting');
  assert.equal((await f.status(second, b)).status, 'waiting');
  assert.equal((await f.confirm(second, b)).status, 'connected');
  assert.equal((await f.status(first, a)).status, 'connected');
  const retry = await f.joinChannel(first, '4040', a.session_id, 'ignored-proposal');
  assert.equal(retry.secret_word, a.secret_word);
  assert.equal(retry.generation, a.generation);
  assert.equal(retry.status, 'connected');
  assert.deepEqual(retry.peer, { device: 'second', session_id: b.session_id });
});

test('numeric channel IDs remain exact strings including zero and six-digit values', async t => {
  const f = await fixture(t);
  const token = await f.register('first');
  const rounds = await Promise.all(['0', '4040', '65536', '999999'].map(channel => f.joinChannel(token, channel)));
  assert.deepEqual(rounds.map(round => round.channel), ['0', '4040', '65536', '999999']);
  assert.equal(new Set(rounds.map(round => round.generation)).size, 4);
  for (const channel of ['00', '-1', '1.1', '1e3']) {
    assert.equal((await f.app.inject({ method: 'POST', url: `/v1/channels/${channel}/join`, headers: auth(token), payload: { session_id: randomUUID(), secret_word: 'word-one' } })).statusCode, 400);
  }
});

test('channel sessions enforce authentication, distinct devices, two members and generation ownership', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const outsider = await f.register('outsider');
  const { a, b } = await f.pair(first, second);
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/channels/4040/join', payload: { session_id: randomUUID(), secret_word: 'word-one' } })).statusCode, 401);
  const extra = (token: string, session_id = randomUUID()) => f.app.inject({ method: 'POST', url: '/v1/channels/4040/join', headers: auth(token), payload: { session_id, secret_word: 'word-one' } });
  assert.equal((await extra(first)).json().error.code, 'device_already_joined');
  assert.equal((await extra(outsider)).json().error.code, 'channel_full');
  assert.equal((await extra(outsider, a.session_id)).statusCode, 403);
  for (const token of [second, outsider]) {
    assert.equal((await f.app.inject({ url: `/v1/channels/4040?${f.query(a)}`, headers: auth(token) })).statusCode, 403);
    assert.equal((await f.inbox(token, a)).statusCode, 403);
    assert.equal((await f.send(token, a, 'intrusion')).statusCode, 403);
    assert.equal((await f.ack(token, a, 0)).statusCode, 403);
    assert.equal((await f.leave(token, a)).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/channels/4040/confirm', headers: auth(token), payload: {
      session_id: a.session_id, generation: a.generation, pairing_id: a.pairing_id, secret_word: a.secret_word,
    } })).statusCode, 403);
  }
  const stale = { ...a, generation: randomUUID() };
  assert.equal((await f.inbox(first, stale)).statusCode, 409);
  assert.equal((await f.send(first, stale, 'stale')).statusCode, 409);
  assert.equal((await f.ack(first, stale, 0)).statusCode, 409);
  assert.equal((await f.leave(first, stale)).statusCode, 409);
  assert.equal((await f.app.inject({ url: `/v1/channels/4040?session_id=invalid&generation=${b.generation}`, headers: auth(first) })).statusCode, 400);
});

test('two channels isolate delivery, duplicate retries, durable acknowledgments and explicit replay', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const left = await f.pair(first, second, '4040');
  const right = await f.pair(first, second, '5050');
  const sent = await f.send(first, left.a, 'left-channel', 'same-key');
  assert.equal(sent.statusCode, 200, sent.body);
  const message = sent.json().message as ChannelMessage;
  assert.equal((await f.send(first, left.a, 'left-channel', 'same-key')).json().message.id, message.id);
  assert.equal((await f.send(first, left.a, 'changed', 'same-key')).statusCode, 409);
  const other = await f.send(first, right.a, 'right-channel', 'same-key');
  assert.equal(other.statusCode, 200, other.body);
  const backward = await f.send(second, left.b, 'reply');
  assert.equal(backward.statusCode, 200, backward.body);
  const received = (await f.inbox(second, left.b)).json();
  assert.deepEqual(received.messages.map((item: ChannelMessage) => item.text), ['left-channel']);
  assert.equal(received.acknowledged_cursor, 0);
  assert.equal((await f.inbox(second, left.b)).json().messages.length, 1, 'reading never acknowledges delivery');
  assert.equal((await f.inbox(second, right.b)).json().messages[0].text, 'right-channel');
  assert.equal((await f.inbox(first, left.a)).json().messages[0].text, 'reply');
  assert.equal((await f.ack(second, left.b, other.json().message.seq)).statusCode, 400, 'another channel cursor is not acknowledged');
  assert.equal((await f.ack(first, left.a, message.seq)).statusCode, 400, 'sent messages are outside own mailbox');
  assert.equal((await f.ack(second, left.b, received.cursor)).json().acknowledged_cursor, received.cursor);
  assert.deepEqual((await f.inbox(second, left.b)).json(), { messages: [], cursor: received.cursor, acknowledged_cursor: received.cursor });
  assert.equal((await f.inbox(second, left.b, 0)).json().messages[0].id, message.id);
  assert.equal((await f.ack(second, left.b, 0)).json().acknowledged_cursor, received.cursor, 'acks never move backwards');
  assert.equal((await f.inbox(second, right.b)).json().acknowledged_cursor, 0);
  assert.equal((await f.inbox(first, left.a)).json().acknowledged_cursor, 0);
  assert.equal((await f.app.inject({ url: '/v1/messages', headers: auth(second) })).json().messages.length, 0, 'legacy inbox is independent');
});

test('lease expiry and leave remove connected state, require new acknowledgment and reset dead round words', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, { channelLeaseMs: 1000 });
  const first = await f.register('first');
  const second = await f.register('second');
  const third = await f.register('third');
  const { a, b } = await f.pair(first, second);
  t.mock.timers.tick(600);
  await f.status(first, a);
  t.mock.timers.tick(500);
  const alone = await f.status(first, a);
  assert.equal(alone.status, 'waiting');
  assert.equal(alone.peer, null);
  assert.equal((await f.send(first, a, 'offline')).statusCode, 409);
  assert.equal((await f.inbox(second, b)).json().error.code, 'channel_session_expired');
  const returned = await f.joinChannel(second, b.channel, b.session_id, 'new-proposal');
  assert.equal(returned.secret_word, a.secret_word);
  assert.equal(returned.status, 'waiting');
  assert.equal((await f.confirm(second, returned)).status, 'waiting');
  assert.equal((await f.confirm(first, a)).status, 'connected');
  assert.equal((await f.leave(second, returned)).statusCode, 204);
  assert.equal((await f.leave(second, returned)).statusCode, 204, 'leave is idempotent');
  assert.equal((await f.status(first, a)).status, 'waiting');
  const replacement = await f.joinChannel(third);
  assert.equal((await f.confirm(third, replacement)).status, 'waiting');
  assert.equal((await f.confirm(first, a)).status, 'connected');
  assert.equal((await f.inbox(second, returned)).statusCode, 409, 'left session cannot retrieve later delivery');
  t.mock.timers.tick(1001);
  const fresh = await f.joinChannel(second, '4040', randomUUID(), 'fresh-round-word');
  assert.notEqual(fresh.generation, a.generation);
  assert.equal(fresh.secret_word, 'fresh-round-word');
  assert.equal(fresh.peer, null);
  assert.equal(fresh.status, 'waiting');
  assert.equal((await f.inbox(first, a)).json().error.code, 'stale_generation');
  const newFirst = await f.joinChannel(first, '4040', randomUUID(), a.secret_word);
  assert.equal(newFirst.secret_word, 'fresh-round-word');
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/channels/4040/confirm', headers: auth(first), payload: {
    session_id: newFirst.session_id, generation: newFirst.generation, pairing_id: newFirst.pairing_id, secret_word: a.secret_word,
  } })).json().error.code, 'secret_mismatch');
});

test('long polls wake for a real peer and messages, and renew the polling member lease', async t => {
  // SQLite commits can take longer than this short lease on Windows. Advance
  // only lease time; the server's polling timers still run on the real clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, { channelLeaseMs: 120 });
  const first = await f.register('first');
  const second = await f.register('second');
  const a = await f.joinChannel(first);
  const inspect = new DatabaseSync(join(f.dataDir, 'bridge.sqlite'), { readOnly: true });
  const renewedAfter = async (previous: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const member = inspect.prepare('SELECT lease_until FROM channel_members WHERE generation = ? AND session_id = ?')
        .get(a.generation, a.session_id) as { lease_until: number };
      if (member.lease_until > previous) return member.lease_until;
      await delay(10);
    }
    assert.fail('The pending status poll did not renew its session lease');
  };
  try {
    let settled = false;
    const peerPoll = f.app.inject({ url: `/v1/channels/4040?${f.query(a)}&wait=1`, headers: auth(first) })
      .then(response => { settled = true; return response; });
    const originalExpiry = Date.parse(a.lease_expires_at);
    t.mock.timers.tick(80);
    const firstRenewal = await renewedAfter(originalExpiry);
    t.mock.timers.tick(80);
    await renewedAfter(firstRenewal);
    assert.ok(Date.now() > originalExpiry, 'renewal is proven beyond the original lease expiry');
    assert.equal(settled, false, 'the lease was renewed while the poll remained pending');
    const b = await f.joinChannel(second);
    const seen = await peerPoll;
    assert.equal(seen.statusCode, 200, seen.body);
    assert.equal(seen.json().generation, a.generation, 'long poll keeps its session alive');
    assert.deepEqual(seen.json().peer, { device: 'second', session_id: b.session_id });
    await f.confirm(first, a);
    await f.confirm(second, b);
    const pending = f.app.inject({ url: `/v1/channels/4040/messages?${f.query(b)}&wait=1`, headers: auth(second) });
    await delay(30);
    assert.equal((await f.send(first, a, 'wake-up')).statusCode, 200);
    assert.equal((await pending).json().messages[0].text, 'wake-up');
  } finally { inspect.close(); }
});

test('a status poll waits with the same unconfirmed peer and wakes on mutual confirmation', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const a = await f.joinChannel(first);
  const b = await f.joinChannel(second);
  assert.equal((await f.confirm(first, a)).status, 'waiting');
  let settled = false;
  const pending = f.app.inject({ url: `/v1/channels/4040?${f.query(a)}&wait=1`, headers: auth(first) })
    .then(response => { settled = true; return response; });
  await delay(20);
  assert.equal(settled, false, 'an unchanged peer does not spin a caller that already confirmed');
  assert.equal((await f.confirm(first, a)).status, 'waiting');
  await delay(20);
  assert.equal(settled, false, 'one confirmation is insufficient');
  assert.equal((await f.confirm(second, b)).status, 'connected');
  const connected = await pending;
  assert.equal(connected.statusCode, 200, connected.body);
  assert.equal(connected.json().status, 'connected');
});

test('a peer arriving before status polling returns immediately for the callers new acknowledgment', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const a = await f.joinChannel(first);
  assert.equal((await f.confirm(first, a)).status, 'waiting');
  const b = await f.joinChannel(second);
  let settled = false;
  const pending = f.app.inject({ url: `/v1/channels/4040?${f.query(a)}&wait=1`, headers: auth(first) })
    .then(response => { settled = true; return response; });
  await delay(20);
  assert.equal(settled, true, 'the caller learns the already-arrived peer without waiting for an impossible handshake');
  const current = (await pending).json() as ChannelStatus;
  assert.equal(current.status, 'waiting');
  assert.equal(current.pairing_id, b.pairing_id);
  assert.equal((await f.confirm(first, current)).status, 'waiting');
  assert.equal((await f.confirm(second, b)).status, 'connected');
});

test('delayed confirmations are fenced across peer replacement and same-session rejoining', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const third = await f.register('third');
  const { a, b } = await f.pair(first, second);
  const old = await f.status(first, a);
  const replay = () => f.app.inject({ method: 'POST', url: '/v1/channels/4040/confirm', headers: auth(first), payload: {
    session_id: old.session_id, generation: old.generation, pairing_id: old.pairing_id, secret_word: old.secret_word,
  } });
  await f.leave(second, b);
  const replacement = await f.joinChannel(third);
  assert.notEqual(replacement.pairing_id, old.pairing_id);
  assert.equal((await f.confirm(third, replacement)).status, 'waiting');
  assert.equal((await replay()).json().error.code, 'channel_pairing_changed');
  assert.equal((await f.status(first, a)).status, 'waiting');
  assert.equal((await f.confirm(first, a)).status, 'connected');
  const pairedRevision = (await f.status(first, a)).pairing_id;
  assert.equal((await f.leave(second, b)).statusCode, 204);
  assert.equal((await f.status(first, a)).status, 'connected', 'a repeated old leave cannot reset the new pair');
  assert.equal((await f.status(first, a)).pairing_id, pairedRevision);
  await f.leave(third, replacement);
  const returned = await f.joinChannel(second, b.channel, b.session_id);
  assert.equal((await f.confirm(second, returned)).status, 'waiting');
  assert.equal((await replay()).json().error.code, 'channel_pairing_changed', 'same peer UUID still requires a fresh acknowledgment');
  assert.equal((await f.confirm(first, a)).status, 'connected');
  const lateLeave = await f.app.inject({ method: 'DELETE', url: `/v1/channels/4040/sessions/${b.session_id}?generation=${b.generation}&pairing_id=${old.pairing_id}`, headers: auth(second) });
  assert.equal(lateLeave.json().error.code, 'channel_pairing_changed', 'a delayed leave cannot remove the same UUID after it rejoins');
  assert.equal((await f.status(first, a)).status, 'connected');
  const current = await f.status(first, a);
  const retry = await f.joinChannel(first, a.channel, a.session_id);
  assert.equal(retry.pairing_id, current.pairing_id, 'renewing an active join preserves the pairing revision');
});

test('revocation immediately removes the peer and terminates revoked authenticated polls', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const { a, b } = await f.pair(first, second);
  const pending = f.app.inject({ url: `/v1/channels/4040/messages?${f.query(b)}&wait=25`, headers: auth(second) });
  await delay(20);
  assert.equal((await f.app.inject({ method: 'DELETE', url: '/v1/devices/second', headers: auth(adminToken) })).statusCode, 204);
  assert.equal((await pending).statusCode, 401);
  assert.equal((await f.status(first, a)).peer, null);
  assert.equal((await f.status(first, a)).status, 'waiting');
  assert.equal((await f.send(first, a, 'revoked')).statusCode, 409);
  const renewedToken = await f.register('second');
  const renewed = await f.joinChannel(renewedToken, '4040', b.session_id);
  assert.equal(renewed.status, 'waiting');
  assert.equal((await f.confirm(renewedToken, renewed)).status, 'waiting');
  assert.equal((await f.confirm(first, a)).status, 'connected');
  assert.equal((await f.inbox(second, b)).statusCode, 401);
});

test('round, current pairing, queued messages and per-session acknowledgments survive restart', async t => {
  const f = await fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const { a, b } = await f.pair(first, second);
  const acknowledged = await f.send(first, a, 'acknowledged');
  await f.ack(second, b, acknowledged.json().message.seq);
  const unread = await f.send(first, a, 'unread', 'restart-retry');
  await f.app.inject({ method: 'POST', url: '/v1/messages', headers: auth(first), payload: { to: 'second', text: 'legacy persists' } });
  await f.app.close();
  const restarted = await createServer({ dataDir: f.dataDir, adminToken });
  try {
    const current = await restarted.inject({ url: `/v1/channels/4040?${f.query(a)}`, headers: auth(first) });
    assert.equal(current.json().status, 'connected');
    assert.equal(current.json().secret_word, a.secret_word);
    const inbox = await restarted.inject({ url: `/v1/channels/4040/messages?${f.query(b)}`, headers: auth(second) });
    assert.deepEqual(inbox.json().messages.map((item: ChannelMessage) => item.text), ['unread']);
    assert.equal(inbox.json().acknowledged_cursor, acknowledged.json().message.seq);
    const replay = await restarted.inject({ url: `/v1/channels/4040/messages?${f.query(b)}&after=0`, headers: auth(second) });
    assert.equal(replay.json().messages.length, 2);
    const retry = await restarted.inject({ method: 'POST', url: '/v1/channels/4040/messages', headers: { ...auth(first), 'idempotency-key': 'restart-retry' }, payload: {
      session_id: a.session_id, generation: a.generation, text: 'unread', file_ids: [],
    } });
    assert.equal(retry.json().message.id, unread.json().message.id);
    assert.equal((await restarted.inject({ url: '/v1/messages', headers: auth(second) })).json().messages[0].text, 'legacy persists');
  } finally { await restarted.close(); }
});

test('adding channel tables preserves credentials and messages from a pre-channel v1 database', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-bridge-v1-migration-'));
  const token = 'existing-v1-device-token';
  const id = randomUUID();
  const legacy = new DatabaseSync(join(dataDir, 'bridge.sqlite'));
  legacy.exec(`
    CREATE TABLE devices (
      name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      roots TEXT NOT NULL DEFAULT '[]', last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      from_name TEXT NOT NULL, to_name TEXT NOT NULL, text TEXT NOT NULL,
      file_ids TEXT NOT NULL, created_at INTEGER NOT NULL, idem_key TEXT, payload_hash TEXT,
      UNIQUE (from_name, idem_key)
    );
  `);
  legacy.prepare('INSERT INTO devices (name, token_hash) VALUES (?, ?)').run('original', createHash('sha256').update(token).digest('hex'));
  legacy.prepare('INSERT INTO messages (id, from_name, to_name, text, file_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'sender', 'original', 'existing durable message', '[]', Date.now());
  legacy.close();
  const app = await createServer({ dataDir, adminToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const inbox = await app.inject({ url: '/v1/messages', headers: auth(token) });
  assert.equal(inbox.statusCode, 200, inbox.body);
  assert.equal(inbox.json().messages[0].id, id);
  assert.equal(inbox.json().messages[0].text, 'existing durable message');
  const joined = await app.inject({ method: 'POST', url: '/v1/channels/4040/join', headers: auth(token), payload: { session_id: randomUUID(), secret_word: 'migration-word' } });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().secret_word, 'migration-word');
  assert.equal(joined.json().status, 'waiting');
});
