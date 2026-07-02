/**
 * Structured error codes. Every failable tool/IPC method returns
 * { code, message } (never bare prose) so a Claude session can branch on the
 * code. See docs/PLAN.md's error-code table.
 */
export const ErrorCode = {
  DAEMON_DOWN: 'DAEMON_DOWN',
  DAEMON_ALREADY_RUNNING: 'DAEMON_ALREADY_RUNNING',
  UNAUTHORIZED: 'UNAUTHORIZED',
  BAD_REQUEST: 'BAD_REQUEST',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_CONNECTED: 'SESSION_NOT_CONNECTED',
  NEEDS_RELINK: 'NEEDS_RELINK',
  LOGGED_OUT: 'LOGGED_OUT',
  NO_DEFAULT_SESSION: 'NO_DEFAULT_SESSION',
  AMBIGUOUS_RECIPIENT: 'AMBIGUOUS_RECIPIENT',
  RECIPIENT_NOT_ON_WHATSAPP: 'RECIPIENT_NOT_ON_WHATSAPP',
  INVALID_JID: 'INVALID_JID',
  DRAFT_NOT_FOUND: 'DRAFT_NOT_FOUND',
  DRAFT_EXPIRED: 'DRAFT_EXPIRED',
  ATTACHMENT_NOT_FOUND: 'ATTACHMENT_NOT_FOUND',
  ATTACHMENT_FORBIDDEN: 'ATTACHMENT_FORBIDDEN',
  ATTACHMENT_TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  BULK_LIMIT_EXCEEDED: 'BULK_LIMIT_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  SCHEDULED_NOT_FOUND: 'SCHEDULED_NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An error that carries a stable machine-readable code + optional next_steps. */
export class WhatsAppManError extends Error {
  readonly code: ErrorCode;
  readonly nextSteps?: string[];
  constructor(code: ErrorCode, message: string, nextSteps?: string[]) {
    super(message);
    this.name = 'WhatsAppManError';
    this.code = code;
    this.nextSteps = nextSteps;
  }
}
