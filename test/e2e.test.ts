import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { runConnector } from '../src/client/connector.js';
import { RelayClient } from '../src/client/relay.js';
import { createServer } from '../src/server/server.js';
import { BridgeError, type ListResult, type ReadResult, type RemoteRequest, type RequestInput, type SearchResult } from '../src/shared/protocol.js';

const ADMIN_TOKEN = 'integration-admin-token-with-at-least-32-bytes';

async function eventually<T>(inspect: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await inspect();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, 'Expected condition was not reached before timeout');
    await delay(25);
  }
}

async function harness(t: TestContext, overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-e2e-'));
  const options = { dataDir: join(directory, 'data'), adminToken: ADMIN_TOKEN, logger: false as const, ...overrides };
  // Fixture storage always lives in the temporary directory, including across restarts.
  options.dataDir = join(directory, 'data');
  let app = await createServer(options);
  let url = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = Number(new URL(url).port);
  const connectors: Array<{ controller: AbortController; finished: Promise<void> }> = [];
  const stopConnectors = async () => {
    for (const connector of connectors) connector.controller.abort();
    await Promise.all(connectors.map(connector => connector.finished));
    connectors.length = 0;
  };
  t.after(async () => {
    await stopConnectors();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, url,
    admin: new RelayClient(url, ADMIN_TOKEN),
    async register(name: string) {
      const registered = await new RelayClient(url, ADMIN_TOKEN).register(name);
      assert.equal(registered.device.name, name);
      return { client: new RelayClient(url, registered.token), token: registered.token };
    },
    connector(client: RelayClient, name: string, roots: Record<string, string>) {
      const controller = new AbortController();
      const finished = runConnector(client, name, roots, { signal: controller.signal, heartbeatMs: 100, pollSeconds: 1 });
      connectors.push({ controller, finished });
      return controller;
    },
    async restart() {
      await app.close();
      app = await createServer(options);
      url = await app.listen({ port, host: '127.0.0.1' });
      assert.equal(new URL(url).port, String(port));
    },
  };
}

async function remote(client: RelayClient, input: RequestInput): Promise<RemoteRequest> {
  const created = await client.createRequest(input);
  return eventually(() => client.request(created.id, 1), request => !['pending', 'running'].includes(request.status));
}

const input = (to: string, operation: RequestInput['operation'], path = '', query?: string): RequestInput => ({
  to, operation, root: 'work', path, limit: 100, ...(query ? { query } : {}),
});

function unauthorized(error: unknown): boolean {
  return error instanceof BridgeError && [401, 403].includes(error.status);
}

test('real HTTP clients transfer attachments both ways and retrieve source context from two connectors', { timeout: 30000 }, async t => {
  const h = await harness(t, { maxUploadBytes: 2 * 1024 * 1024, quotaBytes: 8 * 1024 * 1024 });
  const laptopRoot = join(h.directory, 'laptop');
  const vmRoot = join(h.directory, 'vm');
  await Promise.all([mkdir(laptopRoot), mkdir(vmRoot)]);
  await Promise.all([
    writeFile(join(laptopRoot, 'expected.txt'), 'Invoice A expects 125.00 USD.\nInvoice B expects 40.00 USD.\n'),
    writeFile(join(vmRoot, 'received.txt'), 'Invoice A received 125.00 USD.\nInvoice B received 30.00 USD.\n'),
    writeFile(join(h.directory, 'secret.txt'), 'This file must stay outside shared roots.'),
  ]);
  const laptop = (await h.register('laptop')).client;
  const vmRegistration = await h.register('vm');
  const vm = vmRegistration.client;
  h.connector(laptop, 'laptop', { work: laptopRoot });
  h.connector(vm, 'vm', { work: vmRoot });
  await eventually(() => laptop.devices(), devices => devices.length === 2 && devices.every(device => device.online && device.roots.includes('work')));

  const bytes = randomBytes(1024 * 1024 + 17);
  const laptopFile = join(laptopRoot, 'report.bin');
  await writeFile(laptopFile, bytes);
  const uploaded = await laptop.upload(laptopFile);
  assert.equal(uploaded.size, bytes.length);
  assert.equal(uploaded.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(uploaded.uploaded_by, 'laptop');

  // The inbox is already waiting before submission; a new message wakes it promptly.
  const started = Date.now();
  const pendingInbox = vm.inbox(0, 25);
  await delay(30);
  const messageInput = { to: 'vm', text: 'Compare this attachment with your local export.', file_ids: [uploaded.id] };
  const key = randomUUID();
  const sent = await laptop.send(messageInput, key);
  const retry = await laptop.send(messageInput, key);
  assert.equal(retry.id, sent.id, 'Retrying a message must not create a second delivery');
  const inbox = await pendingInbox;
  assert.ok(Date.now() - started < 3000, 'Long poll should wake on a new message');
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].id, sent.id);
  assert.deepEqual(inbox.messages[0].file_ids, [uploaded.id]);
  assert.ok(inbox.cursor >= sent.seq);
  assert.deepEqual((await vm.inbox(inbox.cursor, 0)).messages, []);

  const vmDownload = join(vmRoot, 'received-report.bin');
  const downloaded = await vm.download(uploaded.id, vmDownload);
  assert.equal(downloaded.sha256, uploaded.sha256);
  assert.deepEqual(await readFile(vmDownload), bytes);
  await assert.rejects(() => vm.download(uploaded.id, vmDownload), error => error instanceof BridgeError && error.code === 'OUTPUT_EXISTS');

  const replyBytes = Buffer.from('VM analysis attachment\n' + randomBytes(8192).toString('base64'));
  const vmFile = join(vmRoot, 'analysis.txt');
  await writeFile(vmFile, replyBytes);
  const replyFile = await vm.upload(vmFile);
  const replied = await vm.send({ to: 'laptop', text: 'Attached the analysis.', file_ids: [replyFile.id] });
  assert.equal((await laptop.inbox(0, 0)).messages[0].id, replied.id);
  const laptopDownload = join(laptopRoot, 'downloaded-analysis.txt');
  await laptop.download(replyFile.id, laptopDownload);
  assert.deepEqual(await readFile(laptopDownload), replyBytes);

  // This fixture reproduces the data retrieval needed for an answer using both machines.
  const [expectedRequest, receivedRequest] = await Promise.all([
    remote(laptop, input('laptop', 'read', 'expected.txt')),
    remote(laptop, input('vm', 'read', 'received.txt')),
  ]);
  assert.equal(expectedRequest.status, 'completed');
  assert.equal(receivedRequest.status, 'completed');
  const expected = expectedRequest.result as ReadResult;
  const received = receivedRequest.result as ReadResult;
  assert.deepEqual([expected.device, expected.root, expected.path], ['laptop', 'work', 'expected.txt']);
  assert.deepEqual([received.device, received.root, received.path], ['vm', 'work', 'received.txt']);
  assert.equal(expected.truncated, false);
  assert.equal(received.truncated, false);
  assert.ok(Number.isFinite(Date.parse(received.modified_at)));
  const difference = Number(expected.content.match(/Invoice B expects ([\d.]+)/)![1]) - Number(received.content.match(/Invoice B received ([\d.]+)/)![1]);
  assert.equal(difference, 10, 'Cross-device source files identify the missing payment');

  const listed = await remote(laptop, input('vm', 'list'));
  assert.equal(listed.status, 'completed');
  assert.ok((listed.result as ListResult).entries.some(entry => entry.name === 'received.txt'));
  const searched = await remote(laptop, input('vm', 'search', 'received.txt', 'Invoice B'));
  assert.equal(searched.status, 'completed');
  assert.equal((searched.result as SearchResult).matches[0].line, 2);
  assert.equal((searched.result as SearchResult).matches[0].device, 'vm');
  const escaped = await remote(laptop, input('vm', 'read', '../secret.txt'));
  assert.equal(escaped.status, 'failed');
  assert.equal(escaped.error?.code, 'PATH_FORBIDDEN');

  const invalid = new RelayClient(h.url, 'invalid-device-token');
  await assert.rejects(() => invalid.devices(), unauthorized);
  await assert.rejects(() => invalid.file(uploaded.id), unauthorized);

  // Keep connector processes alive while recreating the listener with the same volume.
  // Both clients must reconnect without registering replacement device tokens.
  await h.restart();
  assert.equal((await vm.inbox(0, 0)).messages[0].id, sent.id);
  assert.equal((await laptop.file(uploaded.id)).sha256, uploaded.sha256);
  assert.equal((await laptop.request(receivedRequest.id, 0)).status, 'completed');
  const afterRestart = await remote(laptop, input('vm', 'read', 'received.txt'));
  assert.equal(afterRestart.status, 'completed');
  assert.equal((afterRestart.result as ReadResult).content, received.content);
  const restartedDownload = join(h.directory, 'after-restart.bin');
  await vm.download(uploaded.id, restartedDownload);
  assert.deepEqual(await readFile(restartedDownload), bytes);

  await vm.deleteFile(replyFile.id);
  await assert.rejects(() => laptop.file(replyFile.id), error => error instanceof BridgeError && error.status === 404);
  const revocation = await fetch(`${h.url}/v1/devices/vm`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.ok(revocation.ok);
  await assert.rejects(() => vm.file(uploaded.id), unauthorized);
  const revokedDownload = await fetch(`${h.url}/v1/files/${uploaded.id}/content`, { headers: { Authorization: `Bearer ${vmRegistration.token}` } });
  assert.ok([401, 403].includes(revokedDownload.status), 'Revoked tokens cannot download attachment bytes');
  await revokedDownload.body?.cancel();
});

test('offline devices are reported and unanswered remote requests expire over HTTP', { timeout: 10000 }, async t => {
  const h = await harness(t, { offlineMs: 300, requestTtlMs: 650 });
  const laptop = (await h.register('laptop')).client;
  const vm = (await h.register('vm')).client;
  await vm.heartbeat(['work']);
  assert.equal((await laptop.devices()).find(device => device.name === 'vm')?.online, true);
  const created = await laptop.createRequest(input('vm', 'read', 'unavailable.txt'));
  await eventually(() => laptop.devices(), devices => devices.find(device => device.name === 'vm')?.online === false);
  await assert.rejects(() => laptop.createRequest(input('vm', 'read', 'unavailable.txt')), error => error instanceof BridgeError && error.status === 503 && error.code === 'device_offline');
  const expired = await eventually(() => laptop.request(created.id, 1), request => request.status === 'expired');
  assert.equal(expired.result, undefined);
  assert.equal(expired.error?.code, 'request_timeout');
});
