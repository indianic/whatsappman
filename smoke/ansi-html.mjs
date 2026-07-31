/**
 * ANSI (SGR) escape sequences to HTML.
 *
 * Shared by the cast recorder and the log-to-image renderer, which both need to
 * show terminal output as it actually looked. Kept in one place because the
 * palette is the interesting part: whatsappman renders its QR with 256-colour
 * codes specifically so black and white stay exact, and a converter that only
 * understood the basic 8 would quietly render that as grey.
 */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The 256-colour palette entries the CLI actually uses, plus the basic 8. */
const BASIC = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf'];
const BRIGHT = ['#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];

function ansiToHtml(raw) {
  let html = '';
  let open = false;
  let i = 0;
  while (i < raw.length) {
    const m = /^\[([0-9;]*)m/.exec(raw.slice(i));
    if (m) {
      const codes = m[1].split(';').filter(Boolean).map(Number);
      if (open) {
        html += '</span>';
        open = false;
      }
      const style = [];
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 1) style.push('font-weight:700');
        else if (c === 2) style.push('opacity:.62');
        else if (c === 3) style.push('font-style:italic');
        else if (c >= 30 && c <= 37) style.push(`color:${BASIC[c - 30]}`);
        else if (c >= 90 && c <= 97) style.push(`color:${BRIGHT[c - 90]}`);
        else if ((c === 38 || c === 48) && codes[k + 1] === 5) {
          const n = codes[k + 2];
          const prop = c === 38 ? 'color' : 'background';
          style.push(`${prop}:${xterm256(n)}`);
          k += 2;
        }
      }
      if (style.length) {
        html += `<span style="${style.join(';')}">`;
        open = true;
      }
      i += m[0].length;
      continue;
    }
    // Drop cursor/erase sequences the recorder picks up; they mean nothing here.
    const other = /^\[[0-9;?]*[A-Za-z]/.exec(raw.slice(i));
    if (other) {
      i += other[0].length;
      continue;
    }
    html += esc(raw[i] === '\r' ? '' : raw[i]);
    i++;
  }
  if (open) html += '</span>';
  return html;
}

function xterm256(n) {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const to = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${to(Math.floor(c / 36))},${to(Math.floor(c / 6) % 6)},${to(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}


export { ansiToHtml, xterm256, esc };
