// Explicitly dispatched cloud smoke test; never handles real user files.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RelayClient } from '../dist/client/relay.js';
import { runConnector } from '../dist/client/connector.js';

const { BRIDGE_URL: url, BRIDGE_TOKEN: token, BRIDGE_DEVICE: device, BRIDGE_PEER: peer } = process.env;
if (!url || !token || !device || !peer) throw new Error('BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_DEVICE, BRIDGE_PEER are required');
const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-windows-'));
const controller = new AbortController();
const client = new RelayClient(url, token);
await writeFile(join(directory, 'windows-context.txt'), 'Windows context: the reserve is 200 dollars.\n');
const connector = runConnector(client, device, { work: directory }, { signal: controller.signal, onError: e => console.error(JSON.stringify({ connector_error: e.code })) });
const send = (text, file_ids = []) => client.send({ to: peer, text: JSON.stringify(text), file_ids });
let cursor = 0;
let success = false;
try {
  await client.heartbeat(['work']);
  await send({ type: 'windows-ready', device, platform: process.platform, node: process.version });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const page = await client.inbox(cursor, 25);
    cursor = page.cursor;
    for (const message of page.messages) {
      if (message.from !== peer) continue;
      let command;
      try { command = JSON.parse(message.text); } catch { continue; }
      if (command.type === 'windows-transfer') {
        if (message.file_ids.length !== 1) throw new Error('Transfer test expects one attachment');
        const target = join(directory, 'received-from-macos.bin');
        await client.download(message.file_ids[0], target);
        const bytes = await readFile(target);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (command.sha256 !== sha256) throw new Error('Transfer checksum differs from sender expectation');
        const uploaded = await client.upload(target);
        await send({ type: 'windows-transfer-verified', platform: process.platform, size: bytes.length, sha256 }, [uploaded.id]);
        await rm(target);
        success = true;
      } else if (command.type === 'windows-ping') {
        await send({ type: 'windows-pong', nonce: command.nonce });
      } else if (command.type === 'windows-stop') {
        await send({ type: 'windows-stopped', transfer_verified: success });
        console.log(JSON.stringify({ platform: process.platform, transfer_verified: success }));
        if (!success) throw new Error('No verified file round trip completed');
        process.exitCode = 0;
        controller.abort();
        break;
      }
    }
    if (controller.signal.aborted) break;
  }
  if (!controller.signal.aborted) throw new Error('Smoke test timed out waiting for controller');
} catch (error) {
  await send({ type: 'windows-failure', message: error.message }).catch(() => {});
  throw error;
} finally {
  controller.abort();
  await connector;
  await rm(directory, { recursive: true, force: true });
}
