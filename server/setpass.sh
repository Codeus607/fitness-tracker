#!/usr/bin/env bash
# Usage (from your laptop): ssh -t simonsmind bash fitness-data/setpass.sh
set -euo pipefail
cd "$(dirname "$0")"
read -rsp 'New password: ' p; echo
read -rsp 'Repeat: ' q; echo
printf '%s\n%s\n' "$p" "$q" | php setpass.php
