import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { runConnector } from '../src/client/connector.js';
import { executeFileRequest, validateRelativePath } from '../src/client/filesystem.js';
import { RelayClient, validateRelayUrl } from '../src/client/relay.js';
import { writeConfig, readConfig, updateConfig } from '../src/client/config.js';
import { BridgeError, MAX_TEXT_BYTES, requestInputSchema, type FileInfo } from '../src/shared/protocol.js';

async function fixture() { const base = await mkdtemp(join(tmpdir(), 'bridge-client-')); const root = join(base, 'root'); await mkdir(root); return { base, root }; }
const request = (operation: 'list' | 'read' | 'search', path = '', query?: string, limit = 100) => requestInputSchema.parse({ to: 'vm', root: 'work', operation, path, query, limit });
const errorCode = (code: string) => (error: unknown) => error instanceof BridgeError && error.code === code;
async function httpFixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
function metadata(data: Buffer): FileInfo { return { id: randomUUID(), name: 'report.bin', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), content_type: 'application/octet-stream', uploaded_by: 'laptop', created_at: new Date().toISOString() }; }

test('relay URL validation allows HTTPS and loopback only, without credential-bearing URL parts', () => {
  assert.equal(validateRelayUrl('https://bridge.example/'), 'https://bridge.example');
  assert.equal(validateRelayUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(validateRelayUrl('http://[::1]:3000'), 'http://[::1]:3000');
  for (const url of ['http://192.168.1.1', 'http://example.com', 'ftp://bridge.example', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#secret', 'https://example.com/subpath']) assert.throws(() => validateRelayUrl(url), errorCode('INVALID_URL'));
});

test('native and Windows unsafe paths are denied on every platform', () => {
  for (const path of ['../secret', 'a/../secret', './secret', '/etc/passwd', '\\server\\share', 'C:\\secret', 'C:secret', 'a\\..\\secret', 'file.txt:stream', 'a\0b', 'NUL', 'con.txt', 'lpt1.log', 'dir./file', 'dir /file']) assert.throws(() => validateRelativePath(path), errorCode('PATH_FORBIDDEN'));
  for (const path of ['.git/config', 'node_modules/file', '.env', '.env.local', '.aws/credentials', 'credentials.json', 'key.pem', '.ssh/id_rsa', '.agent-bridge/config.json']) assert.throws(() => validateRelativePath(path), errorCode('PATH_EXCLUDED'));
  assert.deepEqual(validateRelativePath('src\\index.ts'), ['src', 'index.ts']);
});

test('connector provides source metadata, literal search and bounded listing', async () => {
  const { base, root } = await fixture();
  try {
    await writeFile(join(root, 'one.ts'), 'first line\n[needle] value\n'); await writeFile(join(root, 'two.ts'), '[needle] another'); await writeFile(join(root, '.env'), 'secret=needle');
    const read = await executeFileRequest('vm', { work: root }, request('read', 'one.ts'));
    assert.ok('content' in read); assert.equal(read.content, 'first line\n[needle] value\n'); assert.equal(read.path, 'one.ts'); assert.equal(read.device, 'vm'); assert.equal(read.root, 'work'); assert.equal(read.truncated, false); assert.ok(read.modified_at);
    const list = await executeFileRequest('vm', { work: root }, request('list', '', undefined, 1));
    assert.ok('entries' in list); assert.equal(list.entries.length, 1); assert.equal(list.truncated, true); assert.equal(list.entries[0].name, 'one.ts');
    const search = await executeFileRequest('vm', { work: root }, request('search', '', '[needle]'));
    assert.ok('matches' in search); assert.equal(search.matches.length, 2); assert.equal(search.matches[0].line, 2); assert.equal(search.matches[0].path, 'one.ts');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('connector denies symlink escapes, skips escaped listing entries and avoids recursive cycles', async () => {
  const { base, root } = await fixture();
  try {
    await writeFile(join(base, 'outside.txt'), 'outside'); await symlink(join(base, 'outside.txt'), join(root, 'escape.txt')); await symlink(root, join(root, 'cycle'));
    await writeFile(join(root, 'safe.txt'), 'needle'); await writeFile(join(root, '.env'), 'hidden'); await symlink(join(root, '.env'), join(root, 'alias.txt'));
    await assert.rejects(executeFileRequest('vm', { work: root }, request('read', 'escape.txt')), errorCode('PATH_FORBIDDEN'));
    await assert.rejects(executeFileRequest('vm', { work: root }, request('read', 'alias.txt')), errorCode('PATH_EXCLUDED'));
    const list = await executeFileRequest('vm', { work: root }, request('list')); assert.ok('entries' in list); assert.ok(!list.entries.some(x => x.name === 'escape.txt' || x.name === 'alias.txt'));
    const search = await executeFileRequest('vm', { work: root }, request('search', '', 'needle')); assert.ok('matches' in search); assert.equal(search.matches.length, 1);
    await assert.rejects(executeFileRequest('vm', { work: root }, request('read', 'missing.txt')), error => error instanceof BridgeError && error.code === 'PATH_NOT_FOUND' && !error.message.includes(root));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('connector caps text, marks truncation and rejects binary or invalid UTF-8', async () => {
  const { base, root } = await fixture();
  try {
    await writeFile(join(root, 'large.txt'), 'a' + 'é'.repeat(MAX_TEXT_BYTES)); await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2])); await writeFile(join(root, 'invalid.bin'), Buffer.from([0xff, 0xfe]));
    const read = await executeFileRequest('vm', { work: root }, request('read', 'large.txt')); assert.ok('content' in read); assert.equal(read.truncated, true); assert.ok(Buffer.byteLength(read.content) <= MAX_TEXT_BYTES); assert.ok(!read.content.includes('�'));
    for (const name of ['binary.bin', 'invalid.bin']) await assert.rejects(executeFileRequest('vm', { work: root }, request('read', name)), errorCode('BINARY_FILE'));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('custom local configuration is protected and uses restrictive permissions outside Git', async () => {
  const { base, root } = await fixture(); const previous = process.env.BRIDGE_CONFIG;
  try {
    process.env.BRIDGE_CONFIG = join(root, 'local-config.json'); await writeConfig({ url: 'https://bridge.example', token: 'device-secret', device: 'vm', roots: { work: root } });
    assert.equal((await readConfig()).token, 'device-secret'); if (process.platform !== 'win32') assert.equal((await stat(process.env.BRIDGE_CONFIG)).mode & 0o777, 0o600);
    await assert.rejects(executeFileRequest('vm', { work: root }, request('read', 'local-config.json')), errorCode('PATH_EXCLUDED'));
    await mkdir(join(base, 'repo')); await mkdir(join(base, 'repo', '.git')); await mkdir(join(base, 'repo', 'sub')); await symlink(join(base, 'repo', 'sub'), join(base, 'alias'));
    process.env.BRIDGE_CONFIG = join(base, 'alias', 'config.json'); await assert.rejects(writeConfig({ url: 'https://bridge.example', token: 'secret', roots: {} }), errorCode('CONFIG_IN_GIT'));
  } finally { if (previous === undefined) delete process.env.BRIDGE_CONFIG; else process.env.BRIDGE_CONFIG = previous; await rm(base, { recursive: true, force: true }); }
});

test('message transient retry keeps the idempotency key and HTTP 204 is successful', async () => {
  const keys: string[] = []; let calls = 0;
  const server = await httpFixture((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    keys.push(String(req.headers['idempotency-key'])); req.resume();
    if (++calls === 1) { res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { id: 'message-1', text: 'hello' } }));
  });
  try {
    const client = new RelayClient(server.url, 'token'); const message = await client.send({ to: 'vm', text: 'hello', file_ids: [] }, 'fixed-key'); assert.equal(message.id, 'message-1'); assert.deepEqual(keys, ['fixed-key', 'fixed-key']); assert.deepEqual(await client.revoke('vm'), {}); assert.deepEqual(await client.deleteFile('file-id'), {});
  } finally { await server.close(); }
});

test('streamed multipart upload sends exact bytes, authenticates and is not retried after rejection', async () => {
  const { base } = await fixture(); const data = Buffer.from('binary attachment\0hello'); const path = join(base, 'report.bin'); await writeFile(path, data); const info = metadata(data); let calls = 0;
  const server = await httpFixture((req, res) => {
    calls++; assert.equal(req.headers.authorization, 'Bearer token'); const parts: Buffer[] = []; req.on('data', chunk => parts.push(chunk)); req.on('end', () => {
      const body = Buffer.concat(parts); assert.equal(Number(req.headers['content-length']), body.length); const boundary = String(req.headers['content-type']).split('boundary=')[1]; const start = body.indexOf('\r\n\r\n') + 4; const end = body.lastIndexOf(`\r\n--${boundary}--\r\n`); assert.deepEqual(body.subarray(start, end), data); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ file: info }));
    });
  });
  try { assert.deepEqual(await new RelayClient(server.url, 'token').upload(path), info); assert.equal(calls, 1); } finally { await server.close(); await rm(base, { recursive: true, force: true }); }
  let rejectedCalls = 0; const rejected = await httpFixture((req, res) => { rejectedCalls++; req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'unavailable' } })); });
  const retryFixture = await fixture(); const small = join(retryFixture.base, 'small'); await writeFile(small, 'small');
  try { await assert.rejects(new RelayClient(rejected.url, 'token').upload(small), errorCode('UNAVAILABLE')); assert.equal(rejectedCalls, 1); } finally { await rejected.close(); await rm(retryFixture.base, { recursive: true, force: true }); }
});

