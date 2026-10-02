#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { DaemonClient, daemonInfo } from '../dist/client/daemon-client.js';

const { values } = parseArgs({ options: { channel: { type: 'string' }, session: { type: 'string' }, samples: { type: 'string', default: '20' }, warmup: { type: 'string', default: '2' }, deadline: { type: 'string', default: '5000' }, output: { type: 'string' } } });
const number = (value, min, max) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`Expected an integer between ${min} and ${max}`); return n; };
const count = number(values.samples, 1, 50), warmup = number(values.warmup, 0, 10), deadline = number(values.deadline, 1, 30000);
if (!/^(0|[1-9][0-9]{0,63})$/.test(values.channel ?? '')) throw Error('--channel is required');
const rpc = new DaemonClient(await daemonInfo());
const status = await rpc.status();
const session = values.session ?? status.channels.find(value => value.channel === values.channel)?.session_id;
if (!session) throw Error('Pair both resident clients on this channel before benchmarking');
const attempts = [];
for (let i = 0; i < count + warmup; i++) {
  const started = performance.now();
  const result = await rpc.pair(values.channel, session, deadline);
  if (i >= warmup) attempts.push({ caller_ms: performance.now() - started, verified: result.verified, proof_ms: result.proof_round_trip_ms ?? null });
}
function stats(values) { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b), q = p => sorted[Math.ceil(sorted.length*p)-1]; return { min: sorted[0], p50: q(.5), p95: q(.95), max: sorted.at(-1) }; }
const result = { metric: 'resident_fresh_nonce_proof_ms', boundary: 'warm local RPC through durable relay mailbox and peer runtime; excludes Node/model/UI startup', channel: values.channel, sample_count: count, warmup_count: warmup, failures: attempts.filter(value => !value.verified).length, caller_ms: stats(attempts.map(value => value.caller_ms)), successful_proof_ms: stats(attempts.filter(value => value.verified).map(value => value.proof_ms)), attempts };
if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
if (result.failures) process.exitCode = 1;
