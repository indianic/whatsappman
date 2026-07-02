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
  'send_bulk',
  'draft_message',
  'confirm_send',
  'cancel_draft',
  'resolve_recipient',
  'list_groups',
  'health_check',
  'set_default',
  'reconnect',
  'disconnect',
  'relink',
  'delete_session',
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

export const DRAFT_KINDS = ['text', 'image', 'document', 'location', 'contact'] as const;

const draftMessageParams = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1),
    kind: z.enum(DRAFT_KINDS).default('text'),
    text: z.string().max(65536).optional(), // body (text) or caption (image/document)
    path: z.string().min(1).optional(), // image / document
    latitude: z.number().optional(), // location
    longitude: z.number().optional(), // location
    name: z.string().optional(), // location name
    contactName: z.string().optional(), // contact
    contactPhone: z.string().optional(), // contact
  })
  .superRefine((v, ctx) => {
    const need = (cond: boolean, msg: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
    };
    if (v.kind === 'text') need(!!v.text, 'text is required for kind=text');
    if (v.kind === 'image' || v.kind === 'document') need(!!v.path, `path is required for kind=${v.kind}`);
    if (v.kind === 'location') need(v.latitude != null && v.longitude != null, 'latitude+longitude required for kind=location');
    if (v.kind === 'contact') need(!!v.contactName && !!v.contactPhone, 'contactName+contactPhone required for kind=contact');
  });
export type DraftMessageParams = z.infer<typeof draftMessageParams>;

const sendBulkParams = z.object({
  from: z.string().min(1).optional(),
  to: z.array(z.string().min(1)).min(1),
  text: z.string().min(1).max(65536),
});
export type SendBulkParams = z.infer<typeof sendBulkParams>;

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
  send_bulk: sendBulkParams,
  draft_message: draftMessageParams,
  confirm_send: draftIdParam,
  cancel_draft: draftIdParam,
  resolve_recipient: resolveParams,
  list_groups: fromParam,
  health_check: fromParam,
  set_default: labelParam,
  reconnect: labelParam,
  disconnect: labelParam,
  relink: labelParam,
  delete_session: labelParam,
};
