#!/usr/bin/env bash
# whatsappman — visible command audit in a fresh Terminal window (macOS)
#
# Opens a NEW Terminal.app window and steps through the CLI one command at a
# time, so you can watch each one run and see its verdict as it happens. The
# parent process polls the shared log and summarises when the window signals it
# is done. Same shape as mcphub-checks/sh/check-scaffold-e2e-devops-term.sh.
#
# Why a separate window rather than just running here:
#   A real Terminal gives the CLI a real TTY, which is the whole point — colour
#   is enabled, the diamond-tree layout renders at true width, and the output is
#   what a user actually sees. Piped into a parent process it is none of those
#   things. It also means the run is watchable while it happens instead of
#   arriving as a wall of text at the end.
#
# What this is NOT:
#   Not an eval — nothing here is offline, deterministic or sub-second; it drives
#   a live install. It sits in smoke/ with the other real-artifact checks.
#   `npm run smoke` remains the machine-readable version of the same audit.
#
# Modes:
#   (default)   Read-only commands against your live install. Safe: nothing is
#               sent, nothing is mutated, the daemon is not touched.
#   --docker    ALL 31 commands inside the Linux container, including the
#               destructive ones. The only honest way to watch the full surface,
#               because stop/restart/reset would otherwise kill the daemon
#               holding your real WhatsApp connection.
#
# Flags:
#   --pace SECS   Seconds between commands so you can follow along (default 1.2)
#   --keep        Leave the window open at a shell afterwards (default)
#   --idle SECS   Give up after this long with no new output (default 120)
#   --hard SECS   Hard timeout (default 900)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script uses osascript to open Terminal.app, so it needs macOS."
  echo "On Linux, run the same audit non-visually:  npm run smoke"
  exit 2
fi

# ── Colours ───────────────────────────────────────────────────────────────────
R=$'\033[0;31m' G=$'\033[0;32m' Y=$'\033[1;33m' B=$'\033[0;34m' C=$'\033[0;36m'
M=$'\033[0;35m' BOLD=$'\033[1m' DIM=$'\033[2m' RST=$'\033[0m'

PASS=0 FAIL=0 WARN=0
p() { echo "  ${G}✔${RST}  $(printf '%-50s' "$1") ${DIM}$2${RST}"; PASS=$((PASS+1)); }
f() { echo "  ${R}✘${RST}  $(printf '%-50s' "$1") $2"; FAIL=$((FAIL+1)); }
w() { echo "  ${Y}⚠${RST}  $(printf '%-50s' "$1") $2"; WARN=$((WARN+1)); }
h() { echo ""; echo "  ${BOLD}${B}━━ $1${RST}"; }

# ── Args ──────────────────────────────────────────────────────────────────────
MODE="local"
PACE="1.2"
KEEP=0
REDACT=0
IDLE_LIMIT=120
HARD_LIMIT=900
for arg in "$@"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --pace)   : ;;                       # value consumed below
    --pace=*) PACE="${arg#*=}" ;;
    --idle=*) IDLE_LIMIT="${arg#*=}" ;;
    --hard=*) HARD_LIMIT="${arg#*=}" ;;
    --keep)   KEEP=1 ;;
    --redact) REDACT=1 ;;
    *) ;;
  esac
done
# support "--pace 2" as well as "--pace=2"
prev=""
for arg in "$@"; do
  [[ "$prev" == "--pace" ]] && PACE="$arg"
  [[ "$prev" == "--idle" ]] && IDLE_LIMIT="$arg"
  [[ "$prev" == "--hard" ]] && HARD_LIMIT="$arg"
  prev="$arg"
done

SESSION="wam-term-$(date +%H%M%S)"
WORK_DIR="$(mktemp -d "/tmp/${SESSION}.XXXX")"
LOG="$WORK_DIR/run.log"
PIDFILE="$WORK_DIR/shell.pid"
TTYFILE="$WORK_DIR/shell.tty"
SHOT="$WORK_DIR/audit.png"
INNER="$WORK_DIR/run.sh"

