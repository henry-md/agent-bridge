import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { DaemonClient, type DaemonInfo } from '../src/client/daemon-client.js';
import { RelayClient } from '../src/client/relay.js';
import { createServer } from '../src/server/server.js';

async function daemon(t: TestContext, config: string) {
  const child = spawn(process.execPath, ['dist/cli.js', 'daemon', 'run'], { cwd: process.cwd(), env: { ...process.env, BRIDGE_CONFIG: config, CODEX_THREAD_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error(`Daemon exited before readiness: ${stderr}`)));
    let stdout = '';
    child.stdout!.on('data', chunk => { stdout += chunk; if (!stdout.includes('\n')) return; try { const result = JSON.parse(stdout.split('\n')[0]); assert.equal(result.running, true); assert.equal(result.token, undefined); resolve(); } catch (error) { reject(error); } });
  });
  await ready;
  const info = JSON.parse(await readFile(`${config}.daemon.json`, 'utf8')) as DaemonInfo; const client = new DaemonClient(info, config);
  t.after(async () => {
    await client.stop().catch(() => {});
    await Promise.race([exited, pause(3000).then(() => { if (child.exitCode === null) child.kill(); })]);
    assert.equal(stderr, '');
  });
  return { client, info, child, exited };
}
async function fixture(t: TestContext, beforeListen?: (relay: Awaited<ReturnType<typeof createServer>>) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-runtime-'));
  const adminToken = 'runtime-test-admin-token-at-least-32-bytes';
  const options = { dataDir: join(directory, 'data'), adminToken, logger: false };
  const relay = await createServer(options); beforeListen?.(relay); const url = await relay.listen({ host: '127.0.0.1', port: 0 });
  const locals: Awaited<ReturnType<typeof daemon>>[] = [];
  t.after(async () => { await Promise.all(locals.map(async local => { await local.client.stop().catch(() => {}); await local.exited; })); await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const admin = new RelayClient(url, adminToken);
  async function device(name: string) {
    const registration = await admin.register(name); const config = join(directory, `${name}.json`);
    await writeFile(config, JSON.stringify({ url, token: registration.token, device: name, roots: {} }), { mode: 0o600 });
    const local = await daemon(t, config); locals.push(local);
    return { ...local, config, relay: new RelayClient(url, registration.token), session: randomUUID() };
  }
  return { directory, relay, admin, device };
}

test('resident processes exchange fresh nonce proofs repeatedly while keeping one channel generation', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  const [first, second] = await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  for (const result of [first, second]) { assert.equal(result.verified, true); assert.equal(result.timed_out, false); assert.ok(result.proof_round_trip_ms! >= 0); assert.ok(result.proof_message_id); }
  assert.equal(first.connection!.secret_word, second.connection!.secret_word); assert.notEqual(first.proof_nonce, second.proof_nonce);
  const next = await a.client.pair('4040', a.session, 5000);
  assert.equal(next.verified, true); assert.notEqual(next.proof_nonce, first.proof_nonce); assert.notEqual(next.proof_message_id, first.proof_message_id); assert.equal(next.connection!.generation, first.connection!.generation);
  const replay = await a.relay.channelInbox('4040', a.session, first.connection!.generation, 0, 0);
  const echo = replay.messages.find(message => message.id === next.proof_message_id)!;
  assert.equal(JSON.parse(echo.text.slice('agent-bridge control v2: '.length)).nonce, next.proof_nonce);
  assert.equal((await a.client.status()).channels[0].transport, 'online');
  if (process.platform !== 'win32') assert.equal((await stat(`${a.config}.daemon.json`)).mode & 0o077, 0);
});

test('runtime proofs do not acknowledge ordinary context, attached controls or mail beyond the delivered page', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  const [paired] = await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  const file = join(h.directory, 'context.txt'); await writeFile(file, 'context attachment'); const uploaded = await a.relay.upload(file);
  const question = await a.relay.sendChannel('4040', { session_id: a.session, generation: paired.connection!.generation, text: 'ordinary context must remain pending', file_ids: [] });
  const attached = await a.relay.sendChannel('4040', { session_id: a.session, generation: paired.connection!.generation, text: `agent-bridge setup ack: ${paired.connection!.secret_word}`, file_ids: [uploaded.id] });
  const incoming = await b.client.watch('4040', b.session, 5000);
  // A reader may return the first record before the second arrives.
  while ((await b.client.status()).channels[0].pending_messages < 2) await pause(5);
  const proof = await b.client.pair('4040', b.session, 5000);
  assert.equal(proof.verified, true); assert.deepEqual(proof.messages.map(message => message.id), [question.id, attached.id]);
  const pending = await b.relay.channelInbox('4040', b.session, paired.connection!.generation, undefined, 0);
  assert.ok(pending.messages.some(message => message.id === question.id)); assert.ok(pending.messages.some(message => message.id === attached.id));
  assert.ok(pending.acknowledged_cursor < question.seq);
  await b.client.acknowledge('4040', b.session, paired.connection!.generation, proof.cursor);
  assert.equal((await b.client.status()).channels[0].pending_messages, 0);
  assert.deepEqual((await b.relay.channelInbox('4040', b.session, paired.connection!.generation, undefined, 0)).messages, []);
  await assert.rejects(b.client.acknowledge('4040', b.session, randomUUID(), incoming.cursor), (error: any) => error.code === 'stale_generation');
});

