import { WhatsAppManError, ErrorCode } from '../errors.js';

/**
 * Validate a bulk recipient list against the configured cap. Kept as a pure,
 * socket-free function so the cap logic is unit-testable. See docs/PLAN.md
 * (send_bulk) and docs/SECURITY.md (send-abuse / ban risk).
 */
export function validateBulk(recipients: string[], max: number): void {
  if (recipients.length === 0) {
    throw new WhatsAppManError(ErrorCode.BAD_REQUEST, 'no recipients given');
  }
  if (recipients.length > max) {
    throw new WhatsAppManError(
      ErrorCode.BULK_LIMIT_EXCEEDED,
      `${recipients.length} recipients exceeds the max of ${max} (settings.maxBulkRecipients)`,
    );
  }
}
