/**
 * Host-agnostic MCP responses: every tool result is JSON serialized into the
 * MCP content array's text block — the same convention mailman and this
 * developer's other MCP servers use, so Claude Code / Cursor / Windsurf all
 * parse identically. Errors are structured { code, message } with an optional
 * next_steps hint. See docs/PLAN.md's Output format section.
 */

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // Structural compatibility with the MCP SDK's CallToolResult, which carries
  // an open index signature.
  [key: string]: unknown;
}

export function toolResponse(value: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function toolError(code: string, message: string, nextSteps?: string[]): ToolResponse {
  const payload: Record<string, unknown> = { code, message };
  if (nextSteps && nextSteps.length > 0) payload.next_steps = nextSteps;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}
