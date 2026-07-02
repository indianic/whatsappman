/**
 * Convert common Markdown to WhatsApp's own formatting markup, so a message
 * composed in Markdown (which is what an LLM naturally writes) renders correctly
 * in WhatsApp instead of showing literal `**` / `[]()` noise.
 *
 * WhatsApp's native markup — passed through untouched because it already works:
 *   *bold*   _italic_   ~strikethrough~   ```monospace```   `inline`
 *   > quote  - bullet   1. numbered      (newlines are literal line breaks)
 *
 * We only rewrite the Markdown forms that DIFFER from WhatsApp's:
 *   **bold** / __bold__  → *bold*        (double markers → WhatsApp bold)
 *   ~~strike~~           → ~strike~
 *   [text](url)          → text (url)     (WhatsApp has no link syntax)
 *   # Heading            → *Heading*      (WhatsApp has no headings → bold line)
 * Single *, _, ~, and backticks are left alone (they're already WhatsApp markup,
 * and rewriting them would break a user who typed WhatsApp syntax directly).
 * Callers can pass `raw` to skip all of this and send verbatim.
 */
export function toWhatsAppMarkup(input: string): string {
  let s = input;

  // Fenced code ```lang\n...``` → drop the language hint (WhatsApp shows ```…```).
  s = s.replace(/```[a-zA-Z0-9]+\n/g, '```\n');

  // Markdown links [text](url) → text (url).
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');

  // Bold: **x** or __x__ → *x* (WhatsApp bold). Non-greedy, no line spanning.
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, '*$1*');
  s = s.replace(/__([^\n_]+?)__/g, '*$1*');

  // Strikethrough: ~~x~~ → ~x~.
  s = s.replace(/~~([^\n~]+?)~~/g, '~$1~');

  // Headings at line start (#..###### Text) → *Text* (bold line). Uses [ \t]
  // (not \s) so it never eats the line's own newline / following blank lines.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*');

  return s;
}
