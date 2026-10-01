import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { RelayClient } from '../src/client/relay.js';
import { createServer } from '../src/server/server.js';

const run = promisify(execFile);
const adminToken = 'channel-cli-admin-token-at-least-32-bytes';
async function cli(configPath: string, args: string[], threadId = '', extraEnv: Record<string, string> = {}) {
  const result = await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd(), env: { ...process.env, CODEX_THREAD_ID: threadId, BRIDGE_CONFIG: configPath, ...extraEnv }, timeout: 15_000 });
  return JSON.parse(result.stdout);
}
async function harness(t: TestContext, overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-channel-cli-'));
  const app = await createServer({ dataDir: join(directory, 'data'), adminToken, logger: false, ...overrides });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const admin = new RelayClient(url, adminToken);
  async function device(name: string) {
    const registration = await admin.register(name); const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify({ url, token: registration.token, device: name, roots: {}, inbox_cursor: 99 }));
    return path;
  }
  return { directory, app, url, device };
}
async function pair(a: string, b: string, channel: string, aSession: string, bSession: string) {
  const first = cli(a, ['channel', 'join', channel, '--wait', '5'], aSession);
  await delay(100);
  const second = cli(b, ['channel', 'join', channel, '--wait', '5'], bSession);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status), ['connected', 'connected']);
  assert.equal(results[0].generation, results[1].generation);
  assert.equal(results[0].secret_word, results[1].secret_word);
  for (const result of results) assert.equal(result.confirmation, `Connected on channel ${channel}. Secret word is ${result.secret_word}.`);
  return results;
}

test('actual CLI joins use Codex chat identities and produce the same word only after mutual handshake', { timeout: 20_000 }, async t => {
  const h = await harness(t); const a = await h.device('laptop'); const b = await h.device('vm');
  const aSession = randomUUID(); const bSession = randomUUID();
  const waiting = await cli(a, ['channel', 'join', '4040', '--wait', '0'], aSession);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.peer, null); assert.equal(waiting.confirmation, 'Waiting for peer on channel 4040.');
  const joined = await pair(a, b, '4040', aSession, bSession);
  assert.equal(joined[0].session_id, aSession); assert.equal(joined[1].session_id, bSession);
  assert.equal(joined[0].peer.device, 'vm'); assert.equal(joined[1].peer.device, 'laptop');
  const resumed = await cli(a, ['channel', 'join', '4040', '--wait', '0'], aSession);
  assert.equal(resumed.status, 'connected'); assert.equal(resumed.generation, joined[0].generation); assert.equal(resumed.secret_word, joined[0].secret_word);
  const left = await cli(b, ['channel', 'leave', '4040'], bSession); assert.equal(left.left, true);
  const afterLeave = await cli(a, ['channel', 'status', '4040'], aSession); assert.equal(afterLeave.status, 'waiting'); assert.ok(!afterLeave.confirmation.includes('Connected'));
});

test('single-command pairing exchanges the word for simultaneous and staggered CLI participants', { timeout: 30_000 }, async t => {
  const h = await harness(t); const a = await h.device('laptop'); const b = await h.device('vm');
  for (const channel of ['4040', '5050']) {
    const aSession = randomUUID(); const bSession = randomUUID();
    const first = cli(a, ['channel', 'pair', channel, '--timeout', '8'], aSession);
    if (channel === '5050') await delay(150);
    const second = cli(b, ['channel', 'pair', channel, '--timeout', '8'], bSession);
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.equal(result.verified, true); assert.equal(result.timed_out, false); assert.equal(result.connection.status, 'connected');
      assert.ok(result.setup_ms >= result.relay_connected_ms); assert.ok(result.confirmation_ms >= 0); assert.deepEqual(result.messages, []);
    }
    assert.equal(results[0].connection.secret_word, results[1].connection.secret_word);
    assert.equal(results[0].connection.peer.session_id, bSession); assert.equal(results[1].connection.peer.session_id, aSession);
  }
});

