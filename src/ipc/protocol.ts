import { z } from 'zod';

/**
 * The newline-delimited JSON-RPC contract between the thin clients (MCP server
 * + CLI) and the daemon. One request per line, one response per line. See
 * docs/PLAN.md's IPC section.
 *
 * Every request carries the capability token (see ipc/access.ts); the daemon
 * rejects any request whose token doesn't match the current per-startup token.
 */

/** The method allowlist. Phase 1: ping + status. Phase 2 adds link/link_status/
 *  list_sessions/send_text. Later phases add draft/confirm/schedule/etc. An
 *  unknown method is rejected + audited. */
export const METHODS = [
  'ping',
  'status',
  'link',
  'link_status',
  'list_sessions',
  'send_text',
  'draft_message',
  'confirm_send',
  'cancel_draft',
  'resolve_recipient',
  'list_groups',
  'health_check',
  'set_default',
] as const;
export type Method = (typeof METHODS)[number];

export const requestSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
  method: z.enum(METHODS),
  params: z.unknown().optional(),
});
export type IpcRequest = z.infer<typeof requestSchema>;

export const errorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  next_steps: z.array(z.string()).optional(),
});

export const responseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: errorPayloadSchema.optional(),
});
export type IpcResponse = z.infer<typeof responseSchema>;

const noParams = z.undefined().or(z.object({}).passthrough()).optional();

const labelParam = z.object({ label: z.string().min(1) });

const sendTextParams = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1),
  text: z.string().min(1).max(65536),
});
export type SendTextParams = z.infer<typeof sendTextParams>;

const draftMessageParams = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1),
  text: z.string().min(1).max(65536),
});
export type DraftMessageParams = z.infer<typeof draftMessageParams>;

const draftIdParam = z.object({ draftId: z.string().min(1) });
const resolveParams = z.object({ from: z.string().min(1).optional(), query: z.string().min(1) });
const fromParam = z.object({ from: z.string().min(1).optional() }).or(z.undefined());

/** Per-method params schemas. */
export const paramsSchemas: Record<Method, z.ZodType> = {
  ping: noParams,
  status: noParams,
  link: labelParam,
  link_status: labelParam,
  list_sessions: noParams,
  send_text: sendTextParams,
  draft_message: draftMessageParams,
  confirm_send: draftIdParam,
  cancel_draft: draftIdParam,
  resolve_recipient: resolveParams,
  list_groups: fromParam,
  health_check: fromParam,
  set_default: labelParam,
};
