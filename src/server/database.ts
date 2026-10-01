import { DatabaseSync } from 'node:sqlite';
import type { Device, FileInfo, Message, RemoteRequest } from '../shared/protocol.js';

export type Row = Record<string, any>;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS devices (
      name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      roots TEXT NOT NULL DEFAULT '[]', last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      from_name TEXT NOT NULL, to_name TEXT NOT NULL,
      text TEXT NOT NULL, file_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
      idem_key TEXT, payload_hash TEXT,
      UNIQUE (from_name, idem_key)
    );
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages (to_name, seq);
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, from_name TEXT NOT NULL, to_name TEXT NOT NULL,
      input_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lease_token TEXT, lease_until INTEGER, result_json TEXT, error_json TEXT,
      idem_key TEXT, payload_hash TEXT,
      UNIQUE (from_name, idem_key)
    );
    CREATE INDEX IF NOT EXISTS requests_queue ON requests (to_name, status, created_at);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, content_type TEXT NOT NULL,
      uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function deviceInfo(row: Row, offlineMs: number): Device {
  return {
    name: row.name, roots: JSON.parse(row.roots),
    last_seen: row.last_seen == null ? null : new Date(row.last_seen).toISOString(),
    online: !row.revoked && row.last_seen != null && Date.now() - row.last_seen < offlineMs,
    revoked: !!row.revoked,
  };
}

export function messageInfo(row: Row): Message {
  return {
    id: row.id, seq: row.seq, from: row.from_name, to: row.to_name,
    text: row.text, file_ids: JSON.parse(row.file_ids),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export function requestInfo(row: Row, includeLease = false): RemoteRequest {
  return {
    ...JSON.parse(row.input_json), id: row.id, from: row.from_name,
    status: row.status, created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    ...(includeLease && row.lease_token ? { lease_token: row.lease_token } : {}),
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) } : {}),
    ...(row.error_json !== null ? { error: JSON.parse(row.error_json) } : {}),
  };
}

export function fileInfo(row: Row): FileInfo {
  return {
    id: row.id, name: row.name, size: row.size, sha256: row.sha256,
    content_type: row.content_type, uploaded_by: row.uploaded_by,
    created_at: new Date(row.created_at).toISOString(),
  };
}