test('pairing accepts a legacy setup acknowledgment and preserves queued ordinary mail across timeout', { timeout: 30_000 }, async t => {
  const h = await harness(t); const a = await h.device('laptop'); const b = await h.device('vm');
  const aSession = randomUUID(); const bSession = randomUUID();
  const [joined] = await pair(a, b, '4040', aSession, bSession);
  const word = joined.secret_word;
  const stale = await cli(b, ['send', '--channel', '4040', '--text', `agent-bridge setup ack: ${word}`], bSession);
  const ordinary = await cli(b, ['send', '--channel', '4040', '--text', 'preserve this ordinary context'], bSession);
  await cli(b, ['send', '--channel', '4040', '--text', `agent-bridge setup ack: ${word}`], bSession);
  const config = JSON.parse(await readFile(b, 'utf8')); const client = new RelayClient(config.url, config.token);
  const attachmentPath = join(h.directory, 'context.bin'); await writeFile(attachmentPath, 'attached context');
  const attachment = await client.upload(attachmentPath);
  const attached = await client.sendChannel('4040', { session_id: bSession, generation: joined.generation, text: `agent-bridge setup: ${word}`, file_ids: [attachment.id] });
  const timeout = await cli(a, ['channel', 'pair', '4040', '--timeout', '1'], aSession);
  assert.equal(timeout.verified, false, 'An old queued acknowledgment must not prove this invocation');
  assert.deepEqual(timeout.messages.map((message: { text: string }) => message.text), ['preserve this ordinary context', `agent-bridge setup: ${word}`]);
  assert.equal(timeout.acknowledged_cursor, stale.message.seq, 'Controls after ordinary mail must not advance its acknowledgment');
  assert.equal(timeout.cursor, attached.seq);
  const pending = await cli(a, ['inbox', '--channel', '4040', '--wait', '0'], aSession);
  assert.equal(pending.messages[0].id, ordinary.message.id); assert.equal(pending.messages.at(-1).id, attached.id);
  // Drain the timed-out invocation's probe before starting the next one.
  let probes = await cli(b, ['watch', '--channel', '4040', '--timeout', '5'], bSession);
  await cli(b, ['channel', 'ack', '4040', String(probes.cursor)], bSession);
  const next = cli(a, ['channel', 'pair', '4040', '--timeout', '8'], aSession);
  // Receive the new probe using the original skill's watch/send/ack workflow.
  probes = await cli(b, ['watch', '--channel', '4040', '--timeout', '5'], bSession);
  assert.ok(probes.messages.some((message: { text: string }) => message.text === `agent-bridge setup: ${word}`));
  await cli(b, ['send', '--channel', '4040', '--text', `agent-bridge setup ack: ${word}`], bSession);
  await cli(b, ['channel', 'ack', '4040', String(probes.cursor)], bSession);
  const confirmed = await next;
  assert.equal(confirmed.verified, true); assert.equal(confirmed.messages[0].id, ordinary.message.id);
  assert.equal((await cli(a, ['inbox', '--channel', '4040', '--wait', '0'], aSession)).messages[0].id, ordinary.message.id);
});

