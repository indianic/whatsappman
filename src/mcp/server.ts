import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { request } from '../ipc/client.js';
import { toolResponse, toolError } from '../response.js';
import { WhatsAppManError } from '../errors.js';
import { getVersion } from '../version.js';
import type { Method } from '../ipc/protocol.js';

/**
 * MCP tool registry. Each tool is a thin proxy to a daemon IPC method. Sending
 * is gated: there is no one-shot "send" tool — the model must draft_message
 * (preview, no send) then confirm_send (the only dispatcher, idempotent). See
 * docs/SKILLS.md.
 */
interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  method: Method;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: props,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

const TOOLS: Record<string, ToolDef> = {
  get_status: {
    description:
      'Daemon status + the state of all linked WhatsApp numbers (sessions) + pending-scheduled count. Returns JSON.',
    inputSchema: obj({}),
    method: 'status',
  },
  list_sessions: {
    description: 'List all linked WhatsApp numbers with label, phone, status, and which is default.',
    inputSchema: obj({}),
    method: 'list_sessions',
  },
  health_check: {
    description:
      'Can a given number (or the default) send right now? Returns { ok, status, canSend, reason }.',
    inputSchema: obj({ from: str('session label; omit for the default') }),
    method: 'health_check',
  },
  resolve_recipient: {
    description:
      'Resolve a name / phone / group reference to a WhatsApp JID before drafting. Returns a single match, or { candidates } when ambiguous.',
    inputSchema: obj(
      { from: str('session label; omit for default'), query: str('name, phone, or JID') },
      ['query'],
    ),
    method: 'resolve_recipient',
  },
  list_groups: {
    description: 'List the WhatsApp groups a number belongs to (jid, subject, participant count).',
    inputSchema: obj({ from: str('session label; omit for default') }),
    method: 'list_groups',
  },
  draft_message: {
    description:
      'Build a preview of a message and store it as a draft. Does NOT send. Supports kind=text|image|document|location|contact. For image/document, pass an absolute file `path` (sensitive paths like ~/.ssh or .env are refused) with optional `text` caption. Returns { draftId, preview, expiresInSec }. Show the preview to the user and get explicit confirmation, then call confirm_send.',
    inputSchema: obj(
      {
        from: str('session label; omit for the default number'),
        to: str('recipient: a saved contact/group name, a phone number, or a JID'),
        kind: { type: 'string', enum: ['text', 'image', 'document', 'location', 'contact'], description: 'message kind (default text)' },
        text: str('message body (kind=text) or caption (image/document)'),
        path: str('absolute file path for kind=image|document'),
        latitude: num('latitude for kind=location'),
        longitude: num('longitude for kind=location'),
        name: str('place name for kind=location'),
        contactName: str('display name for kind=contact'),
        contactPhone: str('phone number for kind=contact'),
      },
      ['to'],
    ),
    method: 'draft_message',
  },
  confirm_send: {
    description:
      'Send a previously drafted message. The ONLY tool that dispatches. Idempotent: replaying a draftId returns the original result instead of re-sending. Runs a pre-send health check and returns a clear error (never a false "sent") if the number is not connected.',
    inputSchema: obj({ draftId: str('the id returned by draft_message') }, ['draftId']),
    method: 'confirm_send',
  },
  cancel_draft: {
    description: 'Discard a pending draft without sending.',
    inputSchema: obj({ draftId: str('the id returned by draft_message') }, ['draftId']),
    method: 'cancel_draft',
  },
  schedule_send: {
    description:
      'Send a previously drafted message at a future time, fired by the always-on daemon (works even if this session is closed). The draft is snapshotted, so it is fine for it to expire afterward. One-time only. Returns { scheduledId, fireAt }.',
    inputSchema: obj(
      { draftId: str('the id returned by draft_message'), fireAt: str('ISO-8601 time to send, e.g. 2026-07-03T09:00:00+05:30') },
      ['draftId', 'fireAt'],
    ),
    method: 'schedule_send',
  },
  list_scheduled: {
    description: 'List scheduled sends (optionally filtered by status: pending|sent|failed|cancelled).',
    inputSchema: obj({ status: str('optional status filter') }),
    method: 'list_scheduled',
  },
  cancel_scheduled: {
    description: 'Cancel a pending scheduled send.',
    inputSchema: obj({ scheduledId: str('the id returned by schedule_send') }, ['scheduledId']),
    method: 'cancel_scheduled',
  },
  list_recent: {
    description:
      'Recent send history (metadata only — no message bodies): timestamp, session, recipient, kind, message id, status. Optionally filter by session.',
    inputSchema: obj({ limit: num('max entries (default 20)'), from: str('session label filter') }),
    method: 'list_recent',
  },
};

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'whatsappman', version: getVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const def = TOOLS[name];
    if (!def) return toolError('UNKNOWN_METHOD', `unknown tool: ${name}`);
    try {
      const result = await request(def.method, req.params.arguments ?? {});
      return toolResponse(result);
    } catch (err) {
      if (err instanceof WhatsAppManError) return toolError(err.code, err.message, err.nextSteps);
      return toolError('INTERNAL', String((err as Error)?.message ?? err));
    }
  });

  await server.connect(new StdioServerTransport());
}
