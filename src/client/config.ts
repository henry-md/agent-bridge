import { chmod, mkdir, readFile, rename, writeFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BridgeError, channelIdSchema, nameSchema } from '../shared/protocol.js';
import { validateRelayUrl } from './relay.js';

export interface ChannelSessionConfig { generation?: string; secret_word: string }
export interface ChannelConfig { fallback_session_id?: string; sessions: Record<string, ChannelSessionConfig> }
export interface BridgeConfig { url: string; token?: string; device?: string; roots: Record<string, string>; inbox_cursor?: number; channel_sessions?: Record<string, ChannelConfig> }
const channelSessionsSchema = z.record(channelIdSchema, z.object({ fallback_session_id: z.string().uuid().optional(), sessions: z.record(z.string().uuid(), z.object({ generation: z.string().uuid().optional(), secret_word: z.string().regex(/^[a-z0-9-]{3,80}$/) }).strict()) }).strict());
export function configPath(): string { return resolve(process.env.BRIDGE_CONFIG ?? `${homedir()}/.agent-bridge/config.json`); }
export async function readConfig(requireToken = true): Promise<BridgeConfig> {
  let config: BridgeConfig;
  try { config = JSON.parse(await readFile(configPath(), 'utf8')) as BridgeConfig; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BridgeError(0, 'CONFIG_REQUIRED', 'Run bridge config set --url URL --token-env BRIDGE_TOKEN --device NAME first');
    throw new BridgeError(0, 'CONFIG_INVALID', 'Configuration could not be read');
  }
  validateRelayUrl(config.url);
  if (requireToken && !config.token) throw new BridgeError(0, 'TOKEN_REQUIRED', 'Configuration needs a device token');
  if (!config.roots || typeof config.roots !== 'object' || Array.isArray(config.roots) || Object.entries(config.roots).some(([alias, path]) => !nameSchema.safeParse(alias).success || typeof path !== 'string' || !isAbsolute(path))) throw new BridgeError(0, 'CONFIG_INVALID', 'Configured roots must have valid aliases and absolute paths');
  if (config.device && !nameSchema.safeParse(config.device).success) throw new BridgeError(0, 'CONFIG_INVALID', 'Configured device name is invalid');
  if (config.channel_sessions !== undefined && !channelSessionsSchema.safeParse(config.channel_sessions).success) throw new BridgeError(0, 'CONFIG_INVALID', 'Saved channel sessions are invalid');
  return config;
}
async function saveConfig(config: BridgeConfig): Promise<void> {
  const path = configPath(); const dir = dirname(path);
  // Never save local secrets inside a Git checkout.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let current = await realpath(dir);
  while (true) {
    try { await realpath(`${current}/.git`); throw new BridgeError(0, 'CONFIG_IN_GIT', 'Store credentials outside any Git checkout'); } catch (error) { if (error instanceof BridgeError) throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}
export function tokenFromEnv(name: string): string { const value = process.env[name]; if (!value) throw new BridgeError(0, 'TOKEN_REQUIRED', `Environment variable ${name} is required`); return value; }

async function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const path = configPath(); const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new BridgeError(0, 'CONFIG_BUSY', 'Another bridge command is updating configuration; retry after it finishes');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
  }
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function writeConfig(config: BridgeConfig): Promise<void> { await withConfigLock(() => saveConfig(config)); }
export async function updateConfig(update: (current: BridgeConfig | undefined) => BridgeConfig): Promise<BridgeConfig> {
  return withConfigLock(async () => {
    let current: BridgeConfig | undefined;
    try { current = await readConfig(false); } catch (error) { if (!(error instanceof BridgeError) || error.code !== 'CONFIG_REQUIRED') throw error; }
    const next = update(current); await saveConfig(next); return next;
  });
}