test('parallel chat channels merge configuration and keep messages and acknowledgments independent', { timeout: 30_000 }, async t => {
  const h = await harness(t); const a = await h.device('laptop'); const b = await h.device('vm');
  const a1 = randomUUID(); const b1 = randomUUID(); const a2 = randomUUID(); const b2 = randomUUID();
  await Promise.all([pair(a, b, '0', a1, b1), pair(a, b, '999999', a2, b2)]);
  const aConfig = JSON.parse(await readFile(a, 'utf8'));
  assert.ok(aConfig.channel_sessions['0'].sessions[a1]); assert.ok(aConfig.channel_sessions['999999'].sessions[a2]); assert.equal(aConfig.inbox_cursor, 99);
  await Promise.all([cli(a, ['send', '--channel', '0', '--text', 'first channel'], a1), cli(a, ['send', '--channel', '999999', '--text', 'second channel'], a2)]);
  const first = await cli(b, ['inbox', '--channel', '0', '--wait', '0'], b1);
  const second = await cli(b, ['inbox', '--channel', '999999', '--wait', '0'], b2);
  assert.deepEqual(first.messages.map((message: { text: string }) => message.text), ['first channel']);
  assert.deepEqual(second.messages.map((message: { text: string }) => message.text), ['second channel']);
  assert.equal((await cli(b, ['inbox', '--channel', '0', '--wait', '0'], b1)).messages[0].id, first.messages[0].id, 'Printing messages must not acknowledge them');
  await cli(b, ['channel', 'ack', '0', String(first.cursor)], b1);
  assert.deepEqual((await cli(b, ['inbox', '--channel', '0', '--wait', '0'], b1)).messages, []);
  assert.equal((await cli(b, ['inbox', '--channel', '999999', '--wait', '0'], b2)).messages[0].id, second.messages[0].id);
  assert.equal((await cli(b, ['inbox', '--channel', '0', '--after', '0', '--wait', '0'], b1)).messages[0].id, first.messages[0].id);
  assert.equal(JSON.parse(await readFile(b, 'utf8')).inbox_cursor, 99);
  await assert.rejects(cli(a, ['send', '--channel', '0', '--to', 'vm', '--text', 'invalid'], a1), (error: unknown) => (error as { stderr: string }).stderr.includes('mutually exclusive'));
});

test('non-Codex invocations save a durable fallback per channel and accept numeric strings beyond ports', { timeout: 20_000 }, async t => {
  const h = await harness(t); const a = await h.device('laptop');
  const initial = await cli(a, ['channel', 'join', '65536', '--wait', '0'], 'not-a-uuid');
  const resumed = await cli(a, ['channel', 'join', '65536', '--wait', '0']);
  assert.equal(initial.session_id, resumed.session_id); assert.equal(initial.generation, resumed.generation); assert.equal(initial.secret_word, resumed.secret_word);
  const other = await cli(a, ['channel', 'join', '999999', '--wait', '0']); assert.notEqual(other.session_id, initial.session_id);
  const explicit = randomUUID(); const explicitJoin = await cli(a, ['channel', 'join', '0', '--session', explicit, '--wait', '0'], randomUUID()); assert.equal(explicitJoin.session_id, explicit);
  await assert.rejects(cli(a, ['channel', 'join', '004040', '--wait', '0']), (error: unknown) => (error as { stderr: string }).stderr.includes('INVALID_CHANNEL'));
  await assert.rejects(cli(a, ['channel', 'join', '1', '--session', 'invalid', '--wait', '0']), (error: unknown) => (error as { stderr: string }).stderr.includes('INVALID_SESSION'));
});

test('repeating join renews an expired membership using the same saved chat identity', async t => {
  const h = await harness(t, { channelLeaseMs: 300 }); const a = await h.device('laptop');
  const first = await cli(a, ['channel', 'join', '4040', '--wait', '0']);
  await delay(400);
  const resumed = await cli(a, ['channel', 'join', '4040', '--wait', '0']);
  assert.equal(resumed.session_id, first.session_id); assert.notEqual(resumed.generation, first.generation); assert.notEqual(resumed.secret_word, first.secret_word); assert.equal(resumed.status, 'waiting');
  const config = JSON.parse(await readFile(a, 'utf8')); assert.equal(config.channel_sessions['4040'].sessions[first.session_id].generation, resumed.generation);
  await delay(400); assert.equal((await cli(a, ['channel', 'leave', '4040'])).left, true);
  assert.equal(JSON.parse(await readFile(a, 'utf8')).channel_sessions['4040'].sessions[first.session_id], undefined);
});

