import { open, realpath, opendir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { configPath } from './config.js';
import { BridgeError, MAX_RESULTS, MAX_TEXT_BYTES, requestInputSchema, type FileEntry, type ListResult, type ReadResult, type RequestInput, type SearchMatch, type SearchResult, type Source } from '../shared/protocol.js';

const MAX_VISITED = 5000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const excluded = (part: string) => /^(?:\.git|node_modules|\.ssh|\.aws|\.agent-bridge|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part) || /^\.env(?:\..*)?$/i.test(part) || /\.(pem|key)$/i.test(part);
export function validateRelativePath(path: string): string[] {
  if (path.includes('\0') || path.includes(':') || /^[\\/]/.test(path) || isAbsolute(path)) throw new BridgeError(400, 'PATH_FORBIDDEN', 'Path must be relative to a shared folder');
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.some(p => p === '..' || p === '.' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new BridgeError(400, 'PATH_FORBIDDEN', 'Unsafe path component');
  if (parts.some(excluded)) throw new BridgeError(403, 'PATH_EXCLUDED', 'This path is excluded from remote access');
  return parts;
}
function contained(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
async function safePath(root: string, path: string): Promise<string> {
  const parts = validateRelativePath(path);
  const candidate = await realpath(resolve(root, ...parts));
  if (!contained(root, candidate)) throw new BridgeError(403, 'PATH_FORBIDDEN', 'Path leaves the shared folder');
  const credentials = await realpath(configPath()).catch(() => undefined);
  if (candidate === credentials) throw new BridgeError(403, 'PATH_EXCLUDED', 'This path is excluded from remote access');
  // Also apply exclusions to the symlink's real destination within the root.
  if (relative(root, candidate).split(sep).some(excluded)) throw new BridgeError(403, 'PATH_EXCLUDED', 'This path is excluded from remote access');
  return candidate;
}
async function directoryNames(path: string, cap: number): Promise<{ names: string[]; truncated: boolean }> {
  const names: string[] = []; let truncated = false;
  for await (const entry of await opendir(path)) { if (names.length >= cap) { truncated = true; break; } names.push(entry.name); }
  return { names: names.sort(), truncated };
}
const relPath = (root: string, path: string) => relative(root, path).split(sep).join('/');
function source(device: string, alias: string, path: string, info: { mtime: Date; size: number }): Source { return { device, root: alias, path, modified_at: info.mtime.toISOString(), size: info.size }; }
async function textFile(path: string, root: string): Promise<{ text: string; truncated: boolean; size: number; mtime: Date }> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat(); if (!info.isFile()) throw new BridgeError(400, 'NOT_A_FILE', 'Read requires a regular file');
    // Recheck after opening to catch ordinary symlink replacement before the read.
    const current = await realpath(path); if (!contained(root, current)) throw new BridgeError(403, 'PATH_FORBIDDEN', 'Path leaves the shared folder');
    const currentInfo = await stat(current); if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) throw new BridgeError(409, 'FILE_CHANGED', 'File changed during access; retry');
    const data = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES));
    const { bytesRead } = await handle.read(data, 0, data.length, 0); const bytes = data.subarray(0, bytesRead); const truncated = info.size > bytesRead;
    if (bytes.includes(0)) throw new BridgeError(400, 'BINARY_FILE', 'Binary files must be shared as attachments');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); } catch { throw new BridgeError(400, 'BINARY_FILE', 'Non-UTF-8 files must be shared as attachments'); }
    return { text, truncated, size: info.size, mtime: info.mtime };
  } finally { await handle.close(); }
}
export async function executeFileRequest(device: string, roots: Record<string, string>, raw: RequestInput): Promise<ReadResult | ListResult | SearchResult> {
  try {
    const input = requestInputSchema.parse(raw);
    if (!Object.hasOwn(roots, input.root)) throw new BridgeError(404, 'ROOT_NOT_FOUND', 'Shared folder alias does not exist');
    const root = await realpath(roots[input.root]);
    if (!(await stat(root)).isDirectory()) throw new BridgeError(400, 'ROOT_INVALID', 'Shared folder is not a directory');
    const path = await safePath(root, input.path);
    const requestPath = input.path.replaceAll('\\', '/');
    const limit = Math.min(input.limit ?? MAX_RESULTS, MAX_RESULTS);
    if (input.operation === 'read') {
      const file = await textFile(path, root);
      return { ...source(device, input.root, requestPath, file), content: file.text, encoding: 'utf8', truncated: file.truncated };
    }
    if (input.operation === 'list') {
      if (!(await stat(path)).isDirectory()) throw new BridgeError(400, 'NOT_A_DIRECTORY', 'List requires a directory');
      const entries: FileEntry[] = []; let truncated = false; let visited = 0;
      const listing = await directoryNames(path, MAX_VISITED); const names = listing.names; truncated = listing.truncated;
      for (const name of names) {
        if (++visited > MAX_VISITED) { truncated = true; break; }
        if (excluded(name)) continue;
        try {
          const target = await safePath(root, `${relPath(root, path)}/${name}`.replace(/^\//, ''));
          const info = await stat(target); if (!info.isFile() && !info.isDirectory()) continue;
          if (entries.length >= limit) { truncated = true; break; }
          const entry: FileEntry = { ...source(device, input.root, `${requestPath ? requestPath + '/' : ''}${name}`, info), name, type: info.isDirectory() ? 'directory' : 'file' };
          if (Buffer.byteLength(JSON.stringify([...entries, entry])) > MAX_TEXT_BYTES) { truncated = true; break; }
          entries.push(entry);
        } catch (error) { if (error instanceof BridgeError || ['ENOENT', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
      }
      return { device, root: input.root, path: requestPath, entries, truncated };
    }
    const matches: SearchMatch[] = []; const seen = new Set<string>(); let visited = 0; let scanned = 0; let truncated = false; const deadline = Date.now() + 10_000;
    async function walk(target: string, depth: number): Promise<void> {
      if (matches.length >= limit || visited >= MAX_VISITED || scanned >= MAX_SEARCH_BYTES || depth > 20 || Date.now() > deadline) { truncated = true; return; }
      const canonical = await realpath(target); if (seen.has(canonical)) return; seen.add(canonical); visited++;
      const info = await stat(canonical);
      if (info.isDirectory()) {
        const listing = await directoryNames(canonical, MAX_VISITED - visited); if (listing.truncated) truncated = true;
        for (const name of listing.names) {
          if (excluded(name)) continue;
          try { const child = await safePath(root, `${relPath(root, canonical)}/${name}`.replace(/^\//, '')); await walk(child, depth + 1); } catch (error) { if (error instanceof BridgeError || ['ENOENT', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
          if (matches.length >= limit || visited >= MAX_VISITED || scanned >= MAX_SEARCH_BYTES || Date.now() > deadline) { truncated = true; break; }
        }
      } else if (info.isFile()) {
        let file;
        try { file = await textFile(canonical, root); } catch (error) { if (error instanceof BridgeError && error.code === 'BINARY_FILE') return; throw error; }
        scanned += Math.min(file.size, MAX_TEXT_BYTES); if (file.truncated) truncated = true;
        const lines = file.text.split('\n');
        for (let i = 0; i < lines.length; i++) if (lines[i].includes(input.query!)) {
          const match: SearchMatch = { ...source(device, input.root, relPath(root, canonical), file), line: i + 1, text: lines[i].slice(0, 1000) };
          if (matches.length >= limit || Buffer.byteLength(JSON.stringify([...matches, match])) > MAX_TEXT_BYTES) { truncated = true; break; }
          matches.push(match);
        }
      }
    }
    await walk(path, 0);
    return { device, root: input.root, path: requestPath, matches, truncated };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new BridgeError(404, 'PATH_NOT_FOUND', 'Path was not found within the shared folder');
    if (code === 'EACCES' || code === 'EPERM') throw new BridgeError(403, 'ACCESS_DENIED', 'Path cannot be read');
    throw new BridgeError(400, 'INVALID_REQUEST', 'Remote file request could not be completed');
  }
}