test('local RPC rejects missing credentials and hostile Host headers; relay revocation stops fresh proof', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  assert.equal((await fetch(`${a.info.url}/v1/status`)).status, 401);
  const hostileHost = await new Promise<number>(resolve => { const request = httpRequest(`${a.info.url}/v1/status`, { headers: { Authorization: `Bearer ${a.info.token}`, Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode!); }); request.end(); });
  assert.equal(hostileHost, 403);
  await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  await h.admin.revoke('vm');
  await assert.rejects(b.client.pair('4040', b.session, 5000), (error: any) => error.code === 'unauthorized');
});

test('runtime setup deadlines return unverified when the relay stalls and shutdown cancels initialization', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-runtime-stall-'));
  const relay = httpServer(() => {}); relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  t.after(async () => { relay.closeAllConnections(); await new Promise<void>(resolve => relay.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const config = join(directory, 'config.json'); const url = `http://127.0.0.1:${(relay.address() as {port:number}).port}`;
  await writeFile(config, JSON.stringify({ url, token: 'test-token', device: 'laptop', roots: {} }));
  const local = await daemon(t, config); const started = performance.now();
  const result = await local.client.pair('4040', randomUUID(), 100);
  assert.equal(result.verified, false); assert.equal(result.timed_out, true); assert.ok(performance.now() - started < 1000);
  await local.client.stop();
  await local.exited;
});


test('resident receiver restores the same pairing after restart, preserves paged mail, and follows local RPC replacement', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  const [paired] = await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  const sent = [];
  for (let i = 0; i < 103; i++) sent.push(await a.relay.sendChannel('4040', { session_id: a.session, generation: paired.connection!.generation, text: `ordinary ${i}`, file_ids: [] }));
  const malformed = await a.relay.sendChannel('4040', { session_id: a.session, generation: paired.connection!.generation, text: 'agent-bridge control v2: {invalid}', file_ids: [] });
  while ((await b.client.status()).channels[0].pending_messages < 104) await pause(5);
  await b.client.stop(); await b.exited;
  const restored = await daemon(t, b.config);
  assert.equal(restored.info.url, b.info.url); assert.notEqual(restored.info.token, b.info.token);
  while ((await restored.client.status()).channels[0].pending_messages < 104) await pause(5);
  const page = await b.client.watch('4040', b.session, 5000); // old client follows new private descriptor
  assert.equal(page.messages.length, 100); assert.deepEqual(page.messages.map(message => message.id), sent.slice(0, 100).map(message => message.id));
  await b.client.acknowledge('4040', b.session, paired.connection!.generation, page.cursor);
  const remainder = await b.client.watch('4040', b.session, 5000);
  assert.deepEqual(remainder.messages.map(message => message.id), [...sent.slice(100).map(message => message.id), malformed.id]);
  const proof = await b.client.pair('4040', b.session, 5000);
  assert.equal(proof.verified, true); assert.equal(proof.connection!.generation, paired.connection!.generation); assert.equal(proof.connection!.pairing_id, paired.connection!.pairing_id);
  await b.client.acknowledge('4040', b.session, paired.connection!.generation, proof.cursor);
  await restored.client.stop(); await restored.exited;
});

test('exclusive listener rejects a concurrent owner and survives a crash without a stale lock', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop');
  const duplicate = spawn(process.execPath, ['dist/cli.js', 'daemon', 'run'], { env: { ...process.env, BRIDGE_CONFIG: a.config }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; duplicate.stderr!.on('data', chunk => { stderr += chunk; });
  assert.equal((await once(duplicate, 'exit'))[0], 1); assert.match(stderr, /DAEMON_BUSY/);
  assert.equal((await a.client.status()).pid, a.child.pid);
  a.child.kill('SIGKILL'); await a.exited;
  const replacement = await daemon(t, a.config); assert.equal(replacement.info.url, a.info.url);
  await replacement.client.stop(); await replacement.exited;
});

test('changed credentials cannot expose verified results or cached mail, even at an expired deadline', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  const [paired] = await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  // An ordinary record must survive a setup timeout and an account change.
  const sent = await a.relay.sendChannel('4040', { session_id: a.session, generation: paired.connection!.generation, text: 'still pending', file_ids: [] });
  const pending = await b.client.watch('4040', b.session, 5000); assert.equal(pending.messages[0].id, sent.id);
  const current = JSON.parse(await readFile(b.config, 'utf8')); current.token = 'changed-token'; await writeFile(b.config, JSON.stringify(current));
  await assert.rejects(b.client.pair('4040', b.session, 1), (error: any) => error.code === 'CONFIG_CHANGED');
  await assert.rejects(b.client.watch('4040', b.session, 1), (error: any) => error.code === 'CONFIG_CHANGED');
  const durable = await b.relay.channelInbox('4040', b.session, paired.connection!.generation, undefined, 0);
  assert.ok(durable.messages.some(message => message.id === sent.id));
});


test('a stalled setup POST is canceled at its deadline and ordinary receiving stays responsive', { timeout: 20_000 }, async t => {
  let stall = false;
  const h = await fixture(t, relay => relay.addHook('preHandler', async (request, reply) => {
    if (stall && request.method === 'POST' && request.url.endsWith('/messages') && String((request.body as any)?.text).includes('"kind":"probe"')) {
      await new Promise<void>(resolve => reply.raw.once('close', resolve));
    }
  }));
  const a = await h.device('laptop'), b = await h.device('vm');
  const [paired] = await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  stall = true;
  const result = await b.client.pair('4040', b.session, 100);
  assert.equal(result.verified, false); assert.equal(result.connection, undefined); assert.equal(result.timed_out, true);
  stall = false;
  const sent = await a.relay.sendChannel('4040', { session_id: a.session, generation: paired.connection!.generation, text: 'reader recovered', file_ids: [] });
  const page = await b.client.watch('4040', b.session, 2000); assert.equal(page.messages[0].id, sent.id);
  assert.equal((await b.client.pair('4040', b.session, 2000)).verified, true);
});

test('leave uses the latest persisted generation and stops the worker before removing membership', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  await b.client.leave('4040', b.session);
  assert.equal((await b.client.status()).channels.length, 0);
  assert.equal(JSON.parse(await readFile(b.config, 'utf8')).runtime.channels['4040'], undefined);
  await assert.rejects(b.client.watch('4040', b.session, 100), (error: any) => error.code === 'channel_session_replaced');
});

