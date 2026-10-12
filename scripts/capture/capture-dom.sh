#!/bin/bash
# Hardened headless Microsoft Edge capture, used while researching page structure.
#
# Why this is not a one-liner:
#
#  * Chromium's own sandbox cannot initialise inside the DSH file sandbox, so
#    --no-sandbox is mandatory. Without it the GPU process dies and Edge aborts
#    with "GPU process isn't usable. Goodbye." (Trace/BPT trap: 5).
#  * Crashpad cannot write to ~/Library/Application Support, so crash reporting
#    is redirected into the throwaway profile.
#  * `--dump-dom` alone never exits on a page with ongoing network activity, so
#    every run is wrapped in an explicit watchdog kill.
#  * macOS has no timeout(1) (that is GNU coreutils' gtimeout), hence the
#    background-process + sleep + kill -9 watchdog.
#  * A fresh profile per run avoids ProcessSingleton collisions.
#
# Usage:
#   capture-dom.sh dom   <name> <url> [old|new] [virtualTimeBudgetMs]
#   capture-dom.sh shot  <name> <url> [old|new] [virtualTimeBudgetMs]
#
# Output lands in .tmp-caps/ at the repo root (scratch; not part of the
# deliverable, gitignored).
# For `dom` the DOM is written to <name>.html; for `shot` a PNG to <name>.png.
# stderr is always captured to <name>.(html|log).err for diagnosis.

set -u

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# EDGE_PATH matches the rest of the repo (see scripts/lib/browser.mjs); EDGE_BIN
# is the historical name used by the other capture tools, kept working.
EDGE="${EDGE_PATH:-${EDGE_BIN:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}}"
OUTDIR="$BASE/.tmp-caps"
mkdir -p "$OUTDIR"

ACTION="${1:?usage: capture-dom.sh <dom|shot> <name> <url> [old|new] [budgetMs]}"
NAME="${2:?name required}"
URL="${3:?url required}"
MODE="${4:-old}"
BUDGET="${5:-25000}"

if [ ! -x "$EDGE" ]; then
  echo "Edge not found at: $EDGE" >&2
  echo "Set EDGE_BIN to override." >&2
  exit 3
fi

PROFILE="$OUTDIR/profile-$NAME-$$"
mkdir -p "$PROFILE"

MODE_FLAG="--headless=old"
[ "$MODE" = "new" ] && MODE_FLAG="--headless=new"

ARGS=(
  "$MODE_FLAG"
  --no-sandbox
  --disable-gpu
  --disable-dev-shm-usage
  --disable-crash-reporter
  --disable-breakpad
  --disable-features=Translate,MediaRouter
  --crash-dumps-dir="$PROFILE/crash"
  --no-first-run
  --no-default-browser-check
  --no-service-autorun
  --user-data-dir="$PROFILE"
  --window-size=1440,1000
  --virtual-time-budget="$BUDGET"
)

case "$ACTION" in
  dom)  ARGS+=( --dump-dom );            OUT="$OUTDIR/$NAME.html" ;;
  shot) ARGS+=( --screenshot="$OUTDIR/$NAME.png" ); OUT="$OUTDIR/$NAME.log" ;;
  *)    echo "unknown action: $ACTION" >&2; exit 2 ;;
esac

: > "$OUT"

"$EDGE" "${ARGS[@]}" "$URL" >> "$OUT" 2> "$OUT.err" &
EPID=$!
# Watchdog: give the browser the virtual-time budget plus generous slack.
( sleep $(( BUDGET / 1000 + 30 )); kill -9 "$EPID" 2>/dev/null ) & WPID=$!

wait "$EPID" 2>/dev/null
RC=$?
kill "$WPID" 2>/dev/null
wait "$WPID" 2>/dev/null

BYTES=$(wc -c < "$OUT" | tr -d ' ')
echo "$ACTION $NAME mode=$MODE exit=$RC bytes=$BYTES"
# exit=137 means the watchdog fired, which is normal: the dump/PNG is already
# written by then. Check $BYTES, not $RC.
rm -rf "$PROFILE" 2>/dev/null
