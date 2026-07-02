import { z } from 'zod';

/**
 * zod schemas for every persisted file. Each carries a `schemaVersion` from day
 * one so a future format change is a detectable migration, not a silent
 * misparse. See docs/STANDARDS.md.
 */

export const SESSION_STATUS = [
  'connected',
  'connecting',
  'qr_pending',
  'disconnected',
  'needs_relink',
  'logged_out',
] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUS);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** state.json — daemon identity + the single source of truth for the default number. */
export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  daemonId: z.string(),
  pid: z.number().int().nonnegative(),
  hostname: z.string(),
  startedAt: z.string(), // ISO-8601
  /** Label of the default session used when a send omits `from`. */
  defaultSession: z.string().nullable().default(null),
});
export type State = z.infer<typeof stateSchema>;

/** settings.json — global tunables. */
export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  draftTtlMinutes: z.number().int().positive().default(10),
  defaultDelayMs: z.number().int().min(0).default(2000),
  maxBulkRecipients: z.number().int().positive().default(100),
  alwaysConfirm: z.boolean().default(true),
  /** Fire OS desktop notifications for actionable daemon events (default on). */
  notifications: z.boolean().default(true),
  /** Country code prepended to a recipient number that has none (default India). */
  defaultCountryCode: z
    .string()
    .regex(/^\d{1,4}$/)
    .default('91'),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  draftTtlMinutes: 10,
  defaultDelayMs: 2000,
  maxBulkRecipients: 100,
  alwaysConfirm: true,
  notifications: true,
  defaultCountryCode: '91',
};

export const DRAFT_KIND = ['text', 'image', 'document', 'location', 'contact'] as const;

/** scheduled.json — one-time future sends, held by the always-on daemon.
 *  Each entry snapshots the message so it doesn't depend on an in-memory draft. */
export const scheduledEntrySchema = z.object({
  id: z.string(),
  from: z.string(), // session label
  toJid: z.string(),
  toName: z.string(),
  kind: z.enum(DRAFT_KIND),
  text: z.string().optional(),
  attachment: z
    .object({
      absPath: z.string(),
      filename: z.string(),
      mimetype: z.string(),
      sizeBytes: z.number(),
    })
    .optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  locationName: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  fireAt: z.string(), // ISO-8601
  createdAt: z.string(),
  status: z.enum(['pending', 'sent', 'failed', 'cancelled']).default('pending'),
  messageId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type ScheduledEntry = z.infer<typeof scheduledEntrySchema>;

export const scheduledFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(scheduledEntrySchema).default([]),
});
export type ScheduledFile = z.infer<typeof scheduledFileSchema>;

/** sessions/<label>/meta.json — per-number metadata (auth creds live alongside in auth/). */
export const sessionMetaSchema = z.object({
  schemaVersion: z.literal(1),
  label: z.string(),
  phone: z.string().nullable().default(null),
  status: sessionStatusSchema.default('disconnected'),
  linkedAt: z.string().nullable().default(null),
  lastConnectedAt: z.string().nullable().default(null),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;