test('pane streams only the verified word and timing; local context and credentials stay behind authentication', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.device('laptop'), b = await h.device('vm');
  const [paired] = await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  const controller = new AbortController();
  const response = await fetch(a.info.url + '/ui/events?channel=4040', { signal: controller.signal });
  const chunk = await response.body!.getReader().read(); controller.abort();
  const value = JSON.parse(new TextDecoder().decode(chunk.value).split('data: ')[1].split('\n')[0]);
  assert.equal(value.word, paired.connection!.secret_word); assert.ok(value.proof_ms >= 0);
  for (const name of ['token', 'session_id', 'messages', 'connection', 'device']) assert.equal(value[name], undefined);
  assert.equal((await fetch(a.info.url + '/ui', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(a.info.url + '/v1/status')).status, 401);
});


test('slow control receipts do not delay the next fresh proof or the sole inbox reader', { timeout: 20_000 }, async t => {
  let receiptStarted = false;
  const h = await fixture(t, relay => relay.addHook('preHandler', async request => {
    if (request.url.endsWith('/ack')) { receiptStarted = true; await pause(400); }
  }));
  const a = await h.device('laptop'), b = await h.device('vm');
  await Promise.all([a.client.pair('4040', a.session, 5000), b.client.pair('4040', b.session, 5000)]);
  while (!receiptStarted) await pause(5);
  const proof = await a.client.pair('4040', a.session, 250);
  assert.equal(proof.verified, true); assert.ok(proof.proof_round_trip_ms! < 250);
});
