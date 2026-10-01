import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backup } from 'node:sqlite';
import { z } from 'zod';
import {
  BridgeError, DEFAULT_QUOTA_BYTES, DEFAULT_UPLOAD_BYTES,
  channelConfirmSchema, channelIdSchema, channelJoinSchema, channelMessageInputSchema,
  messageInputSchema, nameSchema, requestInputSchema, type ChannelStatus,
} from '../shared/protocol.js';
import { channelMessageInfo, deviceInfo, fileInfo, messageInfo, openDatabase, requestInfo, type Row } from './database.js';

export interface ServerOptions {
  dataDir: string;
  adminToken: string;
  logger?: boolean;
  maxUploadBytes?: number;
  quotaBytes?: number;
  requestTtlMs?: number;
  offlineMs?: number;
  leaseMs?: number;
  channelLeaseMs?: number;
}

interface Actor { name: string; hash: string }
export const DEFAULT_CHANNEL_LEASE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
// A replaced member keeps this lease so its chat learns it was superseded rather than expired.
const REPLACED_LEASE = -1;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const waitSchema = z.object({ wait: z.coerce.number().int().min(0).max(25).default(0) });
const messageQuerySchema = waitSchema.extend({ after: z.coerce.number().int().min(0).default(0) });
const channelSessionSchema = z.object({ session_id: z.string().uuid(), generation: z.string().uuid() }).strict();
const channelStatusQuerySchema = channelSessionSchema.extend({ wait: z.coerce.number().int().min(0).max(25).default(0) });
const channelInboxQuerySchema = channelStatusQuerySchema.extend({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() });
const channelAckSchema = channelSessionSchema.extend({ cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const resultSchema = z.object({
  lease_token: z.string().min(1).max(256),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().max(1024) }).strict().optional(),
}).strict().refine(x => Object.hasOwn(x, 'result') !== !!x.error, { message: 'Provide result or error' });