test('watch wakes on the next message, honours its timeout and stops after another chat takes over', { timeout: 90_000 }, async t => {
  const h = await harness(t); const a = await h.device('laptop'); const b = await h.device('vm');
  const aSession = randomUUID(); const bSession = randomUUID();
  await pair(a, b, '4040', aSession, bSession);
  const watching = cli(b, ['watch', '--channel', '4040'], bSession);
  await delay(500);
  await cli(a, ['send', '--channel', '4040', '--text', 'wake up'], aSession);
  const woke = await watching;
  assert.equal(woke.timed_out, false); assert.equal(woke.session_id, bSession);
  assert.deepEqual(woke.messages.map((message: { text: string }) => message.text), ['wake up']);
  await cli(b, ['channel', 'ack', '4040', String(woke.cursor)], bSession);
  const idle = await cli(b, ['watch', '--channel', '4040', '--timeout', '1'], bSession);
  assert.equal(idle.timed_out, true); assert.deepEqual(idle.messages, []);
  const newer = randomUUID();
  const takeover = await cli(b, ['channel', 'join', '4040', '--wait', '0'], newer);
  assert.equal(takeover.session_id, newer); assert.equal(takeover.peer.session_id, aSession);
  await assert.rejects(cli(b, ['watch', '--channel', '4040', '--timeout', '1'], bSession), (error: unknown) => (error as { stderr: string }).stderr.includes('channel_session_replaced'));
  const sent = await cli(a, ['send', '--channel', '4040', '--text', 'hello new chat'], aSession);
  assert.equal(sent.message.to_session, newer, 'send confirms the replacement pairing instead of failing');
  assert.equal((await cli(b, ['inbox', '--channel', '4040', '--wait', '0'], newer)).messages[0].text, 'hello new chat');
});

test('watch rejoins an expired session under the same chat identity', { timeout: 30_000 }, async t => {
  const h = await harness(t, { channelLeaseMs: 1500 }); const a = await h.device('laptop');
  const session = randomUUID();
  const first = await cli(a, ['channel', 'join', '4040', '--wait', '0'], session);
  await delay(2000);
  const idle = await cli(a, ['watch', '--channel', '4040', '--timeout', '3'], session);
  assert.equal(idle.timed_out, true); assert.equal(idle.session_id, session);
  const saved = JSON.parse(await readFile(a, 'utf8')).channel_sessions['4040'].sessions[session];
  assert.notEqual(saved.generation, first.generation, 'the expired round was replaced by a fresh join');
});

async function httpFixture(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = httpServer(handle); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test('watch receives current connection state and queued mail in one request without acknowledging', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-watch-state-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const session = randomUUID(); const generation = randomUUID(); const peer = randomUUID(); const requests: string[] = [];
  const connection = { channel: '4040', generation, pairing_id: randomUUID(), session_id: session, secret_word: 'amber-river', status: 'connected', peer: { device: 'vm', session_id: peer }, lease_expires_at: new Date(Date.now() + 90_000).toISOString() };
  const message = { id: randomUUID(), seq: 7, channel: '4040', generation, from: 'vm', from_session: peer, to: 'laptop', to_session: session, text: 'queued mail', file_ids: [], created_at: new Date().toISOString() };
  const url = await httpFixture(t, (req, res) => {
    requests.push(req.url!); const query = new URL(req.url!, 'http://localhost');
    assert.equal(query.pathname, '/v1/channels/4040/messages'); assert.equal(query.searchParams.get('state'), '1');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [message], cursor: 7, acknowledged_cursor: 0, connection }));
  });
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {}, channel_sessions: { '4040': { sessions: { [session]: { generation, secret_word: connection.secret_word } } } } }));
  const result = await cli(path, ['watch', '--channel', '4040', '--timeout', '5'], session);
  assert.deepEqual(result.messages, [message]); assert.equal(result.acknowledged_cursor, 0); assert.equal(requests.length, 1);
});

