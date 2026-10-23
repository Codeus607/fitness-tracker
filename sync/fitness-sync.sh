#!/usr/bin/env bash
# Sync between your notes folder and the server:
#   notes "Fitness Exercises.md"  ->  server exercises.md   (your editable list)
#   server Fitness.md             ->  notes Fitness.md      (read-only backup)
#   server fitness.sqlite         ->  local snapshot        (full restorable backup)
#
# Settings (environment, e.g. via a systemd drop-in, see README):
#   FITNESS_NOTES_DIR   folder holding the .md files   (default ~/Documents/Fitness)
#   FITNESS_BACKUP_DIR  where database snapshots go    (default ~/.local/share/fitness-tracker)
#   FITNESS_HOST        SSH host alias of the server   (default simonsmind)
set -euo pipefail
NOTES="${FITNESS_NOTES_DIR:-$HOME/Documents/Fitness}"
BACKUP="${FITNESS_BACKUP_DIR:-$HOME/.local/share/fitness-tracker}"
HOST="${FITNESS_HOST:-simonsmind}"
# keepalives drop a dead connection after ~1 min instead of hanging for hours
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

if [ -f "$NOTES/Fitness Exercises.md" ]; then
  rsync -t --checksum -e "${SSH[*]}" "$NOTES/Fitness Exercises.md" "$HOST:fitness-data/exercises.md"
fi

# only touch local copies once the server has data
if "${SSH[@]}" "$HOST" test -f fitness-data/fitness.sqlite; then
  rsync -t --checksum -e "${SSH[*]}" "$HOST:fitness-data/Fitness.md" "$NOTES/Fitness.md"

  # VACUUM INTO makes a consistent copy even if a set is being saved right now
  "${SSH[@]}" "$HOST" 'cd fitness-data && rm -f snapshot.sqlite &&
    php -r "(new PDO(\"sqlite:fitness.sqlite\"))->exec(\"VACUUM INTO \x27snapshot.sqlite\x27\");"'
  mkdir -p "$BACKUP"
  rsync -t -e "${SSH[*]}" "$HOST:fitness-data/snapshot.sqlite" "$BACKUP/fitness.sqlite"
  # plus one dated copy per day, kept for 30 days
  cp -n "$BACKUP/fitness.sqlite" "$BACKUP/fitness-$(date +%F).sqlite"
  find "$BACKUP" -name 'fitness-*.sqlite' -mtime +30 -delete
fi