echo ""
echo "  ${BOLD}whatsappman — visible command audit${RST}"
echo ""
echo "  ${DIM}Session${RST}   ${M}${BOLD}${SESSION}${RST}"
echo "  ${DIM}Mode${RST}      ${C}${MODE}${RST}$([[ "$MODE" == "local" ]] && echo "  ${DIM}(read-only — nothing sent, nothing mutated)${RST}")"
echo "  ${DIM}Log${RST}       ${DIM}${LOG}${RST}"

# ══════════════════════════════════════════════════════════════════════════════
h "1. PRE-FLIGHT"
# ══════════════════════════════════════════════════════════════════════════════

if command -v whatsappman >/dev/null 2>&1; then
  p "whatsappman on PATH" "$(command -v whatsappman)"
else
  f "whatsappman on PATH" "install it first: npm install -g @integratex/whatsappman"
  exit 2
fi

if [[ "$MODE" == "docker" ]]; then
  if docker info >/dev/null 2>&1; then
    p "docker running" "full 31-command surface available"
  else
    f "docker running" "start Docker Desktop, or drop --docker for the read-only pass"
    exit 2
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
h "2. BUILD THE RUN SCRIPT"
# ══════════════════════════════════════════════════════════════════════════════

# Written to a file rather than escaped into a one-line osascript string.
# AppleScript needs backslashes and quotes escaped, and the expectation patterns
# below are full of both — a quoting mistake there fails at runtime, inside a
# window that has already opened, which is a miserable thing to debug.
#
# Every entry is `command<TAB>expectation`, and the expectation is the SAME
# rubric smoke/all-commands.mjs applies. This is that audit, made watchable —
# not a second, weaker one that could disagree with it.
cat > "$INNER" <<'INNER_EOF'
#!/usr/bin/env bash
# generated by smoke/check-terminal.sh — safe to delete
set -uo pipefail
G=$'\033[0;32m' R=$'\033[0;31m' Y=$'\033[1;33m' C=$'\033[0;36m' DIM=$'\033[2m' BOLD=$'\033[1m' RST=$'\033[0m'

LOG="__LOG__"
PACE="__PACE__"
exec > >(tee "$LOG") 2>&1

echo ""
echo "  ${BOLD}whatsappman — stepping through the CLI${RST}"
echo "  ${DIM}Each command runs for real. Its output is exactly what you would see.${RST}"
echo ""