test('watch falls back to status plus inbox on older relays without losing queued mail', async t => {
  for (const rejection of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-watch-legacy-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const session = randomUUID(); const generation = randomUUID(); const requests: string[] = [];
    const connection = { channel: '4040', generation, pairing_id: randomUUID(), session_id: session, secret_word: 'amber-river', status: 'connected', peer: { device: 'vm', session_id: randomUUID() }, lease_expires_at: new Date(Date.now() + 90_000).toISOString() };
    const message = { id: randomUUID(), seq: 9, channel: '4040', generation, from: 'vm', from_session: connection.peer.session_id, to: 'laptop', to_session: session, text: 'legacy mail', file_ids: [], created_at: new Date().toISOString() };
    const url = await httpFixture(t, (req, res) => {
      const query = new URL(req.url!, 'http://localhost'); requests.push(query.pathname + (query.searchParams.has('state') ? '?state=1' : ''));
      const state = query.searchParams.has('state');
      if (state && rejection) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_input', message: 'Unknown query' } })); return; }
      const body = query.pathname.endsWith('/messages') ? { messages: [message], cursor: 9, acknowledged_cursor: 0 } : connection;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {}, channel_sessions: { '4040': { sessions: { [session]: { generation, secret_word: connection.secret_word } } } } }));
    const result = await cli(path, ['watch', '--channel', '4040', '--timeout', '5'], session);
    assert.deepEqual(result.messages, [message]); assert.equal(result.acknowledged_cursor, 0);
    assert.deepEqual(requests, rejection ? ['/v1/channels/4040/messages?state=1', '/v1/channels/4040', '/v1/channels/4040/messages'] : ['/v1/channels/4040/messages?state=1']);
  }
});

test('watch retries untyped deployment proxy errors but stops on authentication and typed missing-channel errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-watch-restart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const session = randomUUID(); const generation = randomUUID(); let requests = 0; let failure = 'proxy';
  const connection = { channel: '4040', generation, pairing_id: randomUUID(), session_id: session, secret_word: 'amber-river', status: 'connected', peer: { device: 'vm', session_id: randomUUID() }, lease_expires_at: new Date(Date.now() + 90_000).toISOString() };
  const url = await httpFixture(t, (_req, res) => {
    requests++;
    if (failure === 'proxy' && requests === 1) { res.writeHead(404).end('Deployment starting'); return; }
    if (failure !== 'proxy') { res.writeHead(failure === 'unauthorized' ? 401 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: failure, message: failure } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [{ text: 'survived redeploy' }], cursor: 7, acknowledged_cursor: 0, connection }));
  });
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {}, channel_sessions: { '4040': { sessions: { [session]: { generation, secret_word: connection.secret_word } } } } }));
  const result = await cli(path, ['watch', '--channel', '4040', '--timeout', '5'], session);
  assert.equal(result.messages[0].text, 'survived redeploy'); assert.equal(requests, 2);
  for (const code of ['unauthorized', 'channel_not_found']) {
    failure = code; requests = 0;
    await assert.rejects(cli(path, ['watch', '--channel', '4040', '--timeout', '5'], session), (error: unknown) => (error as { stderr: string }).stderr.includes(code));
    assert.equal(requests, 1, 'Authorization and typed application errors must not be retried');
  }
});

test('watch deadline cancels stalled HTTP requests and recovery backoff', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-watch-deadline-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const session = randomUUID(); const generation = randomUUID(); let mode = 'stall'; let requests = 0;
  const url = await httpFixture(t, (_req, res) => {
    requests++; if (mode === 'stall') return;
    res.writeHead(404).end('Deployment starting');
  });
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {}, channel_sessions: { '4040': { sessions: { [session]: { generation, secret_word: 'amber-river' } } } } }));
  for (const next of ['stall', 'proxy']) {
    mode = next; requests = 0;
    const result = await cli(path, ['watch', '--channel', '4040', '--timeout', '1'], session);
    assert.equal(result.timed_out, true); assert.deepEqual(result.messages, []); assert.ok(requests > 0);
  }
});

