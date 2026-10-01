import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function httpFixture(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = httpServer(handle); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
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
  await cli(config, ['skill', 'install', '--force'], '', env); assert.notEqual(await readFile(join(destination, 'SKILL.md'), 'utf8'), 'preserve my edits');
  const project = join(directory, 'project'); await mkdir(project);
  await cli(config, ['skill', 'install', '--project', project], '', env); assert.ok((await readFile(join(project, '.agents/skills/agent-bridge/agents/openai.yaml'), 'utf8')).length);
  await assert.rejects(cli(config, ['skill', 'install', '--user', '--project', project], '', env), (error: unknown) => (error as { stderr: string }).stderr.includes('mutually exclusive'));
});
