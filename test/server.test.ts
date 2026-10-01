import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type ServerOptions } from '../src/server/server.js';

const adminToken = 'admin-test-token-with-at-least-32-characters';
const authorization = (token: string) => ({ authorization: `Bearer ${token}` });

async function fixture(t: TestContext, settings: Partial<ServerOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-bridge-server-'));
  const app = await createServer({ dataDir, adminToken, ...settings });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async (name: string) => {
    const response = await app.inject({ method: 'POST', url: '/v1/devices', headers: authorization(adminToken), payload: { name } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().token as string;
  };
  const heartbeat = async (token: string) => {
    const response = await app.inject({ method: 'POST', url: '/v1/heartbeat', headers: authorization(token), payload: { roots: ['repo'] } });
    assert.equal(response.statusCode, 200, response.body);
  };
  return { app, dataDir, register, heartbeat };
}

function multipartBody(bytes: Buffer | string, name = 'example.bin') {
  const boundary = 'bridge-test-boundary';
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { prefix, suffix, payload: Buffer.concat([prefix, Buffer.from(bytes), suffix]), contentType: `multipart/form-data; boundary=${boundary}` };
}

test('authentication, device registration and revocation persist only hashed tokens', async t => {
  const { app, dataDir, register } = await fixture(t);
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  assert.equal((await app.inject('/v1/files')).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/files?token=secret' })).statusCode, 401);
  const token = await register('laptop');
  assert.equal((await app.inject({ url: '/v1/devices', headers: authorization(adminToken) })).statusCode, 401);
  const devices = (await app.inject({ url: '/v1/devices', headers: authorization(token) })).json().devices;
  assert.deepEqual(devices, [{ name: 'laptop', roots: [], last_seen: null, online: false, revoked: false }]);
  const duplicate = await app.inject({ method: 'POST', url: '/v1/devices', headers: authorization(adminToken), payload: { name: 'laptop' } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/devices/laptop', headers: authorization(adminToken) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/devices', headers: authorization(token) })).statusCode, 401);
  await app.close();
  assert.equal((await readFile(join(dataDir, 'bridge.sqlite'))).includes(Buffer.from(token)), false);
  await assert.rejects(createServer({ dataDir, adminToken: 'short' }), /at least 32/);
});

test('mailbox polling wakes, cursors paginate and retries do not duplicate messages', async t => {
  const { app, register } = await fixture(t);
  const sender = await register('laptop');
  const receiver = await register('vm');
  const pending = app.inject({ url: '/v1/messages?wait=1', headers: authorization(receiver) });
  await delay(20);
  const send = (text: string) => app.inject({ method: 'POST', url: '/v1/messages', headers: { ...authorization(sender), 'idempotency-key': 'message-one' }, payload: { to: 'vm', text } });
  const first = await send('What is in the VM repo?');
  const retry = await send('What is in the VM repo?');
  assert.equal(retry.json().message.id, first.json().message.id);
  assert.equal((await send('Different content')).statusCode, 409);
  const inbox = (await pending).json();
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].from, 'laptop');
  assert.equal(inbox.cursor, first.json().message.seq);
  const after = await app.inject({ url: `/v1/messages?after=${inbox.cursor}`, headers: authorization(receiver) });
  assert.deepEqual(after.json(), { messages: [], cursor: inbox.cursor });
});