test('watch delivers received mail before a stalled reconfirmation and rejects overflowing timeouts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-watch-mail-deadline-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const session = randomUUID(); const generation = randomUUID(); let requests = 0;
  const connection = { channel: '4040', generation, pairing_id: randomUUID(), session_id: session, secret_word: 'amber-river', status: 'waiting', peer: { device: 'vm', session_id: randomUUID() }, lease_expires_at: new Date(Date.now() + 90_000).toISOString() };
  const url = await httpFixture(t, (req, res) => {
    requests++; if (req.url?.endsWith('/confirm')) return;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [{ text: 'keep this mail' }], cursor: 7, acknowledged_cursor: 0, connection }));
  });
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {}, channel_sessions: { '4040': { sessions: { [session]: { generation, secret_word: connection.secret_word } } } } }));
  const result = await cli(path, ['watch', '--channel', '4040', '--timeout', '1'], session);
  assert.equal(result.messages[0].text, 'keep this mail'); assert.equal(result.timed_out, false); assert.equal(result.acknowledged_cursor, 0);
  assert.equal(requests, 1, 'Queued mail should not await a redundant confirmation request');
  requests = 0;
  await assert.rejects(cli(path, ['watch', '--channel', '4040', '--timeout', '2147484'], session), (error: unknown) => (error as { stderr: string }).stderr.includes('INVALID_ARGUMENT'));
  assert.equal(requests, 0);
});

test('CLI join retries preserve the exact secret candidate and idempotency key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-channel-retry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bodies: string[] = []; const keys: string[] = []; const generation = randomUUID();
  const url = await httpFixture(t, (req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const input = JSON.parse(body);
      if (req.url?.endsWith('/join')) {
        bodies.push(body); keys.push(String(req.headers['idempotency-key']));
        if (bodies.length === 1) { res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}'); return; }
      }
      if (req.url?.endsWith('/confirm')) assert.equal(req.headers.connection, 'close');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ channel: '4040', generation, pairing_id: generation, session_id: input.session_id, secret_word: input.secret_word, status: 'waiting', peer: null, lease_expires_at: new Date(Date.now() + 90_000).toISOString() }));
    });
  });
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {} }));
  const result = await cli(path, ['channel', 'join', '4040', '--wait', '0']);
  assert.equal(result.status, 'waiting'); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(keys[0], keys[1]); assert.match(JSON.parse(bodies[0]).secret_word, /^[a-z]+-[a-z]+-[a-f0-9]{4}$/);
});

test('CLI refreshes a changed pairing before confirming and bounds recovery retries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-channel-pairing-race-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json'); const generation = randomUUID(); const firstPairing = randomUUID(); const currentPairing = randomUUID();
  let sessionId = ''; let word = ''; const confirmed: string[] = []; let alwaysReject = false;
  const url = await httpFixture(t, (req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const input = body ? JSON.parse(body) : undefined;
      if (req.url?.endsWith('/join')) { sessionId = input.session_id; word = input.secret_word; }
      if (req.url?.endsWith('/confirm')) {
        confirmed.push(input.pairing_id);
        if (alwaysReject || input.pairing_id === firstPairing) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'channel_pairing_changed', message: 'Peer changed; read status again' } })); return; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ channel: '4040', generation, pairing_id: req.url?.endsWith('/join') ? firstPairing : currentPairing, session_id: sessionId, secret_word: word, status: req.url?.endsWith('/confirm') ? 'connected' : 'waiting', peer: { device: 'vm', session_id: randomUUID() }, lease_expires_at: new Date(Date.now() + 90_000).toISOString() }));
    });
  });
  await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {} }));
  const result = await cli(path, ['channel', 'join', '4040', '--wait', '0']); assert.equal(result.status, 'connected'); assert.deepEqual(confirmed, [firstPairing, currentPairing]);
  alwaysReject = true; confirmed.length = 0;
  await assert.rejects(cli(path, ['channel', 'join', '4040', '--wait', '0']), (error: unknown) => (error as { stderr: string }).stderr.includes('channel_pairing_changed'));
  assert.equal(confirmed.length, 3, 'Pairing churn must not create an unbounded confirmation loop');
});

