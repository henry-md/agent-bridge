import { BridgeError, type RemoteError } from '../shared/protocol.js';
import { executeFileRequest } from './filesystem.js';
import { RelayClient } from './relay.js';

export interface ConnectorOptions { signal?: AbortSignal; heartbeatMs?: number; pollSeconds?: number; onError?: (error: RemoteError) => void }
function sleep(ms: number, signal?: AbortSignal) { return new Promise<void>(resolve => { if (signal?.aborted) return resolve(); const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); }); }
export async function runConnector(client: RelayClient, device: string, roots: Record<string, string>, options: ConnectorOptions = {}): Promise<void> {
  const controller = new AbortController(); const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const report = (error: unknown) => options.onError?.({ code: error instanceof BridgeError ? error.code : 'CONNECTION_ERROR', message: error instanceof BridgeError ? error.message : 'Relay connection failed; reconnecting' });
  const heartbeat = (async () => { while (!signal.aborted) { try { await client.heartbeat(Object.keys(roots), signal); } catch (e) { if (!signal.aborted) report(e); } await sleep(options.heartbeatMs ?? 15_000, signal); } })();
  try {
    while (!signal.aborted) {
      try {
        const requests = await client.claim(options.pollSeconds ?? 25, signal);
        for (const request of requests) {
          if (signal.aborted) break;
          if (!request.lease_token) { report(new BridgeError(0, 'INVALID_LEASE', 'Relay returned a request without its lease')); continue; }
          let result: unknown; let error: RemoteError | undefined;
          try { result = await executeFileRequest(device, roots, { to: request.to, operation: request.operation, root: request.root, path: request.path, query: request.query, limit: request.limit }); } catch (e) { error = { code: e instanceof BridgeError ? e.code : 'FILE_ERROR', message: e instanceof BridgeError ? e.message : 'Remote file request failed' }; }
          await client.result(request.id, { lease_token: request.lease_token, ...(error ? { error } : { result }) }, signal);
        }
      } catch (error) { if (!signal.aborted) { report(error); await sleep(1000, signal); } }
    }
  } finally { controller.abort(); await heartbeat; }
}
