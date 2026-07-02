import pc from 'picocolors';

/**
 * The shared diamond-tree vocabulary, ported from mailman's src/cli/tree.ts.
 * Every human-facing `whatsappman <command>` renders through this so status,
 * numbers, doctor, help, etc. all look like one tool. See docs/STANDARDS.md.
 *
 * Glyphs:
 *   ┌ / └  intro / outro (open + close the block)
 *   ◆      section header — carries the single leading blank rail line
 *   ◇      a confirmatory fact under a section (auto-flips to red ■ when false)
 *   ■      an error / failure line
 *   ▲      worth flagging, not a hard failure
 *   │      plain data row
 *
 * Spacing is part of the design: rows attach tightly; only ◆ headers carry the
 * one blank rail line above them.
 */

function line(s: string): void {
  process.stdout.write(s + '\n');
}

export function intro(title: string): void {
  line(pc.gray('┌') + '  ' + pc.bold(title));
}

export function outro(label: string): void {
  line(pc.gray('└') + '  ' + label);
}

/** A section header. Emits a leading blank rail line, then the ◆ title. */
export function section(title: string): void {
  line(pc.gray('│'));
  line(pc.cyan('◆') + '  ' + pc.bold(title));
}

/** A confirmatory fact nested under a section. `ok=false` renders as a red ■. */
export function fact(text: string, ok = true): void {
  if (ok) {
    line(pc.green('◇') + '  ' + text);
  } else {
    line(pc.red('■') + '  ' + text);
  }
}

/** A plain data row under a section. */
export function row(text: string): void {
  line(pc.gray('│') + '  ' + text);
}

/** An error / usage failure line. */
export function fail(text: string): void {
  line(pc.red('■') + '  ' + text);
}

/** Worth flagging, not a hard failure. */
export function attention(text: string): void {
  line(pc.yellow('▲') + '  ' + text);
}

/** Pad a string to a fixed visible width (for aligned table-ish rows). */
export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
