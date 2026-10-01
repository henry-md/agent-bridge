import { z } from 'zod';

export const DEFAULT_POLL_SECONDS = 25;
export const DEFAULT_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_RESULTS = 100;
export const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const requestInputSchema = z.object({
  to: nameSchema,
  operation: z.enum(['list', 'search', 'read']),
  root: nameSchema,
  path: z.string().max(4096).default(''),
  query: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(MAX_RESULTS),
}).strict().refine(x => x.operation !== 'search' || !!x.query, { message: 'Search requires query' });
export type RequestInput = z.infer<typeof requestInputSchema>;
export const messageInputSchema = z.object({
  to: nameSchema,
  text: z.string().max(16000).default(''),
  file_ids: z.array(z.string().uuid()).max(16).default([]),
}).strict().refine(x => !!x.text || x.file_ids.length > 0, { message: 'Message needs text or attachments' });
export type MessageInput = z.infer<typeof messageInputSchema>;
export interface Device { name: string; roots: string[]; last_seen: string | null; online: boolean; revoked: boolean }
export interface Message extends MessageInput { id: string; seq: number; from: string; created_at: string }
export interface FileInfo { id: string; name: string; size: number; sha256: string; content_type: string; uploaded_by: string; created_at: string }
export interface RemoteError { code: string; message: string }
export interface RemoteRequest extends RequestInput {
  id: string; from: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'expired';
  created_at: string; expires_at: string; lease_token?: string; result?: unknown; error?: RemoteError;
}
export interface Source { device: string; root: string; path: string; modified_at: string; size: number }
export interface ReadResult extends Source { content: string; encoding: 'utf8'; truncated: boolean }
export interface FileEntry extends Source { name: string; type: 'file' | 'directory' }
export interface ListResult { device: string; root: string; path: string; entries: FileEntry[]; truncated: boolean }
export interface SearchMatch extends Source { line: number; text: string }
export interface SearchResult { device: string; root: string; path: string; matches: SearchMatch[]; truncated: boolean }
export class BridgeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'BridgeError'; }
}
