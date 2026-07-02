import pino from 'pino';

/**
 * The daemon's logger. Redacts anything credential-ish or body-ish by default,
 * so message contents and Baileys creds never reach daemon.*.log. Baileys' own
 * internal logger is kept silent separately (see session-manager). Level is
 * controllable via WHATSAPPMAN_LOG_LEVEL (default 'info'). See docs/SECURITY.md.
 */
export const logger = pino({
  level: process.env.WHATSAPPMAN_LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'text',
      'body',
      'caption',
      'creds',
      'token',
      'auth',
      '*.text',
      '*.body',
      '*.creds',
      '*.token',
    ],
    censor: '[redacted]',
  },
});