test('requests reject offline devices and enforce target ownership, lease fencing and idempotency', async t => {
  const { app, register, heartbeat } = await fixture(t, { leaseMs: 40 });
  const sender = await register('laptop');
  const receiver = await register('vm');
  const outsider = await register('other');
  const send = (path = 'README.md') => app.inject({ method: 'POST', url: '/v1/requests', headers: { ...authorization(sender), 'idempotency-key': 'request-one' }, payload: { to: 'vm', operation: 'read', root: 'repo', path } });
  assert.equal((await send()).statusCode, 503);
  await heartbeat(receiver);
  const submitted = await send();
  assert.equal(submitted.statusCode, 202);
  const id = submitted.json().request.id;
  assert.equal((await send()).json().request.id, id);
  assert.equal((await send('different')).statusCode, 409);
  assert.equal((await app.inject({ url: `/v1/requests/${id}`, headers: authorization(outsider) })).statusCode, 403);
  const claim = async () => (await app.inject({ url: '/v1/connector/requests', headers: authorization(receiver) })).json().requests;
  const original = (await claim())[0];
  assert.ok(original.lease_token);
  assert.deepEqual(await claim(), []);
  const result = (token: string, who = receiver) => app.inject({ method: 'POST', url: `/v1/requests/${id}/result`, headers: authorization(who), payload: { lease_token: token, result: { content: 'remote contents' } } });
  assert.equal((await result(original.lease_token, sender)).statusCode, 403);
  await delay(60);
  assert.equal((await result(original.lease_token)).statusCode, 409);
  const replacement = (await claim())[0];
  assert.notEqual(replacement.lease_token, original.lease_token);
  assert.equal((await result(original.lease_token)).statusCode, 409);
  const completed = await result(replacement.lease_token);
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().request.status, 'completed');
  assert.equal(completed.json().request.lease_token, undefined);
  assert.equal((await result(replacement.lease_token)).statusCode, 409);
});

test('expired requests return structured errors and revoked long-poll credentials stop immediately', async t => {
  const { app, register, heartbeat } = await fixture(t, { requestTtlMs: 80 });
  const sender = await register('laptop');
  const receiver = await register('vm');
  await heartbeat(receiver);
  const submitted = await app.inject({ method: 'POST', url: '/v1/requests', headers: authorization(sender), payload: { to: 'vm', operation: 'list', root: 'repo' } });
  const expired = await app.inject({ url: `/v1/requests/${submitted.json().request.id}?wait=1`, headers: authorization(sender) });
  assert.equal(expired.json().request.status, 'expired');
  assert.equal(expired.json().request.error.code, 'request_timeout');
  const pending = app.inject({ url: '/v1/messages?wait=25', headers: authorization(receiver) });
  await delay(20);
  await app.inject({ method: 'DELETE', url: '/v1/devices/vm', headers: authorization(adminToken) });
  assert.equal((await pending).statusCode, 401);
});

test('SQLite preserves device credentials, pending requests, messages and files across restart', async t => {
  const { app, dataDir, register, heartbeat } = await fixture(t);
  const sender = await register('laptop');
  const receiver = await register('vm');
  await heartbeat(receiver);
  const message = await app.inject({ method: 'POST', url: '/v1/messages', headers: authorization(sender), payload: { to: 'vm', text: 'durable' } });
  const request = await app.inject({ method: 'POST', url: '/v1/requests', headers: authorization(sender), payload: { to: 'vm', operation: 'list', root: 'repo' } });
  const body = multipartBody('persistent bytes');
  const upload = await app.inject({ method: 'POST', url: '/v1/files', headers: { ...authorization(sender), 'content-type': body.contentType }, payload: body.payload });
  assert.equal(upload.statusCode, 200, upload.body);
  await app.close();
  const restarted = await createServer({ dataDir, adminToken });
  t.after(() => restarted.close());
  assert.equal((await restarted.inject({ url: '/v1/messages', headers: authorization(receiver) })).json().messages[0].id, message.json().message.id);
  assert.equal((await restarted.inject({ url: '/v1/connector/requests', headers: authorization(receiver) })).json().requests[0].id, request.json().request.id);
  assert.equal((await restarted.inject({ url: `/v1/files/${upload.json().file.id}/content`, headers: authorization(receiver) })).body, 'persistent bytes');
});

