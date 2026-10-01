// Explicit live Windows smoke test. Uses only synthetic messages and a temporary device token.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const { BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_DEVICE, BRIDGE_CHANNEL } = process.env;
if (!BRIDGE_URL || !BRIDGE_TOKEN || !BRIDGE_DEVICE || !BRIDGE_CHANNEL) throw new Error('Bridge test environment is incomplete');
const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-channel-'));
const session = randomUUID();
const environment = { ...process.env, BRIDGE_CONFIG: join(directory, 'config.json'), CODEX_THREAD_ID: session };
const run = promisify(execFile);
const cli = resolve('dist/cli.js');
async function command(...args) {
  const { stdout } = await run(process.execPath, [cli, ...args], { env: environment, timeout: 50_000 });
  return JSON.parse(stdout);
}
const channelArgs = ['--channel', BRIDGE_CHANNEL, '--session', session];
const send = value => command('send', ...channelArgs, '--text', JSON.stringify(value));
let joined = false;
let connected;
try {
  await command('config', 'set', '--url', BRIDGE_URL, '--device', BRIDGE_DEVICE, '--token-env', 'BRIDGE_TOKEN');
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    connected = await command('channel', 'join', BRIDGE_CHANNEL, '--session', session, '--wait', '25');
    joined = true;
    if (connected.status === 'connected') break;
  }
  if (connected?.status !== 'connected') throw new Error('No peer completed the handshake');
  const ready = { type: 'windows-channel-ready', platform: process.platform, node: process.version, channel: connected.channel, generation: connected.generation, confirmation: connected.confirmation, secret_word: connected.secret_word };
  console.log(JSON.stringify(ready));
  await send(ready);
  let stopped = false;
  while (Date.now() < deadline && !stopped) {
    const page = await command('inbox', ...channelArgs, '--wait', '25');
    for (const message of page.messages) {
      const input = JSON.parse(message.text);
      if (input.type === 'ping') await send({ type: 'pong', nonce: input.nonce, channel: BRIDGE_CHANNEL, platform: process.platform });
      else if (input.type === 'stop') {
        await send({ type: 'windows-channel-stopped', channel: BRIDGE_CHANNEL, confirmation: connected.confirmation });
        stopped = true;
      } else throw new Error('Unexpected smoke-test command');
    }
    await command('channel', 'ack', BRIDGE_CHANNEL, String(page.cursor), '--session', session);
  }
  if (!stopped) throw new Error('Controller did not finish the channel test');
} finally {
  if (joined) await command('channel', 'leave', BRIDGE_CHANNEL, '--session', session).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
