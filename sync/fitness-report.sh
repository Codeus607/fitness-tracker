#!/usr/bin/env bash
# Monthly report: the server builds the report of last month and emails it, and the
# markdown copy is saved in your notes folder as "Fitness Reports/YYYY-MM.md".
#   fitness-report.sh [YYYY-MM] [--force]
# A month that already has a saved report is skipped (no second email) unless --force.
#
# Settings (environment, e.g. via a systemd drop-in, see README):
#   FITNESS_NOTES_DIR   folder holding the .md files   (default ~/Documents/Fitness)
#   FITNESS_HOST        SSH host alias of the server   (default simonsmind)
#   FITNESS_WEB         web folder of the app          (default as in deploy.sh)
set -euo pipefail
NOTES="${FITNESS_NOTES_DIR:-$HOME/Documents/Fitness}"
HOST="${FITNESS_HOST:-simonsmind}"
WEB="${FITNESS_WEB:-domains/simonsmind.com/public_html/fitness}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

MONTH=$(date -d "$(date +%Y-%m-01) -1 day" +%Y-%m)
FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]) MONTH=$a ;;
    *) echo "usage: $0 [YYYY-MM] [--force]" >&2; exit 2 ;;
  esac
done

DIR="$NOTES/Fitness Reports"
OUT="$DIR/$MONTH.md"
if [ -f "$OUT" ] && [ "$FORCE" = 0 ]; then
  echo "report for $MONTH already saved, skipping"
  exit 0
fi
mkdir -p "$DIR"
TMP=$(mktemp "$DIR/.report.XXXXXX")
trap 'rm -f "$TMP"' EXIT
"${SSH[@]}" "$HOST" "php $WEB/report.php $MONTH --send" > "$TMP"
mv "$TMP" "$OUT"
echo "saved $OUT"
