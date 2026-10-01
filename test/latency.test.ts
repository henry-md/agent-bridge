import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { RelayClient } from '../src/client/relay.js';
import { createServer } from '../src/server/server.js';

test('real benchmark measures nonce replies in both modes and leaves the test sessions', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-latency-'));
  const adminToken = 'latency-test-admin-token-at-least-32-bytes';
  const app = await createServer({ dataDir: join(directory, 'data'), adminToken, logger: false });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const admin = new RelayClient(url, adminToken), run = promisify(execFile);
  const paths: string[] = [];
  for (const name of ['measure', 'echo']) {
    const device = await admin.register(name), path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify({ url, token: device.token, device: name, roots: {} })); paths.push(path);
  }
  for (const mode of ['client', 'cli']) {
    const channel = mode === 'client' ? '5041' : '5042';
    const task = (role: string, config: string) => run(process.execPath, ['scripts/benchmark-channels.mjs', '--role', role, '--mode', mode, '--channel', channel, '--samples', '3', '--warmup', '1'], {
      env: { ...process.env, BRIDGE_CONFIG: config }, timeout: 40_000,
    });
    const [controller, responder] = await Promise.all([task('measure', paths[0]), task('echo', paths[1])]);
    const records = controller.stdout.trim().split('\n').map(line => JSON.parse(line));
    const summary = records.find(record => record.type === 'summary');
    assert.equal(summary.samples, 3); assert.deepEqual(summary.failures, []); assert.equal(summary.mode, mode);
    assert.ok(summary.p50_ms > 0); assert.ok(summary.p95_ms >= summary.p50_ms);
    for (const sample of records.filter(record => record.type === 'sample')) {
      assert.equal(sample.matched, true); assert.ok(sample.cycle_ms >= sample.duration_ms);
    }
    assert.equal(JSON.parse(responder.stdout.trim().split('\n').at(-1)!).type, 'stopped');
    assert.ok(!controller.stdout.includes(adminToken));
    for (const path of paths) assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).channel_sessions[channel].sessions, {});
  }
});