OK=0; BAD=0
# step <command> <pattern>...
#
# Each pattern is checked INDEPENDENTLY, because grep matches a line at a time:
# "send.*status" can never match when `send` and `status` are on different lines
# of a help listing, which is exactly how the first version of this reported a
# perfectly healthy `help` as broken. Separate patterns is also what the JS
# rubric in all-commands.mjs does, so the two agree by construction.
step() {
  local cmd="$1"; shift
  local pats=("$@")
  echo ""
  echo "  ${C}${BOLD}\$ whatsappman ${cmd}${RST}"
  echo "  ${DIM}expecting: ${pats[*]}${RST}"
  echo ""
  local out rc
  out="$(eval "whatsappman ${cmd}" 2>&1 </dev/null)"; rc=$?
  echo "$out" | sed 's/^/    /'
  echo ""
  # Strip colour before matching: an escape sequence landing between letters
  # would break a pattern that is otherwise perfectly correct.
  local plain
  plain="$(printf '%s' "$out" | sed $'s/\033\\[[0-9;]*m//g')"
  local missing=()
  local pat
  for pat in "${pats[@]}"; do
    printf '%s' "$plain" | grep -qiE "$pat" || missing+=("$pat")
  done
  if [[ $rc -gt 1 ]]; then
    echo "  ${R}✘ exited ${rc}${RST} — expected 0 (worked) or 1 (declined cleanly)"
    BAD=$((BAD+1))
  elif [[ ${#missing[@]} -eq 0 ]]; then
    echo "  ${G}✔ ok${RST}  ${DIM}exit ${rc} · matched ${#pats[@]} expectation(s)${RST}"
    OK=$((OK+1))
  else
    echo "  ${R}✘ output did not match:${RST} ${missing[*]}  ${DIM}exit ${rc}${RST}"
    BAD=$((BAD+1))
  fi
  echo "  ${DIM}────────────────────────────────────────────────────────────${RST}"
  sleep "$PACE"
}

__STEPS__

echo ""
echo "  ${BOLD}Result:${RST}  ${G}${OK} ok${RST}   ${R}${BAD} failed${RST}"
echo ""
echo "━━ DONE ━━"
echo ""
echo "  ${DIM}Window stays open until the audit finishes capturing it.${RST}"
# Record the shell's pid. `exec` replaces this process image, so the pid is
# unchanged — the parent kills it before closing the window, which is what stops
# Terminal.app popping "closing this window will terminate the running process".
echo $$ > "__PIDFILE__"
tty > "__TTYFILE__" 2>/dev/null
exec $SHELL
INNER_EOF

# The read-only set: safe against a live install, and none of them prompt, so
# none can hang waiting on a TTY that a real Terminal genuinely has.
STEPS=$(cat <<'STEPS_EOF'
step "version"                 "[0-9]+\.[0-9]+\.[0-9]+"
step "doctor"                  "runtime" "daemon" "doctor: (ok|issues found)"
step "status"                  "daemon" "running|not running|down"
step "numbers"                 "connected|disconnected|none linked"
step "settings get"            "draftTtlMinutes|alwaysConfirm|maxBulkRecipients"
step "recent"                  "recent|none|no sends"
step "scheduled"               "scheduled|none|no pending"
step "summary"                 "summary|digest|session|no sessions"
step "examples"                "whatsappman "
step "help"                    "\\bsend\\b" "\\bstatus\\b" "\\bdoctor\\b" "\\blink\\b"
step "daemon install --print"  "launchd|systemd|schtasks|---"
step "run -- node -e \"0\""      "success|failed|exit [0-9]"
STEPS_EOF
)

if [[ "$MODE" == "docker" ]]; then
  # In the container the destructive commands are free, so run the machine
  # audit itself — it already covers all 31 and derives its list from the CLI.
  STEPS='echo "  running the full 31-command audit inside the Linux container"; echo ""; cd "'"$ROOT_DIR"'" && npm run smoke 2>&1 | sed "s/^/    /"; OK=1'
fi

# Substitute the placeholders in shell, so the expectation patterns — which are
# full of quotes and backslashes — pass through untouched.
tmp="$INNER.tmp"
{
  while IFS= read -r line; do
    case "$line" in
      *__STEPS__*) printf '%s\n' "$STEPS" ;;
      *) line="${line//__LOG__/$LOG}"; line="${line//__PIDFILE__/$PIDFILE}"; printf '%s\n' "${line//__TTYFILE__/$TTYFILE}" ;;
    esac
  done < "$INNER"
} > "$tmp"
sed -i '' "s|__PACE__|$PACE|g" "$tmp"
mv "$tmp" "$INNER"
chmod +x "$INNER"
p "run script written" "$(grep -c '^step ' "$INNER" 2>/dev/null || echo 1) step(s)"

# ══════════════════════════════════════════════════════════════════════════════
h "3. OPEN A FRESH TERMINAL WINDOW"
# ══════════════════════════════════════════════════════════════════════════════

# Identify the new window by DIFFING the window list, not by asking for the
# front window.
#
# `id of front window` immediately after `do script` returns the window that was
# frontmost BEFORE the new one appeared — verified here: the new window was
# 32247 while front window reported 32218. Every downstream use of that id then
# targets somebody else's window, which is how an earlier version of this
# screenshotted an unrelated Downloads window and reported the audit window as
# still open. Set arithmetic has no such race.
BEFORE_IDS=$(osascript -e 'tell application "Terminal" to get id of every window' 2>/dev/null | tr -d ' ' | tr ',' '\n' | sort)
osascript -e "tell application \"Terminal\" to do script \"bash '$INNER'\"" >/dev/null 2>&1
sleep 0.8
AFTER_IDS=$(osascript -e 'tell application "Terminal" to get id of every window' 2>/dev/null | tr -d ' ' | tr ',' '\n' | sort)
WIN_ID=$(comm -13 <(printf '%s\n' "$BEFORE_IDS") <(printf '%s\n' "$AFTER_IDS") | head -1)
# Hard guard: only ever act on a window that did not exist before we started.
#
# This is not paranoia. An earlier version resolved the wrong id, and its
# tty-hangup fallback killed a window the user had open and was using. Every
# destructive step below — pkill, close — is gated on this, so the worst a bad
# id can now do is leave our own window open.
if [[ -n "${WIN_ID:-}" ]] && printf '%s\n' "$BEFORE_IDS" | grep -qx "$WIN_ID"; then
  w "window id looks pre-existing" "refusing to manage it — the window will be left open"
  WIN_ID=""
  OURS=0
elif [[ -n "${WIN_ID:-}" ]]; then
  OURS=1
else
  OURS=0
fi

if [[ -n "${WIN_ID:-}" ]]; then
  p "Terminal.app window opened" "window id ${WIN_ID} — watch the commands run there"
  osascript -e 'tell application "Terminal" to activate' >/dev/null 2>&1
else
  f "Terminal.app" "could not open a window"
  exit 2
fi

# ══════════════════════════════════════════════════════════════════════════════
h "4. FOLLOWING ALONG"
# ══════════════════════════════════════════════════════════════════════════════

echo ""
echo "  ${DIM}Polling every 2s. Stops on: DONE | idle > ${IDLE_LIMIT}s | hard > ${HARD_LIMIT}s${RST}"
echo ""

ELAPSED=0 IDLE=0 LAST=0 DONE=false
while [[ "$ELAPSED" -lt "$HARD_LIMIT" ]]; do
  if [[ -f "$LOG" ]] && grep -q "━━ DONE ━━" "$LOG" 2>/dev/null; then DONE=true; break; fi
  CUR=0; [[ -f "$LOG" ]] && CUR=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
  if [[ "$CUR" != "$LAST" ]]; then IDLE=0; LAST="$CUR"; else IDLE=$((IDLE + 2)); fi
  if [[ "$IDLE" -ge "$IDLE_LIMIT" ]]; then
    echo ""
    w "no output for ${IDLE_LIMIT}s" "check the Terminal window — it may be waiting on you"
    break
  fi
  # Mirror the last verdict line so this window is informative too.
  LASTLINE=""
  [[ -f "$LOG" ]] && LASTLINE=$(grep -aoE '\$ whatsappman [a-z-]+' "$LOG" 2>/dev/null | tail -1)
  printf "\r  ${DIM}%ss · %s bytes · %s${RST}\033[K" "$ELAPSED" "$CUR" "${LASTLINE:-starting}"
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo ""

$DONE && p "run completed" "window left open for scrollback"

# ══════════════════════════════════════════════════════════════════════════════
h "5. CAPTURE + CLOSE"
# ══════════════════════════════════════════════════════════════════════════════

# Render the captured output to an image.
#
# The obvious approach — screencapture -l<window-id> — was tried and REMOVED.
# The id AppleScript reports for a Terminal window is not the CoreGraphics
# window id that screencapture -l expects, so it silently photographs whatever
# unrelated window happens to hold that id: a run of this audit produced a
# perfectly sharp screenshot of a Downloads window. A wrong image that looks
# right is worse than no image, and it also needs Screen Recording permission
# that CI will never have.
#
# So the log is rendered through headless Chrome instead. Not a photograph of
# the window — a faithful rendering of what the window showed, which for
# reviewing a run is the same information, and it is deterministic, needs no
# permission, and works where there is no window to photograph at all.
RARGS=()
[[ "$REDACT" == "1" ]] && RARGS+=(--redact)
if node "$SCRIPT_DIR/log-to-png.mjs" "$LOG" "$SHOT" "whatsappman — command audit" "${RARGS[@]:-}" >/dev/null 2>&1 && [[ -s "$SHOT" ]]; then
  SHOT_KIND="rendered from the run log"
  p "captured the output" "$(du -h "$SHOT" | cut -f1)$([[ "$REDACT" == "1" ]] && echo " ${DIM}(redacted)${RST}")"
else
  w "capture" "could not render an image from the log"
fi

if [[ "$KEEP" == "1" ]]; then
  p "window left open" "--keep was passed"
elif [[ "${OURS:-0}" != "1" ]]; then
  w "not closing" "could not confirm the window is one we opened"
else
  # Closing is ASYNCHRONOUS and `saving no` is what makes it happen at all.
  #
  # Terminal runs `do script` inside a login shell, so killing the audit script
  # leaves that shell alive, and a plain `close` on a window with a live process
  # silently does nothing — Terminal is waiting on a "terminate the running
  # process?" dialog nobody is there to answer. `saving no` answers it.
  #
  # But it returns rc=0 immediately and the window can take a couple of seconds
  # to actually go. Checking once, half a second later, reported "still open"
  # for a window that closed fine a moment afterwards. So this polls.
  #
  # Everything here is gated on OURS: only a window that did not exist before
  # this script started is ever killed or closed.
  [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null
  sleep 0.3

  win_count() {
    osascript -e "tell application \"Terminal\" to (count of (every window whose id is ${WIN_ID:-0}))" 2>/dev/null || echo 1
  }

  CLOSED=0
  # Terminal's close is asynchronous and can take a good while — a run here
  # reported "still open" after six seconds for a window that had gone by the
  # time it was checked again. Ask once, then wait properly.
  osascript -e "tell application \"Terminal\" to close (every window whose id is ${WIN_ID:-0}) saving no" >/dev/null 2>&1
  for _ in $(seq 1 12); do
    [[ "$(win_count)" == "0" ]] && { CLOSED=1; break; }
    sleep 1
  done

  # Still there: hang up the tty. The tty comes from the INNER script, which
  # simply ran `tty` — AppleScript's own window addressing is not dependable
  # here (`window id N` errors -1728 for a window `count ... whose id is N`
  # simultaneously reports as present), so it is not used for anything
  # destructive.
  if [[ "$CLOSED" != "1" && -s "$TTYFILE" ]]; then
    TTY="$(cat "$TTYFILE")"
    if [[ "$TTY" == /dev/* ]]; then
      pkill -t "${TTY#/dev/}" 2>/dev/null
      sleep 1
      osascript -e "tell application \"Terminal\" to close (every window whose id is ${WIN_ID:-0}) saving no" >/dev/null 2>&1
      for _ in 1 2 3 4 5; do
        [[ "$(win_count)" == "0" ]] && { CLOSED=1; break; }
        sleep 1
      done
    fi
  fi

  if [[ "$CLOSED" == "1" ]]; then
    p "window closed" "capture kept at $(basename "$SHOT")"
  else
    w "close requested" "Terminal has not closed id ${WIN_ID} yet — it usually does shortly"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
h "6. VERDICT"
# ══════════════════════════════════════════════════════════════════════════════

if [[ ! -s "$LOG" ]]; then
  f "output" "the log is empty — the window may have failed to start"
else
  # `grep -c` PRINTS 0 and EXITS 1 when there are no matches, so a `|| echo 0`
  # fallback appends a second zero and the result is the two-line string "0\n0",
  # which [[ ]] then refuses to compare. The count is already correct without it.
  OKC=$(grep -ac "✔ ok" "$LOG" 2>/dev/null); OKC=${OKC:-0}
  BADC=$(grep -ac "✘ " "$LOG" 2>/dev/null); BADC=${BADC:-0}
  [[ "$OKC" -gt 0 ]] && p "commands passed" "$OKC"
  if [[ "$BADC" -gt 0 ]]; then
    f "commands failed" "$BADC — see the window, or $LOG"
    echo ""
    grep -a -B4 "✘" "$LOG" 2>/dev/null | sed 's/^/    /' | head -40
  fi
fi

echo ""
echo "  ${G}✔ $PASS passed${RST}  ${R}✘ $FAIL failed${RST}  ${Y}⚠ $WARN warnings${RST}"
echo "  ${DIM}Log:${RST}   ${C}$LOG${RST}"
[[ -s "$SHOT" ]] && echo "  ${DIM}Image:${RST} ${C}$SHOT${RST} ${DIM}(${SHOT_KIND})${RST}"
echo ""
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