test('uploads stream exact bytes, enforce quota and limits, and restrict deletion to uploader', async t => {
  const { app, dataDir, register } = await fixture(t, { maxUploadBytes: 8, quotaBytes: 10 });
  const owner = await register('laptop');
  const peer = await register('vm');
  const upload = async (bytes: string) => {
    const body = multipartBody(bytes, '../untrusted.bin');
    return app.inject({ method: 'POST', url: '/v1/files', headers: { ...authorization(owner), 'content-type': body.contentType }, payload: body.payload });
  };
  assert.equal((await upload('123456789')).statusCode, 413);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
  assert.deepEqual((await app.inject({ url: '/v1/files', headers: authorization(peer) })).json().files, []);
  const accepted = await upload('1234567');
  assert.equal(accepted.statusCode, 200, accepted.body);
  const file = accepted.json().file;
  assert.equal(file.name, 'untrusted.bin');
  assert.equal(file.size, 7);
  const digest = createHash('sha256').update('1234567').digest('hex');
  assert.equal(file.sha256, digest);
  const download = await app.inject({ url: `/v1/files/${file.id}/content`, headers: authorization(peer) });
  assert.equal(download.body, '1234567');
  assert.equal(download.headers['x-content-sha256'], digest);
  assert.equal((await upload('1234')).statusCode, 413);
  assert.equal((await upload('123')).statusCode, 200);
  assert.equal((await upload('1')).statusCode, 507);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/files/${file.id}`, headers: authorization(peer) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/files/${file.id}`, headers: authorization(owner) })).statusCode, 204);
  assert.equal((await app.inject({ url: `/v1/files/${file.id}`, headers: authorization(owner) })).statusCode, 404);
});

test('concurrent upload reservations prevent quota overflow and interrupted streams are cleaned', async t => {
  const { app, dataDir, register } = await fixture(t, { maxUploadBytes: 8, quotaBytes: 10 });
  const owner = await register('laptop');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const body = multipartBody('12345');
  const makeUpload = () => {
    let settle!: (value: { status: number; body: string }) => void;
    const completed = new Promise<{ status: number; body: string }>(resolve => { settle = resolve; });
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/v1/files', method: 'POST', headers: { ...authorization(owner), 'content-type': body.contentType } }, response => {
      let text = '';
      response.on('data', bytes => { text += bytes; });
      response.on('end', () => settle({ status: response.statusCode!, body: text }));
    });
    req.on('error', () => settle({ status: 0, body: '' }));
    req.write(body.prefix);
    req.write('12345');
    return { req, completed };
  };
  const waitForTemps = async (count: number) => {
    for (let i = 0; i < 100; i++) {
      if ((await readdir(join(dataDir, 'tmp'))).length === count) return;
      await delay(10);
    }
    assert.fail(`Expected ${count} temporary uploads`);
  };
  const first = makeUpload();
  await waitForTemps(1);
  const second = multipartBody('123');
  const blocked = await app.inject({ method: 'POST', url: '/v1/files', headers: { ...authorization(owner), 'content-type': second.contentType }, payload: second.payload });
  assert.equal(blocked.statusCode, 413, blocked.body);
  first.req.end(body.suffix);
  const finished = await first.completed;
  assert.equal(finished.status, 200, finished.body);
  const interrupted = makeUpload();
  await waitForTemps(1);
  interrupted.req.destroy();
  await interrupted.completed;
  await waitForTemps(0);
  assert.equal((await app.inject({ url: '/v1/files', headers: authorization(owner) })).json().files.length, 1);
});

test('startup online backup is valid SQLite and bounds retention to seven snapshots', async t => {
  const { app, dataDir } = await fixture(t);
  const backupsDir = join(dataDir, 'backups');
  for (let i = 0; i < 8; i++) await writeFile(join(backupsDir, `bridge-2000-01-0${i + 1}.sqlite`), 'old backup');
  await app.inject('/healthz');
  let snapshots: string[] = [];
  for (let i = 0; i < 100; i++) {
    snapshots = await readdir(backupsDir);
    if (snapshots.length === 7 && snapshots.some(name => !name.startsWith('bridge-2000'))) break;
    await delay(10);
  }
  assert.equal(snapshots.length, 7);
  const snapshot = snapshots.find(name => !name.startsWith('bridge-2000'));
  assert.ok(snapshot);
  const copy = new DatabaseSync(join(backupsDir, snapshot), { readOnly: true });
  try {
    assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'devices'").get());
  } finally { copy.close(); }
});