export async function createServer(options: ServerOptions) {
  if (options.adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters');
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_UPLOAD_BYTES;
  const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  const requestTtlMs = options.requestTtlMs ?? 60_000;
  const offlineMs = options.offlineMs ?? 60_000;
  const leaseMs = options.leaseMs ?? 30_000;
  // Channel sessions persist until a chat leaves or is replaced; idle chats keep their pairing.
  const channelLeaseMs = options.channelLeaseMs ?? DEFAULT_CHANNEL_LEASE_MS;
  for (const [name, value] of Object.entries({ maxUploadBytes, quotaBytes, requestTtlMs, offlineMs, leaseMs, channelLeaseMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const filesDir = join(options.dataDir, 'files');
  const tempDir = join(options.dataDir, 'tmp');
  const backupsDir = join(options.dataDir, 'backups');
  await Promise.all([mkdir(filesDir, { recursive: true }), mkdir(tempDir, { recursive: true }), mkdir(backupsDir, { recursive: true })]);
  const db = openDatabase(join(options.dataDir, 'bridge.sqlite'));
  // A previous process may have stopped mid-upload or between rename and metadata commit.
  for (const name of await readdir(tempDir)) await rm(join(tempDir, name), { force: true, recursive: true });
  for (const name of await readdir(filesDir)) {
    if (!db.prepare('SELECT id FROM files WHERE id = ?').get(name)) await rm(join(filesDir, name), { force: true });
  }
  const app = Fastify({
    logger: options.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers["idempotency-key"]'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 64 * 1024,
  });
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const actors = new WeakMap<FastifyRequest, Actor>();
  const adminHash = Buffer.from(hash(options.adminToken), 'hex');
  let reservedBytes = 0;
  let closing = false;
  let backupWork: Promise<void> | undefined;
  const signal = () => bus.emit('change');

  function bearer(request: FastifyRequest) {
    const header = request.headers.authorization;
    if (!header || !/^Bearer [^\s]+$/.test(header)) throw new BridgeError(401, 'unauthorized', 'A bearer token is required');
    return header.slice(7);
  }
  async function requireAdmin(request: FastifyRequest) {
    if (!timingSafeEqual(Buffer.from(hash(bearer(request)), 'hex'), adminHash)) throw new BridgeError(401, 'unauthorized', 'Invalid admin token');
  }
  async function requireDevice(request: FastifyRequest) {
    const tokenHash = hash(bearer(request));
    const row = db.prepare('SELECT name FROM devices WHERE token_hash = ? AND revoked = 0').get(tokenHash) as Row | undefined;
    if (!row) throw new BridgeError(401, 'unauthorized', 'Invalid or revoked device token');
    actors.set(request, { name: row.name, hash: tokenHash });
  }
  function actor(request: FastifyRequest): Actor {
    const value = actors.get(request);
    if (!value) throw new BridgeError(401, 'unauthorized', 'Device authentication is required');
    return value;
  }
  function active(value: Actor) {
    if (!db.prepare('SELECT name FROM devices WHERE name = ? AND token_hash = ? AND revoked = 0').get(value.name, value.hash)) {
      throw new BridgeError(401, 'unauthorized', 'Device token was revoked');
    }
  }
  function device(name: string) {
    const row = db.prepare('SELECT * FROM devices WHERE name = ? AND revoked = 0').get(name) as Row | undefined;
    if (!row) throw new BridgeError(404, 'device_not_found', 'Target device does not exist');
    return row;
  }
  function expire() {
    const result = db.prepare("UPDATE requests SET status = 'expired', lease_token = NULL, lease_until = NULL, error_json = ? WHERE status IN ('pending', 'running') AND expires_at <= ?")
      .run(JSON.stringify({ code: 'request_timeout', message: 'The remote request expired before completing' }), Date.now());
    if (result.changes) signal();
  }
  function getRequest(id: string) {
    expire();
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new BridgeError(404, 'request_not_found', 'Request does not exist');
    return row;
  }
  function getFile(id: string) {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new BridgeError(404, 'file_not_found', 'File does not exist');
    return row;
  }
  function idParam(request: FastifyRequest) {
    return z.object({ id: z.string().uuid() }).parse(request.params).id;
  }
  function idem(request: FastifyRequest) {
    const value = request.headers['idempotency-key'];
    return value === undefined ? null : z.string().min(1).max(128).parse(value);
  }
  function duplicate(table: 'messages' | 'requests', from: string, key: string | null, payloadHash: string) {
    if (!key) return undefined;
    const row = db.prepare(`SELECT * FROM ${table} WHERE from_name = ? AND idem_key = ?`).get(from, key) as Row | undefined;
    if (row && row.payload_hash !== payloadHash) throw new BridgeError(409, 'idempotency_conflict', 'This idempotency key was already used for different content');
    return row;
  }

  function transaction<T>(work: () => T): T {
    // Serialize round selection and membership changes even if another relay process opens this database.
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function channelParam(request: FastifyRequest) {
    return z.object({ channel: channelIdSchema }).parse(request.params).channel;
  }
  function channelRound(channel: string, generation?: string): Row {
    const row = db.prepare('SELECT r.*, p.pairing_id FROM channel_heads h JOIN channel_rounds r ON r.generation = h.generation JOIN channel_pairings p ON p.generation = r.generation WHERE h.channel = ?').get(channel) as Row | undefined;
    if (!row) throw new BridgeError(404, 'channel_not_found', 'Join this channel before using it');
    if (generation !== undefined && generation !== row.generation) throw new BridgeError(409, 'stale_generation', 'This channel round has ended; join again');
    return row;
  }
  function resetChannelPairing(round: Row) {
    round.pairing_id = randomUUID();
    db.prepare('UPDATE channel_pairings SET pairing_id = ? WHERE generation = ?').run(round.pairing_id, round.generation);
    db.prepare('UPDATE channel_members SET confirmed_peer_session = NULL WHERE generation = ?').run(round.generation);
  }
  function expireChannelMembers(round: Row, now: number) {
    const result = db.prepare(`UPDATE channel_members SET lease_until = 0, confirmed_peer_session = NULL
      WHERE generation = ? AND lease_until > 0 AND (lease_until <= ? OR device_name IN (SELECT name FROM devices WHERE revoked = 1))`).run(round.generation, now);
    if (result.changes) {
      // A surviving participant must acknowledge the next pairing, including a peer rejoining with the same session ID.
      resetChannelPairing(round);
      signal();
    }
  }
  function liveChannelMembers(generation: string, now: number): Row[] {
    return db.prepare(`SELECT m.* FROM channel_members m JOIN devices d ON d.name = m.device_name
      WHERE m.generation = ? AND m.lease_until > ? AND d.revoked = 0 ORDER BY m.session_id`).all(generation, now) as Row[];
  }
  function channelMember(round: Row, session: string, who: Actor, now: number, renew = true): Row {
    const row = db.prepare('SELECT * FROM channel_members WHERE generation = ? AND session_id = ?').get(round.generation, session) as Row | undefined;
    if (!row || row.device_name !== who.name) throw new BridgeError(403, 'channel_session_mismatch', 'This session does not belong to the authenticated device');
    if (row.lease_until === REPLACED_LEASE) throw new BridgeError(409, 'channel_session_replaced', 'Another chat on this device took over this channel');
    if (row.lease_until <= now) throw new BridgeError(409, 'channel_session_expired', 'This channel session has expired; join again');
    if (renew) {
      row.lease_until = now + channelLeaseMs;
      db.prepare('UPDATE channel_members SET lease_until = ? WHERE generation = ? AND session_id = ?').run(row.lease_until, round.generation, session);
    }
    return row;
  }
  function channelStatus(round: Row, member: Row, now: number): ChannelStatus {
    const peer = liveChannelMembers(round.generation, now).find(row => row.session_id !== member.session_id);
    const connected = !!peer && member.confirmed_peer_session === peer.session_id && peer.confirmed_peer_session === member.session_id;
    return {
      channel: round.channel, generation: round.generation, pairing_id: round.pairing_id, session_id: member.session_id,
      secret_word: round.secret_word, status: connected ? 'connected' : 'waiting',
      peer: peer ? { device: peer.device_name, session_id: peer.session_id } : null,
      lease_expires_at: new Date(member.lease_until).toISOString(),
    };
  }

  async function poll<T>(request: FastifyRequest, reply: FastifyReply, seconds: number, read: () => T, ready: (value: T) => boolean, intervalMs = 250): Promise<T> {
    const deadline = Date.now() + seconds * 1000;
    const who = actor(request);
    while (true) {
      if (closing) throw new BridgeError(503, 'server_closing', 'The relay is restarting; retry the request');
      active(who);
      const value = read();
      if (ready(value) || Date.now() >= deadline || reply.raw.destroyed) return value;
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer);
          bus.off('change', finish);
          reply.raw.off('close', finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(intervalMs, deadline - Date.now()));
        bus.once('change', finish);
        reply.raw.once('close', finish);
      });
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (reply.raw.destroyed) return;
    if (error instanceof BridgeError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: 'The request does not match the required format' } });
    const err = error as Error & { statusCode?: number; code?: string };
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'invalid_request', message: err.statusCode === 413 ? 'The upload or request body exceeds its limit' : 'Invalid request' } });
    }
    app.log.error({ code: err.code ?? 'internal_error' }, 'Relay operation failed');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'The relay could not complete this operation' } });
  });
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1 } });
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute',
    keyGenerator: request => request.headers.authorization ? hash(request.headers.authorization) : request.ip,
  });

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.post('/v1/devices', { preHandler: requireAdmin }, async request => {
    const { name } = z.object({ name: nameSchema }).strict().parse(request.body);
    const existing = db.prepare('SELECT * FROM devices WHERE name = ?').get(name) as Row | undefined;
    if (existing && !existing.revoked) throw new BridgeError(409, 'device_exists', 'Device already exists; revoke it before registering a replacement token');
    const token = randomBytes(32).toString('base64url');
    db.prepare("INSERT INTO devices (name, token_hash) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, roots = '[]', last_seen = NULL, revoked = 0")
      .run(name, hash(token));
    signal();
    return { device: deviceInfo(device(name), offlineMs), token };
  });
  app.delete('/v1/devices/:name', { preHandler: requireAdmin }, async (request, reply) => {
    const { name } = z.object({ name: nameSchema }).parse(request.params);
    if (!db.prepare('SELECT name FROM devices WHERE name = ?').get(name)) throw new BridgeError(404, 'device_not_found', 'Device does not exist');
    db.prepare('UPDATE devices SET revoked = 1 WHERE name = ?').run(name);
    const affected = db.prepare(`SELECT DISTINCT r.*, p.pairing_id FROM channel_members m JOIN channel_rounds r ON r.generation = m.generation
      JOIN channel_pairings p ON p.generation = r.generation WHERE m.device_name = ? AND m.lease_until > ?`).all(name, Date.now()) as Row[];
    for (const round of affected) resetChannelPairing(round);
    db.prepare('UPDATE channel_members SET lease_until = 0 WHERE device_name = ?').run(name);
    db.prepare("UPDATE requests SET status = 'failed', lease_token = NULL, lease_until = NULL, error_json = ? WHERE (from_name = ? OR to_name = ?) AND status IN ('pending', 'running')")
      .run(JSON.stringify({ code: 'device_revoked', message: 'A device associated with this request was revoked' }), name, name);
    signal();
    return reply.code(204).send();
  });
  app.post('/v1/heartbeat', { preHandler: requireDevice }, async request => {
    const { roots } = z.object({ roots: z.array(nameSchema).max(64) }).strict().parse(request.body);
    const who = actor(request);
    db.prepare('UPDATE devices SET roots = ?, last_seen = ? WHERE name = ?').run(JSON.stringify([...new Set(roots)]), Date.now(), who.name);
    return { device: deviceInfo(device(who.name), offlineMs) };
  });
  app.get('/v1/devices', { preHandler: requireDevice }, async () => ({
    devices: (db.prepare('SELECT * FROM devices ORDER BY name').all() as Row[]).map(row => deviceInfo(row, offlineMs)),
  }));

  app.post('/v1/channels/:channel/join', { preHandler: requireDevice }, async request => {
    const channel = channelParam(request);
    const input = channelJoinSchema.parse(request.body);
    const who = actor(request);
    const result = transaction(() => {
      const now = Date.now();
      let round = db.prepare('SELECT r.*, p.pairing_id FROM channel_heads h JOIN channel_rounds r ON r.generation = h.generation JOIN channel_pairings p ON p.generation = r.generation WHERE h.channel = ?').get(channel) as Row | undefined;
      if (round) expireChannelMembers(round, now);
      let members = round ? liveChannelMembers(round.generation, now) : [];
      if (!members.length) {
        round = { channel, generation: randomUUID(), pairing_id: randomUUID(), secret_word: input.secret_word, created_at: now };
        db.prepare('INSERT INTO channel_rounds (generation, channel, secret_word, created_at) VALUES (?, ?, ?, ?)')
          .run(round.generation, channel, round.secret_word, now);
        db.prepare('INSERT INTO channel_pairings (generation, pairing_id) VALUES (?, ?)').run(round.generation, round.pairing_id);
        db.prepare('INSERT INTO channel_heads (channel, generation) VALUES (?, ?) ON CONFLICT (channel) DO UPDATE SET generation = excluded.generation')
          .run(channel, round.generation);
        members = [];
      }
      const current = round!;
      const prior = db.prepare('SELECT * FROM channel_members WHERE generation = ? AND session_id = ?').get(current.generation, input.session_id) as Row | undefined;
      if (prior && prior.device_name !== who.name) throw new BridgeError(403, 'channel_session_mismatch', 'This session belongs to another device');
      let sameDevice = members.find(row => row.device_name === who.name);
      if (sameDevice && sameDevice.session_id !== input.session_id) {
        // Sessions no longer lapse on their own, so the newest chat on a device takes the channel over.
        db.prepare('UPDATE channel_members SET lease_until = ?, confirmed_peer_session = NULL WHERE generation = ? AND session_id = ?')
          .run(REPLACED_LEASE, current.generation, sameDevice.session_id);
        members = members.filter(row => row.session_id !== sameDevice!.session_id);
        sameDevice = undefined;
      }
      if (!sameDevice) {
        if (members.length >= 2) throw new BridgeError(409, 'channel_full', 'This channel already has two active devices');
        resetChannelPairing(current);
        db.prepare(`INSERT INTO channel_members (generation, session_id, device_name, lease_until) VALUES (?, ?, ?, ?)
          ON CONFLICT (generation, session_id) DO UPDATE SET lease_until = excluded.lease_until, confirmed_peer_session = NULL`)
          .run(current.generation, input.session_id, who.name, now + channelLeaseMs);
      }
      return channelStatus(current, channelMember(current, input.session_id, who, now), now);
    });
    signal();
    return result;
  });
  app.get('/v1/channels/:channel', { preHandler: requireDevice }, async (request, reply) => {
    const channel = channelParam(request);
    const input = channelStatusQuerySchema.parse(request.query);
    const who = actor(request);
    let initialPeer: string | null | undefined;
    let initialPairing: string | undefined;
    let needsConfirmation = false;
    return poll(request, reply, input.wait, () => transaction(() => {
      const now = Date.now();
      const round = channelRound(channel, input.generation);
      expireChannelMembers(round, now);
      const member = channelMember(round, input.session_id, who, now);
      const status = channelStatus(round, member, now);
      needsConfirmation = status.peer !== null && member.confirmed_peer_session !== status.peer.session_id;
      return status;
    }), value => {
      const peer = value.peer?.session_id ?? null;
      if (initialPeer === undefined) initialPeer = peer;
      if (initialPairing === undefined) initialPairing = value.pairing_id;
      return value.status === 'connected' || needsConfirmation || peer !== initialPeer || value.pairing_id !== initialPairing;
    }, Math.max(1, Math.min(250, Math.floor(channelLeaseMs / 3))));
  });
  app.post('/v1/channels/:channel/confirm', { preHandler: requireDevice }, async request => {
    const channel = channelParam(request);
    const input = channelConfirmSchema.parse(request.body);
    const who = actor(request);
    const result = transaction(() => {
      const now = Date.now();
      const round = channelRound(channel, input.generation);
      expireChannelMembers(round, now);
      const member = channelMember(round, input.session_id, who, now);
      if (input.pairing_id !== round.pairing_id) throw new BridgeError(409, 'channel_pairing_changed', 'The channel pairing changed; fetch its current status before confirming');
      if (input.secret_word !== round.secret_word) throw new BridgeError(409, 'secret_mismatch', 'The secret word does not match this channel round');
      const peer = liveChannelMembers(round.generation, now).find(row => row.session_id !== member.session_id);
      member.confirmed_peer_session = peer?.session_id ?? null;
      db.prepare('UPDATE channel_members SET confirmed_peer_session = ? WHERE generation = ? AND session_id = ?')
        .run(member.confirmed_peer_session, round.generation, member.session_id);
      return channelStatus(round, member, now);
    });
    signal();
    return result;
  });
  app.delete('/v1/channels/:channel/sessions/:session_id', { preHandler: requireDevice }, async (request, reply) => {
    const { channel, session_id } = z.object({ channel: channelIdSchema, session_id: z.string().uuid() }).parse(request.params);
    const { generation, pairing_id } = z.object({ generation: z.string().uuid(), pairing_id: z.string().uuid() }).strict().parse(request.query);
    const who = actor(request);
    transaction(() => {
      const round = channelRound(channel, generation);
      const member = db.prepare('SELECT * FROM channel_members WHERE generation = ? AND session_id = ?').get(round.generation, session_id) as Row | undefined;
      if (!member || member.device_name !== who.name) throw new BridgeError(403, 'channel_session_mismatch', 'This session does not belong to the authenticated device');
      if (member.lease_until > Date.now()) {
        if (pairing_id !== round.pairing_id) throw new BridgeError(409, 'channel_pairing_changed', 'The channel pairing changed; fetch its current status before leaving');
        resetChannelPairing(round);
      }
      db.prepare('UPDATE channel_members SET lease_until = 0 WHERE generation = ? AND session_id = ?').run(generation, session_id);
    });
    signal();
    return reply.code(204).send();
  });
  app.post('/v1/channels/:channel/messages', { preHandler: requireDevice }, async request => {
    const channel = channelParam(request);
    const input = channelMessageInputSchema.parse(request.body);
    const who = actor(request);
    const key = idem(request);
    const payloadHash = hash(JSON.stringify(input));
    const message = transaction(() => {
      const now = Date.now();
      const round = channelRound(channel, input.generation);
      expireChannelMembers(round, now);
      const member = channelMember(round, input.session_id, who, now);
      if (key) {
        const prior = db.prepare('SELECT * FROM channel_messages WHERE generation = ? AND from_session = ? AND idem_key = ?').get(input.generation, input.session_id, key) as Row | undefined;
        if (prior) {
          if (prior.payload_hash !== payloadHash) throw new BridgeError(409, 'idempotency_conflict', 'This idempotency key was already used for different content');
          return channelMessageInfo(prior);
        }
      }
      const status = channelStatus(round, member, now);
      if (status.status !== 'connected' || !status.peer) throw new BridgeError(409, 'channel_not_connected', 'Both devices must confirm the current pairing before sending');
      for (const id of input.file_ids) getFile(id);
      const id = randomUUID();
      db.prepare(`INSERT INTO channel_messages (id, channel, generation, from_name, from_session, to_name, to_session, text, file_ids, created_at, idem_key, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, channel, input.generation, who.name, input.session_id, status.peer.device, status.peer.session_id, input.text, JSON.stringify(input.file_ids), now, key, payloadHash);
      return channelMessageInfo(db.prepare('SELECT * FROM channel_messages WHERE id = ?').get(id) as Row);
    });
    signal();
    return { message };
  });
  app.get('/v1/channels/:channel/messages', { preHandler: requireDevice }, async (request, reply) => {
    const channel = channelParam(request);
    const input = channelInboxQuerySchema.parse(request.query);
    const who = actor(request);
    let initialPairing: string | undefined;
    let pairing: string | undefined;
    return poll(request, reply, input.wait, () => transaction(() => {
      const now = Date.now();
      const round = channelRound(channel, input.generation);
      expireChannelMembers(round, now);
      const member = channelMember(round, input.session_id, who, now);
      pairing = round.pairing_id;
      const after = input.after ?? member.acknowledged_cursor;
      const rows = db.prepare('SELECT * FROM channel_messages WHERE generation = ? AND to_name = ? AND to_session = ? AND seq > ? ORDER BY seq LIMIT 100')
        .all(input.generation, who.name, input.session_id, after) as Row[];
      return { messages: rows.map(channelMessageInfo), cursor: rows.at(-1)?.seq ?? after, acknowledged_cursor: member.acknowledged_cursor };
    }), value => {
      initialPairing ??= pairing;
      // Return early when the pairing resets so a watching reader can confirm the new peer promptly.
      return value.messages.length > 0 || pairing !== initialPairing;
    }, Math.max(1, Math.min(250, Math.floor(channelLeaseMs / 3))));
  });
  app.post('/v1/channels/:channel/ack', { preHandler: requireDevice }, async request => {
    const channel = channelParam(request);
    const input = channelAckSchema.parse(request.body);
    const who = actor(request);
    return transaction(() => {
      const now = Date.now();
      const round = channelRound(channel, input.generation);
      expireChannelMembers(round, now);
      const member = channelMember(round, input.session_id, who, now);
      if (input.cursor !== 0 && !db.prepare('SELECT seq FROM channel_messages WHERE generation = ? AND to_name = ? AND to_session = ? AND seq = ?')
        .get(input.generation, who.name, input.session_id, input.cursor)) {
        throw new BridgeError(400, 'invalid_cursor', 'Acknowledge a cursor from this session mailbox');
      }
      const acknowledged_cursor = Math.max(member.acknowledged_cursor, input.cursor);
      db.prepare('UPDATE channel_members SET acknowledged_cursor = ? WHERE generation = ? AND session_id = ?')
        .run(acknowledged_cursor, input.generation, input.session_id);
      return { acknowledged_cursor };
    });
  });

  app.post('/v1/messages', { preHandler: requireDevice }, async request => {
    const input = messageInputSchema.parse(request.body);
    const who = actor(request);
    const key = idem(request);
    const payloadHash = hash(JSON.stringify(input));
    const prior = duplicate('messages', who.name, key, payloadHash);
    if (prior) return { message: messageInfo(prior) };
    device(input.to);
    for (const id of input.file_ids) getFile(id);
    const id = randomUUID();
    db.prepare('INSERT INTO messages (id, from_name, to_name, text, file_ids, created_at, idem_key, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, who.name, input.to, input.text, JSON.stringify(input.file_ids), Date.now(), key, payloadHash);
    signal();
    return { message: messageInfo(db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row) };
  });
  app.get('/v1/messages', { preHandler: requireDevice }, async (request, reply) => {
    const { after, wait } = messageQuerySchema.parse(request.query);
    const who = actor(request);
    const messages = await poll(request, reply, wait,
      () => db.prepare('SELECT * FROM messages WHERE to_name = ? AND seq > ? ORDER BY seq LIMIT 100').all(who.name, after) as Row[],
      rows => rows.length > 0);
    return { messages: messages.map(messageInfo), cursor: messages.at(-1)?.seq ?? after };
  });

  app.post('/v1/requests', { preHandler: requireDevice }, async (request, reply) => {
    const input = requestInputSchema.parse(request.body);
    const who = actor(request);
    const key = idem(request);
    const payloadHash = hash(JSON.stringify(input));
    expire();
    const prior = duplicate('requests', who.name, key, payloadHash);
    if (prior) return reply.code(202).send({ request: requestInfo(prior) });
    const target = device(input.to);
    if (!deviceInfo(target, offlineMs).online) throw new BridgeError(503, 'device_offline', 'Target connector is offline; start it and retry');
    if (!(JSON.parse(target.roots) as string[]).includes(input.root)) throw new BridgeError(400, 'unknown_root', 'Target connector does not expose that root alias');
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO requests (id, from_name, to_name, input_json, status, created_at, expires_at, idem_key, payload_hash) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
      .run(id, who.name, input.to, JSON.stringify(input), now, now + requestTtlMs, key, payloadHash);
    signal();
    return reply.code(202).send({ request: requestInfo(getRequest(id)) });
  });
  app.get('/v1/requests/:id', { preHandler: requireDevice }, async (request, reply) => {
    const id = idParam(request);
    const { wait } = waitSchema.parse(request.query);
    const who = actor(request);
    const read = () => {
      const row = getRequest(id);
      if (row.from_name !== who.name && row.to_name !== who.name) throw new BridgeError(403, 'forbidden', 'This request belongs to other devices');
      return row;
    };
    const row = await poll(request, reply, wait, read, value => !['pending', 'running'].includes(value.status));
    return { request: requestInfo(row) };
  });
  app.get('/v1/connector/requests', { preHandler: requireDevice }, async (request, reply) => {
    const { wait } = waitSchema.parse(request.query);
    const who = actor(request);
    const claim = (): Row | undefined => {
      expire();
      const now = Date.now();
      // Synchronous selection/update cannot interleave in this single-instance relay.
      const row = db.prepare("SELECT * FROM requests WHERE to_name = ? AND (status = 'pending' OR (status = 'running' AND lease_until <= ?)) ORDER BY created_at, id LIMIT 1")
        .get(who.name, now) as Row | undefined;
      if (!row) return undefined;
      const token = randomBytes(24).toString('base64url');
      db.prepare("UPDATE requests SET status = 'running', lease_token = ?, lease_until = ? WHERE id = ?")
        .run(token, Math.min(now + leaseMs, row.expires_at), row.id);
      return getRequest(row.id);
    };
    const row = await poll(request, reply, wait, claim, value => !!value);
    return { requests: row ? [requestInfo(row, true)] : [] };
  });
  app.post('/v1/requests/:id/result', { preHandler: requireDevice, bodyLimit: 2 * 1024 * 1024 }, async request => {
    const id = idParam(request);
    const input = resultSchema.parse(request.body);
    const who = actor(request);
    const row = getRequest(id);
    if (row.to_name !== who.name) throw new BridgeError(403, 'forbidden', 'Only the target connector may complete this request');
    if (row.status !== 'running' || row.lease_token !== input.lease_token || row.lease_until <= Date.now()) {
      throw new BridgeError(409, 'stale_lease', 'This request lease is expired or has already been completed');
    }
    db.prepare('UPDATE requests SET status = ?, result_json = ?, error_json = ?, lease_token = NULL, lease_until = NULL WHERE id = ?')
      .run(input.error ? 'failed' : 'completed', input.error ? null : JSON.stringify(input.result), input.error ? JSON.stringify(input.error) : null, id);
    signal();
    return { request: requestInfo(getRequest(id)) };
  });

  app.post('/v1/files', { preHandler: requireDevice }, async request => {
    const who = actor(request);
    const used = Number((db.prepare('SELECT COALESCE(SUM(size), 0) AS size FROM files').get() as Row).size);
    const reservation = Math.min(maxUploadBytes, quotaBytes - used - reservedBytes);
    if (reservation < 1) throw new BridgeError(507, 'storage_quota', 'The shared file quota is full');
    reservedBytes += reservation;
    const id = randomUUID();
    const tempPath = join(tempDir, id);
    const finalPath = join(filesDir, id);
    let moved = false;
    let committed = false;
    let size = 0;
    let name = '';
    let contentType = 'application/octet-stream';
    const sha = createHash('sha256');
    try {
      let count = 0;
      for await (const part of request.parts({ limits: { fileSize: reservation, files: 1, fields: 0, parts: 1 } })) {
        if (part.type !== 'file' || part.fieldname !== 'file') throw new BridgeError(400, 'invalid_upload', 'Upload one multipart file using field name file');
        count++;
        if (count > 1) throw new BridgeError(400, 'invalid_upload', 'Upload one file per request');
        name = part.filename.replace(/.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'attachment';
        contentType = part.mimetype;
        await pipeline(part.file, new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            sha.update(chunk);
            callback(null, chunk);
          },
        }), createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) throw new BridgeError(413, reservation < maxUploadBytes ? 'storage_quota' : 'upload_too_large', 'The file exceeds the available quota or upload limit');
      }
      if (!count) throw new BridgeError(400, 'invalid_upload', 'Upload one multipart file using field name file');
      active(who);
      await rename(tempPath, finalPath);
      moved = true;
      db.prepare('INSERT INTO files (id, name, size, sha256, content_type, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, size, sha.digest('hex'), contentType, who.name, Date.now());
      committed = true;
      return { file: fileInfo(getFile(id)) };
    } finally {
      reservedBytes -= reservation;
      await rm(tempPath, { force: true });
      if (moved && !committed) await rm(finalPath, { force: true });
    }
  });
  app.get('/v1/files', { preHandler: requireDevice }, async () => ({
    files: (db.prepare('SELECT * FROM files ORDER BY created_at DESC, id').all() as Row[]).map(fileInfo),
  }));
  app.get('/v1/files/:id', { preHandler: requireDevice }, async request => ({ file: fileInfo(getFile(idParam(request))) }));
  app.get('/v1/files/:id/content', { preHandler: requireDevice }, async (request, reply) => {
    const row = getFile(idParam(request));
    const path = join(filesDir, row.id);
    try { await stat(path); } catch { throw new BridgeError(410, 'file_missing', 'The stored file is unavailable'); }
    return reply.header('Content-Type', 'application/octet-stream')
      .header('Content-Length', row.size)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .header('X-Content-SHA256', row.sha256)
      .header('X-Content-Type-Options', 'nosniff')
      .send(createReadStream(path));
  });
  app.delete('/v1/files/:id', { preHandler: requireDevice }, async (request, reply) => {
    const row = getFile(idParam(request));
    if (row.uploaded_by !== actor(request).name) throw new BridgeError(403, 'forbidden', 'Only the uploader may delete this file');
    // Remove metadata first so quota and visibility change atomically. Startup removes an orphan on a crash.
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    await rm(join(filesDir, row.id), { force: true });
    return reply.code(204).send();
  });

  async function saveBackup() {
    const filename = `bridge-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
    const path = join(backupsDir, filename);
    try {
      await backup(db, path);
      const files = (await readdir(backupsDir)).filter(name => /^bridge-.*\.sqlite$/.test(name)).sort();
      for (const name of files.slice(0, Math.max(0, files.length - 7))) await rm(join(backupsDir, name), { force: true });
    } catch {
      await rm(path, { force: true });
      app.log.warn('SQLite backup failed');
    }
  }
  const startBackup = () => {
    if (!closing && !backupWork) backupWork = saveBackup().finally(() => { backupWork = undefined; });
  };
  const backupTimer = setInterval(startBackup, 24 * 60 * 60 * 1000);
  backupTimer.unref();
  app.addHook('onReady', async () => { startBackup(); });
  app.addHook('preClose', async () => { closing = true; signal(); });
  app.addHook('onClose', async () => {
    clearInterval(backupTimer);
    await backupWork;
    db.close();
  });
  return app;
}
