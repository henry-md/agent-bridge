import { createServer } from './server.js';

function positiveNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

try {
  const app = await createServer({
    dataDir: process.env.DATA_DIR ?? './data',
    adminToken: process.env.ADMIN_TOKEN ?? '',
    logger: true,
    maxUploadBytes: positiveNumber('MAX_UPLOAD_BYTES'),
    quotaBytes: positiveNumber('UPLOAD_QUOTA_BYTES') ?? positiveNumber('QUOTA_BYTES'),
    requestTtlMs: positiveNumber('REQUEST_TTL_MS'),
    offlineMs: positiveNumber('OFFLINE_MS'),
    leaseMs: positiveNumber('LEASE_MS'),
    channelLeaseMs: positiveNumber('CHANNEL_LEASE_MS'),
  });
  const port = positiveNumber('PORT') ?? 3000;
  if (port > 65535) throw new Error('PORT must be less than 65536');
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
  const shutdown = () => { void app.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Relay startup failed');
  process.exitCode = 1;
}
