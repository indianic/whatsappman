import net from 'node:net';
import { socketPath } from '../config/paths.js';
import { removeStaleSocket, secureSocketFile } from './transport.js';
import {
  requestSchema,
  paramsSchemas,
  type IpcResponse,
  type Method,
} from './protocol.js';
import { verifyToken } from './access.js';
import { ErrorCode, WhatsAppManError } from '../errors.js';

/** A method handler: receives validated params, returns a JSON-able result. */
export type Handler = (params: unknown) => Promise<unknown> | unknown;

const MAX_LINE_BYTES = 1_000_000; // bound request size — reject anything larger

function send(sock: net.Socket, res: IpcResponse): void {
  try {
    sock.write(JSON.stringify(res) + '\n');
  } catch {
    // client vanished mid-response; nothing to do
  }
}

async function handleLine(
  sock: net.Socket,
  line: string,
  handlers: Map<Method, Handler>,
): Promise<void> {
  let id = 'unknown';
  try {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      send(sock, { id, ok: false, error: { code: ErrorCode.BAD_REQUEST, message: 'invalid JSON' } });
      return;
    }
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) {
      send(sock, { id, ok: false, error: { code: ErrorCode.BAD_REQUEST, message: 'malformed request' } });
      return;
    }
    id = parsed.data.id;

    // Access control: capability token must match the current per-startup token.
    if (!verifyToken(parsed.data.token)) {
      send(sock, { id, ok: false, error: { code: ErrorCode.UNAUTHORIZED, message: 'invalid or missing token' } });
      return;
    }

    const method = parsed.data.method;
    const handler = handlers.get(method);
    if (!handler) {
      send(sock, { id, ok: false, error: { code: ErrorCode.UNKNOWN_METHOD, message: `unknown method: ${method}` } });
      return;
    }

    // Per-method params validation.
    const pv = paramsSchemas[method].safeParse(parsed.data.params);
    if (!pv.success) {
      send(sock, { id, ok: false, error: { code: ErrorCode.BAD_REQUEST, message: `invalid params for ${method}` } });
      return;
    }

    const result = await handler(pv.data);
    send(sock, { id, ok: true, result });
  } catch (err) {
    if (err instanceof WhatsAppManError) {
      send(sock, { id, ok: false, error: { code: err.code, message: err.message, next_steps: err.nextSteps } });
    } else {
      send(sock, { id, ok: false, error: { code: ErrorCode.INTERNAL, message: String((err as Error)?.message ?? err) } });
    }
  }
}

/**
 * Start the IPC server on the platform socket/pipe. Assumes the single-instance
 * lock is already held (see daemon/lock.ts), so it removes any stale socket
 * file before binding. Enforces newline framing, a size cap, token auth, method
 * allowlist, and per-method params validation on every request.
 */
export function startIpcServer(handlers: Map<Method, Handler>): Promise<net.Server> {
  removeStaleSocket();

  const server = net.createServer((sock) => {
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        send(sock, { id: 'unknown', ok: false, error: { code: ErrorCode.BAD_REQUEST, message: 'request too large' } });
        sock.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) void handleLine(sock, line, handlers);
      }
    });
    sock.on('error', () => sock.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath(), () => {
      secureSocketFile();
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
