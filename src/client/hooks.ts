import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { BridgeError } from '../shared/protocol.js';
import { writePrivateJson } from './config.js';

export async function installHooks(cliPath: string, pane: boolean) {
  const script = resolve(homedir(), '.codex/skills/agent-bridge/scripts/prompt-hook.mjs');
  await readFile(script); // Install the current full skill before wiring a command.
  const quote = (value: string) => {
    if (process.platform === 'win32') { if (/["%\r\n]/.test(value)) throw new BridgeError(0, 'INVALID_HOOK_PATH', 'Hook paths cannot contain quotes or environment expansion'); return `"${value}"`; }
    return `'${value.replaceAll("'", "'\\''")}'`;
  };
  const command = `${quote(process.execPath)} ${quote(script)} ${quote(cliPath)}${pane ? ' --pane' : ''}`;
  const path = resolve(process.env.CODEX_HOME ?? `${homedir()}/.codex`, 'hooks.json');
  let saved: { hooks?: Record<string, { hooks: { command?: string; [key: string]: unknown }[]; [key: string]: unknown }[]>; [key: string]: unknown } = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!saved || typeof saved !== 'object' || saved.hooks && typeof saved.hooks !== 'object') throw new BridgeError(0, 'HOOKS_INVALID', 'Existing hook configuration is invalid; it was preserved');
  const hooks = { ...saved.hooks };
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const entries = hooks[event] ?? [];
    // Preserve unrelated handlers; replace only this adapter's command.
    const retained = entries.map(entry => ({ ...entry, hooks: entry.hooks.filter(handler => !handler.command?.includes(quote(script))) })).filter(entry => entry.hooks.length);
    hooks[event] = [...retained, { hooks: [{ type: 'command', command, timeout: 2, ...(event === 'UserPromptSubmit' ? { additionalContextLimit: 500 } : {}) }] }];
  }
  await writePrivateJson(path, { ...saved, hooks });
  return { installed: true, path, command, trust_required: true, review: 'Review and trust the two bridge handlers in Codex /hooks or Hooks settings. Installation does not grant trust.', pane };
}
