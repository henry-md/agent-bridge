// Synthetic nonce echoes on a dedicated channel; never runs an AI model or shares files.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readConfig, updateConfig } from '../dist/client/config.js';
import { RelayClient } from '../dist/client/relay.js';
import { channelId, joinChannel, leaveChannel, requireChannelSession, watchChannel } from '../dist/client/channel.js';

const { values } = parseArgs({ options: {
  role: { type: 'string' }, channel: { type: 'string' }, mode: { type: 'string', default: 'client' },
  samples: { type: 'string', default: '20' }, warmup: { type: 'string', default: '2' }, timeout: { type: 'string', default: '30' }, label: { type: 'string', default: '' },
} });
if (!['echo', 'measure'].includes(values.role) || !['client', 'cli'].includes(values.mode)) throw new Error('Use --role echo|measure --channel NUMBER --mode client|cli');
const channel = channelId(values.channel ?? '');
const samples = Number(values.samples), warmup = Number(values.warmup);
const timeout = Number(values.timeout);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100 || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 10) throw new Error('Use 1–100 samples and 0–10 warmup exchanges');
if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30) throw new Error('Use a sample timeout of 1–30 seconds');
let config = await readConfig();
if (Object.keys(config.channel_sessions?.[channel]?.sessions ?? {}).length) throw new Error('Use an unused benchmark channel to avoid replacing an active chat');
const client = new RelayClient(config.url, config.token);
const session = randomUUID(), run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const prefix = 'bridge-latency-';
async function command(...args) {
  const { stdout } = await run(process.execPath, [cli, ...args], { timeout: 65_000 });
  return JSON.parse(stdout);
}
let joined = false, identity;
async function send(value) {
  const text = JSON.stringify(value);
  if (values.mode === 'cli') return command('send', '--channel', channel, '--session', session, '--text', text);
  return client.sendChannel(channel, { session_id: session, generation: identity.generation, text, file_ids: [] });
}
async function inbox(seconds = timeout) {
  if (values.mode === 'cli') return command('watch', '--channel', channel, '--session', session, '--timeout', String(Math.max(1, Math.ceil(seconds))));
  return watchChannel(client, config, channel, session, seconds);
}
async function acknowledge(cursor) {
  if (values.mode === 'cli') return command('channel', 'ack', channel, String(cursor), '--session', session);
  return client.acknowledgeChannel(channel, session, identity.generation, cursor);
}
function inputs(page) {
  return page.messages.map(message => {
    const value = JSON.parse(message.text);
    if (!value.type?.startsWith(prefix) || message.file_ids.length) throw new Error('Non-benchmark message: refusing to acknowledge it');
    return value;
  });
}
try {
  const started = performance.now(), deadline = Date.now() + 10 * 60_000;
  let status;
  do {
    joined = true; status = await joinChannel(client, config, channel, session, 25);
  } while (status.status !== 'connected' && Date.now() < deadline);
  if (status.status !== 'connected') throw new Error('Benchmark peer did not join within ten minutes');
  config = await readConfig(); identity = requireChannelSession(config, channel, session);
  const metadata = { channel, mode: values.mode, label: values.label, platform: process.platform, node: process.version, join_connected_ms: performance.now() - started };
  output({ type: 'ready', role: values.role, ...metadata });
  if (values.role === 'echo') {
    let stopped = false;
    while (!stopped && Date.now() < deadline) {
      const page = await inbox();
      for (const value of inputs(page)) {
        if (value.type === `${prefix}ping`) await send({ type: `${prefix}pong`, nonce: value.nonce });
        else if (value.type === `${prefix}stop`) { await send({ type: `${prefix}stopped`, nonce: value.nonce }); stopped = true; }
        else throw new Error('Unexpected benchmark request');
      }
      if (page.messages.length) await acknowledge(page.cursor);
    }
    if (!stopped) throw new Error('Benchmark controller did not stop the responder');
    output({ type: 'stopped', ...metadata });
  } else {
    const durations = [], failures = [];
    for (let index = 0; index < samples + warmup; index++) {
      const nonce = randomUUID(), started = performance.now();
      // Receive and submit concurrently on the same clock; no cross-machine timestamp subtraction.
      const pending = inbox().then(page => ({ page, received_ms: performance.now() - started }));
      await send({ type: `${prefix}ping`, nonce });
      const received = await pending;
      let page = received.page, matched = inputs(page).some(value => value.type === `${prefix}pong` && value.nonce === nonce);
      let receivedMs = matched ? received.received_ms : undefined;
      if (page.messages.length) await acknowledge(page.cursor);
      while (!matched && !page.timed_out && performance.now() - started < timeout * 1000) {
        page = await inbox((timeout * 1000 - (performance.now() - started)) / 1000); matched = inputs(page).some(value => value.type === `${prefix}pong` && value.nonce === nonce);
        if (matched) receivedMs = performance.now() - started;
        if (page.messages.length) await acknowledge(page.cursor);
      }
      const cycle_ms = performance.now() - started, duration_ms = receivedMs ?? cycle_ms;
      if (!matched) failures.push({ index, timeout: true });
      else if (index >= warmup) durations.push(duration_ms);
      output({ type: 'sample', index, warmup: index < warmup, duration_ms, cycle_ms, matched });
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
    output({ type: 'summary', metric: 'message_round_trip_ms', boundary: 'before ping submission through matching pong consumption; no AI processing; acknowledgment cost is reported separately as cycle_ms', ...metadata,
      samples: durations.length, warmup, failures, p50_ms: percentile(0.5), p95_ms: percentile(0.95), min_ms: sorted[0] ?? null, max_ms: sorted.at(-1) ?? null });
    const nonce = randomUUID(), stopDeadline = performance.now() + timeout * 1000;
    const pending = inbox(); await send({ type: `${prefix}stop`, nonce });
    let page = await pending, stopped = false;
    while (true) {
      stopped = inputs(page).some(value => value.type === `${prefix}stopped` && value.nonce === nonce);
      if (page.messages.length) await acknowledge(page.cursor);
      if (stopped || page.timed_out || performance.now() >= stopDeadline) break;
      page = await inbox((stopDeadline - performance.now()) / 1000);
    }
    if (!stopped) throw new Error('Responder did not confirm stop');
    if (failures.length) throw new Error('Benchmark completed with timed-out exchanges; see summary failures');
  }
} finally {
  if (joined) { try { await leaveChannel(client, await readConfig(), channel, session); } catch {} }
  // A failed join can reserve local state before it has a generation to leave.
  try { await updateConfig(current => {
    if (!current) throw new Error('Configuration was removed during benchmark cleanup');
    if (current.url !== config.url || current.device !== config.device || current.token !== config.token) return current;
    const saved = current.channel_sessions?.[channel];
    if (!saved?.sessions[session]) return current;
    const sessions = { ...saved.sessions }; delete sessions[session];
    return { ...current, channel_sessions: { ...current.channel_sessions, [channel]: { ...saved, sessions } } };
  }); } catch {}
}
