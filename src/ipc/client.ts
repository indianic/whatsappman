import { connect } from './transport.js';
import { readToken } from './access.js';
import { responseSchema, type Method } from './protocol.js';
import { ErrorCode, WhatsAppManError } from '../errors.js';
import crypto from 'node:crypto';

const REQUEST_TIMEOUT_MS = 8000;

/**
 * The one-shot RPC used identically by the MCP server and the CLI: connect,
 * send one request (carrying the capability token), read one response, close.
 * Throws WhatsAppManError(DAEMON_DOWN) when the daemon isn't reachable so
 * callers can render a clear "run: whatsappman start" hint.
 */
export function request<T = unknown>(method: Method, params?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const token = readToken();
    if (!token) {
      reject(
        new WhatsAppManError(ErrorCode.DAEMON_DOWN, 'daemon is not running', ['run: whatsappman start']),
      );
      return;
    }

    const sock = connect();
    let buffer = '';
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      done(() => reject(new WhatsAppManError(ErrorCode.DAEMON_DOWN, 'daemon did not respond in time')));
    }, REQUEST_TIMEOUT_MS);

    sock.setEncoding('utf8');

    sock.on('connect', () => {
      const req = { id: crypto.randomUUID(), token, method, params };
      sock.write(JSON.stringify(req) + '\n');
    });

    sock.on('data', (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      done(() => {
        try {
          const parsed = responseSchema.parse(JSON.parse(line));
          if (parsed.ok) {
            resolve(parsed.result as T);
          } else {
            const e = parsed.error;
            reject(new WhatsAppManError((e?.code ?? ErrorCode.INTERNAL) as ErrorCode, e?.message ?? 'error', e?.next_steps));
          }
        } catch (err) {
          reject(new WhatsAppManError(ErrorCode.INTERNAL, `bad response from daemon: ${String((err as Error).message)}`));
        }
      });
    });

    sock.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT (no socket file) / ECONNREFUSED (stale socket, no listener) → daemon down.
      const down = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
      done(() =>
        reject(
          down
            ? new WhatsAppManError(ErrorCode.DAEMON_DOWN, 'daemon is not running', ['run: whatsappman start'])
            : new WhatsAppManError(ErrorCode.INTERNAL, `ipc error: ${err.message}`),
        ),
      );
    });

    sock.on('close', () => {
      done(() => reject(new WhatsAppManError(ErrorCode.DAEMON_DOWN, 'connection closed before a response')));
    });
  });
}

/** Convenience: is the daemon reachable right now? */
export async function ping(): Promise<boolean> {
  try {
    await request('ping');
    return true;
  } catch {
    return false;
  }
}