test('join never merges stale session state after credentials change during the request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-channel-config-race-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json'); const generation = randomUUID();
  const url = await httpFixture(t, (req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; }); req.on('end', () => { void (async () => {
      const input = JSON.parse(body);
      await writeFile(path, JSON.stringify({ url, token: 'replacement', device: 'laptop', roots: { preserved: directory } }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ channel: '4040', generation, pairing_id: generation, session_id: input.session_id, secret_word: input.secret_word, status: 'waiting', peer: null, lease_expires_at: new Date().toISOString() }));
    })(); });
  });
  await writeFile(path, JSON.stringify({ url, token: 'token', device: 'laptop', roots: {} }));
  await assert.rejects(cli(path, ['channel', 'join', '4040', '--wait', '0']), (error: unknown) => (error as { stderr: string }).stderr.includes('CONFIG_CHANGED'));
  const config = JSON.parse(await readFile(path, 'utf8')); assert.equal(config.token, 'replacement'); assert.equal(config.roots.preserved, directory); assert.equal(config.channel_sessions, undefined);
});

test('skill installs the full folder for the user by default and protects existing files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-skill-install-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { HOME: directory, USERPROFILE: directory }; const config = join(directory, 'config.json');
  const installed = await cli(config, ['skill', 'install', '--user'], '', env);
  const destination = join(directory, '.codex/skills/agent-bridge'); assert.equal(installed.installed, join(destination, 'SKILL.md'));
  assert.ok((await readFile(join(destination, 'agents/openai.yaml'), 'utf8')).length);
  assert.ok((await readFile(join(destination, 'references/setup.md'), 'utf8')).length);
  await writeFile(join(destination, 'SKILL.md'), 'preserve my edits');
  await assert.rejects(cli(config, ['skill', 'install'], '', env), (error: unknown) => (error as { stderr: string }).stderr.includes('SKILL_EXISTS'));
  assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'), 'preserve my edits');
  assert.deepEqual(await readdir(join(directory, '.codex/skills')), ['agent-bridge']);
  const lock = `${destination}.install-lock`; await mkdir(lock);
  await assert.rejects(cli(config, ['skill', 'install', '--force'], '', env), (error: unknown) => (error as { stderr: string }).stderr.includes('SKILL_INSTALL_BUSY'));
  assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'), 'preserve my edits');
  assert.ok((await readdir(join(directory, '.codex/skills'))).includes('agent-bridge.install-lock'), 'A busy installer must not remove another command\'s lock');
  await rm(lock, { recursive: true });
  await cli(config, ['skill', 'install', '--force'], '', env); assert.notEqual(await readFile(join(destination, 'SKILL.md'), 'utf8'), 'preserve my edits');
  assert.deepEqual(await readdir(join(directory, '.codex/skills')), ['agent-bridge']);
  const project = join(directory, 'project'); await mkdir(project);
  await cli(config, ['skill', 'install', '--project', project], '', env); assert.ok((await readFile(join(project, '.agents/skills/agent-bridge/agents/openai.yaml'), 'utf8')).length);
  await assert.rejects(cli(config, ['skill', 'install', '--user', '--project', project], '', env), (error: unknown) => (error as { stderr: string }).stderr.includes('mutually exclusive'));
  const claude = await cli(config, ['skill', 'install', '--claude'], '', env);
  assert.equal(claude.installed, join(directory, '.claude/skills/agent-bridge', 'SKILL.md')); assert.equal(claude.scope, 'claude');
  await assert.rejects(cli(config, ['skill', 'install', '--claude', '--user'], '', env), (error: unknown) => (error as { stderr: string }).stderr.includes('mutually exclusive'));
});