test('downloads verify checksum, publish atomically without overwrite, and clean corrupt partials', async () => {
  const { base } = await fixture(); const data = Buffer.from('verified file'); const info = metadata(data); let corrupt = false;
  const server = await httpFixture((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer token');
    if (req.url?.endsWith('/content')) { res.writeHead(200).end(corrupt ? Buffer.from('corrupt file!') : data); }
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ file: info }));
  });
  try {
    const client = new RelayClient(server.url, 'token'); const target = join(base, 'download.bin'); await client.download(info.id, target); assert.deepEqual(await readFile(target), data);
    await assert.rejects(client.download(info.id, target), errorCode('OUTPUT_EXISTS')); assert.deepEqual(await readFile(target), data);
    corrupt = true; await assert.rejects(client.download(info.id, join(base, 'corrupt.bin')), errorCode('CHECKSUM_MISMATCH')); assert.ok(!(await readdir(base)).some(name => name.includes('.part') || name === 'corrupt.bin'));
  } finally { await server.close(); await rm(base, { recursive: true, force: true }); }
});

test('Windows config replacement survives a temporary file lock and preserves credentials on exhaustion', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const { base } = await fixture(); const previous = process.env.BRIDGE_CONFIG;
  try {
    const path = join(base, 'config.json'); process.env.BRIDGE_CONFIG = path;
    await writeConfig({ url: 'https://bridge.example', token: 'token', roots: {} });
    async function hold() {
      const script = '$s = [System.IO.File]::Open($env:BRIDGE_LOCK_TEST_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite); [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null; $s.Dispose()';
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, BRIDGE_LOCK_TEST_PATH: path } });
      const done = once(child, 'exit'); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      try {
        const ready = await Promise.race([once(child.stdout, 'data'), done.then(() => { throw new Error(`Lock holder exited: ${stderr}`); })]);
        assert.match(String(ready[0]), /ready/);
      } catch (error) { child.kill(); await done; throw error; }
      return { done, release: () => child.stdin.end('release\n') };
    }
    const temporaryLock = await hold();
    const updating = updateConfig(current => ({ ...current!, device: 'vm' }));
    try {
      // Release only after publication has reached the blocked rename. Fixed
      // sleeps can expire before slower Windows path checks reach this point.
      await Promise.race([updating.then(() => { throw new Error('Update bypassed the held file lock'); }), (async () => {
        while (!(await readdir(base)).some(name => name.endsWith('.tmp'))) await new Promise(resolve => setTimeout(resolve, 10));
      })()]);
    } finally { temporaryLock.release(); await temporaryLock.done; }
    await updating;
    assert.equal((await readConfig()).device, 'vm'); assert.equal((await readConfig()).token, 'token');
    const held = await hold();
    try { await assert.rejects(updateConfig(current => ({ ...current!, device: 'replacement' })), (error: unknown) => ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')); }
    finally { held.release(); await held.done; }
    assert.equal((await readConfig()).device, 'vm'); assert.equal((await readConfig()).token, 'token');
    assert.deepEqual((await readdir(base)).filter(name => name !== 'root'), ['config.json']);
  } finally { if (previous === undefined) delete process.env.BRIDGE_CONFIG; else process.env.BRIDGE_CONFIG = previous; await rm(base, { recursive: true, force: true }); }
});

