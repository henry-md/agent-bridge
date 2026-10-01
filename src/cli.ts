#!/usr/bin/env node
import { Command } from 'commander';
import { cp, lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, messageInputSchema, nameSchema, requestInputSchema } from './shared/protocol.js';
import { configPath, readConfig, tokenFromEnv, updateConfig, type BridgeConfig } from './client/config.js';
import { RelayClient, validateRelayUrl } from './client/relay.js';
import { runConnector } from './client/connector.js';
import { channelId, channelResult, channelStatus, joinChannel, leaveChannel, requireChannelSession, sendChannelMessage, watchChannel } from './client/channel.js';

const program = new Command().name('bridge').description('Exchange messages and file context through your private Railway relay').version('0.1.0');
program.configureOutput({ outputError: () => {} });
program.exitOverride();
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const integer = (raw: string) => { const value = Number(raw); if (!Number.isSafeInteger(value) || value < 0) throw new BridgeError(0, 'INVALID_ARGUMENT', 'Expected a nonnegative integer'); return value; };
const wait = (raw: string) => { const value = integer(raw); if (value > 25) throw new BridgeError(0, 'INVALID_ARGUMENT', 'Wait must be between 0 and 25 seconds'); return value; };
async function localClient() { const config = await readConfig(); return { config, client: new RelayClient(config.url, config.token!) }; }
const configuration = program.command('config').description('Configure local credentials outside Git');
configuration.command('set').requiredOption('--url <url>', 'Relay HTTPS origin').option('--token-env <variable>', 'Environment variable holding a device token').option('--device <name>', 'Device name').action(async options => {
  const url = validateRelayUrl(options.url);
  const device = options.device ? nameSchema.parse(options.device) : undefined;
  const token = options.tokenEnv ? tokenFromEnv(options.tokenEnv) : undefined;
  const config = await updateConfig(old => {
    const next: BridgeConfig = old?.url === url ? { ...old } : { url, roots: {} };
    if ((token && token !== next.token) || (device && device !== next.device)) delete next.channel_sessions;
    if (token) { next.token = token; next.inbox_cursor = 0; }
    if (device) next.device = device;
    return next;
  });
  output({ configured: true, path: configPath(), url: config.url, device: config.device ?? null, token_configured: !!config.token });
});
configuration.command('show').action(async () => { const config = await readConfig(false); output({ ...config, token: config.token ? '[REDACTED]' : undefined }); });
program.command('register').argument('<name>').option('--token-env <variable>', 'Environment variable holding admin token', 'ADMIN_TOKEN').action(async (name, options) => {
  nameSchema.parse(name); const config = await readConfig(false); const client = new RelayClient(config.url, tokenFromEnv(options.tokenEnv)); const registration = await client.register(name);
  await updateConfig(current => { if (!current || current.url !== config.url || current.token !== config.token || current.device !== config.device) throw new BridgeError(0, 'CONFIG_CHANGED', 'Relay configuration changed during registration'); const next = { ...current, device: name, token: registration.token, inbox_cursor: 0 }; delete next.channel_sessions; return next; }); output({ device: registration.device, token_saved: true });
});
program.command('revoke').argument('<name>').option('--token-env <variable>', 'Environment variable holding admin token', 'ADMIN_TOKEN').action(async (name, options) => { nameSchema.parse(name); const config = await readConfig(false); output(await new RelayClient(config.url, tokenFromEnv(options.tokenEnv)).revoke(name)); });
const roots = program.command('root').description('Allow read-only access to an explicit folder alias');
roots.command('add').argument('<alias>').argument('<path>').action(async (alias, path) => {
  nameSchema.parse(alias); const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) throw new BridgeError(0, 'NOT_A_DIRECTORY', 'Shared roots must be directories');
  await updateConfig(config => { if (!config) throw new BridgeError(0, 'CONFIG_REQUIRED', 'Configure the relay first'); return { ...config, roots: { ...config.roots, [alias]: canonical } }; }); output({ root: alias, path: canonical, restart_connector: true });
});
roots.command('remove').argument('<alias>').action(async alias => { await updateConfig(config => { if (!config) throw new BridgeError(0, 'CONFIG_REQUIRED', 'Configure the relay first'); const roots = { ...config.roots }; delete roots[alias]; return { ...config, roots }; }); output({ removed: alias, restart_connector: true }); });
program.command('devices').action(async () => { const { client } = await localClient(); output({ devices: await client.devices() }); });
program.command('connect').description('Run the outbound file connector; stop with Ctrl+C').action(async () => {
  const { config, client } = await localClient(); if (!config.device) throw new BridgeError(0, 'DEVICE_REQUIRED', 'Set the device name before connecting');
  const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  output({ connecting: config.device, roots: Object.keys(config.roots) });
  try { await runConnector(client, config.device, config.roots, { signal: controller.signal, onError: error => process.stderr.write(`${JSON.stringify({ error })}\n`) }); } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
});
for (const operation of ['read', 'list', 'search'] as const) {
  const command = program.command(operation).requiredOption('--device <name>').requiredOption('--root <alias>').option('--path <relative-path>', 'Relative path within shared folder', '').option('--limit <count>', 'Maximum list/search results', integer, 100).option('--idempotency-key <key>');
  if (operation === 'search') command.requiredOption('--query <text>', 'Literal text to find');
  command.action(async options => {
    const { client } = await localClient(); const input = requestInputSchema.parse({ to: options.device, operation, root: options.root, path: options.path, limit: options.limit, ...(options.query ? { query: options.query } : {}) });
    let request = await client.createRequest(input, options.idempotencyKey); const deadline = Date.now() + 70_000;
    while ((request.status === 'pending' || request.status === 'running') && Date.now() < deadline) request = await client.request(request.id, 25);
    if (request.status === 'completed') output(request.result);
    else throw new BridgeError(0, request.error?.code ?? 'REQUEST_TIMEOUT', request.error?.message ?? `Remote request ${request.id} did not complete`);
  });
}
const channels = program.command('channel').description('Pair two chat sessions on a numeric channel');
channels.command('join').argument('<channel>', 'Canonical numeric channel', channelId).option('--session <uuid>', 'Chat session UUID; defaults to CODEX_THREAD_ID or a saved per-channel UUID').option('--wait <seconds>', 'Wait for the mutual handshake, 0–25 seconds', wait, 25).action(async (channel, options) => {
  const { config, client } = await localClient(); output(channelResult(await joinChannel(client, config, channel, options.session, options.wait)));
});
channels.command('status').argument('<channel>', 'Canonical numeric channel', channelId).option('--session <uuid>', 'Chat session UUID').option('--wait <seconds>', 'Long poll wait, 0–25 seconds', wait, 0).action(async (channel, options) => {
  const { config, client } = await localClient(); output(channelResult(await channelStatus(client, config, channel, options.session, options.wait)));
});
channels.command('leave').argument('<channel>', 'Canonical numeric channel', channelId).option('--session <uuid>', 'Chat session UUID').action(async (channel, options) => {
  const { config, client } = await localClient(); const session = await leaveChannel(client, config, channel, options.session); output({ left: true, channel: session.channel, session_id: session.session_id, generation: session.generation });
});
channels.command('ack').argument('<channel>', 'Canonical numeric channel', channelId).argument('<cursor>', 'Inbox cursor processed successfully', integer).option('--session <uuid>', 'Chat session UUID').action(async (channel, cursor, options) => {
  const { config, client } = await localClient(); const session = requireChannelSession(config, channel, options.session); output(await client.acknowledgeChannel(session.channel, session.session_id, session.generation, cursor));
});
program.command('send').option('--to <device>', 'Recipient for the device mailbox').option('--channel <channel>', 'Paired numeric channel', channelId).option('--session <uuid>', 'Chat session UUID for --channel').option('--text <text>', 'Message text', '').option('--attach <file-id>', 'Attach file ID; repeat for multiple files', (value: string, previous: string[]) => [...previous, value], [] as string[]).option('--idempotency-key <key>').action(async options => {
  if (options.channel && options.to) throw new BridgeError(0, 'INVALID_ARGUMENT', '--channel and --to are mutually exclusive');
  if (!options.channel && !options.to) throw new BridgeError(0, 'INVALID_ARGUMENT', 'Specify --channel or --to');
  if (options.session && !options.channel) throw new BridgeError(0, 'INVALID_ARGUMENT', '--session requires --channel');
  const { config, client } = await localClient();
  if (options.channel) output({ message: await sendChannelMessage(client, config, options.channel, options.session, options.text, options.attach, options.idempotencyKey) });
  else { const input = messageInputSchema.parse({ to: options.to, text: options.text, file_ids: options.attach }); output({ message: await client.send(input, options.idempotencyKey) }); }
});
program.command('inbox').option('--channel <channel>', 'Paired numeric channel', channelId).option('--session <uuid>', 'Chat session UUID for --channel').option('--wait <seconds>', 'Long poll wait, 0–25 seconds', wait, 25).option('--after <cursor>', 'Replay after this cursor for this call', integer).action(async options => {
  if (options.session && !options.channel) throw new BridgeError(0, 'INVALID_ARGUMENT', '--session requires --channel');
  const { config, client } = await localClient();
  if (options.channel) { const session = requireChannelSession(config, options.channel, options.session); output(await client.channelInbox(session.channel, session.session_id, session.generation, options.after, options.wait)); return; }
  const after = options.after ?? config.inbox_cursor ?? 0; const page = await client.inbox(after, options.wait);
  output(page);
  if (options.after === undefined && page.cursor > (config.inbox_cursor ?? 0)) await updateConfig(current => {
    if (!current) throw new BridgeError(0, 'CONFIG_CHANGED', 'Configuration was removed during inbox polling');
    if (current.url !== config.url || current.token !== config.token || current.device !== config.device) return current;
    return { ...current, inbox_cursor: Math.max(current.inbox_cursor ?? 0, page.cursor) };
  });
});
program.command('watch').description('Wait for the next channel messages, rejoining and reconfirming as needed; exits once messages arrive').requiredOption('--channel <channel>', 'Paired numeric channel', channelId).option('--session <uuid>', 'Chat session UUID').option('--timeout <seconds>', 'Give up after this many seconds; 0 waits indefinitely', integer, 0).action(async options => {
  const { config, client } = await localClient(); output(await watchChannel(client, config, options.channel, options.session, options.timeout));
});
program.command('upload').argument('<path>').action(async path => { const { client } = await localClient(); output({ file: await client.upload(path) }); });
program.command('download').argument('<id>').requiredOption('--output <path>', 'New destination path; existing files are never overwritten').action(async (id, options) => { const { client } = await localClient(); const file = await client.download(id, options.output); output({ file, path: resolve(options.output) }); });
program.command('files').action(async () => { const { client } = await localClient(); output({ files: await client.files() }); });
program.command('file').argument('<id>').action(async id => { const { client } = await localClient(); output({ file: await client.file(id) }); });
program.command('delete').argument('<id>').action(async id => { const { client } = await localClient(); output(await client.deleteFile(id)); });
program.command('skill').command('install').option('--project <path>', 'Install inside a project checkout').option('--user', 'Install for this Codex user (default)').option('--claude', 'Install for this Claude Code user').option('--force', 'Replace an existing skill folder').action(async options => {
  if ([options.project, options.user, options.claude].filter(Boolean).length > 1) throw new BridgeError(0, 'INVALID_ARGUMENT', '--user, --claude and --project are mutually exclusive');
  let destination: string;
  if (options.project) { const project = await realpath(resolve(options.project)); if (!(await stat(project)).isDirectory()) throw new BridgeError(0, 'NOT_A_DIRECTORY', 'Project must be a directory'); destination = resolve(project, '.agents/skills/agent-bridge'); }
  else destination = resolve(homedir(), options.claude ? '.claude/skills/agent-bridge' : '.codex/skills/agent-bridge');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../.agents/skills/agent-bridge');
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.${randomUUID()}.tmp`; const backup = `${destination}.${randomUUID()}.backup`; const lock = `${destination}.install-lock`;
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BridgeError(0, 'SKILL_INSTALL_BUSY', 'Another command is installing this skill; retry after it finishes'); throw error; }
  let installed = false; let backedUp = false;
  try {
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    let exists = false;
    try { await lstat(destination); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) {
      if (!options.force) throw new BridgeError(0, 'SKILL_EXISTS', 'Skill already exists; use --force to replace it');
      await rename(destination, backup); backedUp = true;
    }
    // Windows cannot rename over even an empty directory. The sibling lock
    // reserves this installation while publication targets an absent path.
    await rename(staging, destination); installed = true;
  } catch (error) {
    if (backedUp) { await rename(backup, destination); backedUp = false; }
    throw error;
  } finally {
    try { await rm(staging, { recursive: true, force: true }); if (installed && backedUp) await rm(backup, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  output({ installed: resolve(destination, 'SKILL.md'), scope: options.project ? 'project' : options.claude ? 'claude' : 'user' });
});
try { await program.parseAsync(); } catch (error) {
  const commander = error as { code?: string; exitCode?: number };
  if (commander.code === 'commander.helpDisplayed' || commander.code === 'commander.version') process.exitCode = 0;
  else { const code = error instanceof BridgeError ? error.code : commander.code ?? 'CLI_ERROR'; const message = error instanceof BridgeError ? error.message : commander.code?.startsWith('commander.') ? (error as Error).message : 'Command failed; check configuration, paths, and arguments'; process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`); process.exitCode = 1; }
}