test('concurrent config updates merge fields under a lock', async () => {
  const { base } = await fixture(); const previous = process.env.BRIDGE_CONFIG;
  try {
    process.env.BRIDGE_CONFIG = join(base, 'config.json'); await writeConfig({ url: 'https://bridge.example', token: 'token', roots: {} });
    await Promise.all([
      updateConfig(current => ({ ...current!, roots: { ...current!.roots, first: base } })),
      updateConfig(current => ({ ...current!, inbox_cursor: 42 })),
      updateConfig(current => ({ ...current!, roots: { ...current!.roots, second: base } })),
    ]);
    const config = await readConfig(); assert.equal(config.inbox_cursor, 42); assert.equal(config.roots.first, base); assert.equal(config.roots.second, base);
  } finally { if (previous === undefined) delete process.env.BRIDGE_CONFIG; else process.env.BRIDGE_CONFIG = previous; await rm(base, { recursive: true, force: true }); }
});

test('CLI inbox explicit replay preserves cursor and polling merges current config fields', async () => {
  const { base } = await fixture(); const path = join(base, 'config.json'); let updateDuringPoll = false;
  const server = await httpFixture((req, res) => {
    req.resume(); void (async () => {
      if (updateDuringPoll) {
        const config = JSON.parse(await readFile(path, 'utf8')); config.roots.newroot = base; await writeFile(path, JSON.stringify(config));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [], cursor: 20 }));
    })();
  });
  try {
    await writeFile(path, JSON.stringify({ url: server.url, token: 'token', device: 'vm', roots: {}, inbox_cursor: 5 }));
    const run = promisify(execFile); const args = ['--import', 'tsx', 'src/cli.ts', 'inbox', '--wait', '0']; const options = { cwd: process.cwd(), env: { ...process.env, BRIDGE_CONFIG: path } };
    const explicit = await run(process.execPath, [...args, '--after', '10'], options); assert.equal(JSON.parse(explicit.stdout).cursor, 20); assert.equal(JSON.parse(await readFile(path, 'utf8')).inbox_cursor, 5);
    updateDuringPoll = true; await run(process.execPath, args, options); const config = JSON.parse(await readFile(path, 'utf8')); assert.equal(config.inbox_cursor, 20); assert.equal(config.roots.newroot, base);
  } finally { await server.close(); await rm(base, { recursive: true, force: true }); }
});

test('connector shutdown cancels both heartbeat and claim on an unresponsive relay', async () => {
  const server = createServer(req => req.resume()); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address() as { port: number };
  const controller = new AbortController(); const started = Date.now(); const connector = runConnector(new RelayClient(`http://127.0.0.1:${address.port}`, 'token'), 'vm', {}, { signal: controller.signal, heartbeatMs: 100, pollSeconds: 25 });
  const timer = setTimeout(() => controller.abort(), 50);
  try { await connector; assert.ok(Date.now() - started < 1000); } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
