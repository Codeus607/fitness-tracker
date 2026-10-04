#!/usr/bin/env bash
# Deploy the app to fitness.simonsmind.com. Needs the `simonsmind` SSH alias.
set -euo pipefail
cd "$(dirname "$0")"
HOST=simonsmind
WEB=domains/simonsmind.com/public_html/fitness
DATA=fitness-data

ssh "$HOST" "mkdir -p $WEB $DATA && chmod 700 $DATA && \
  [ -f $WEB/config.php ] || echo '<?php define(\"DATA_DIR\", \"'\$HOME/$DATA'\"); define(\"TIMEZONE\", \"$(timedatectl show -p Timezone --value)\");' > $WEB/config.php"
# bump the service-worker cache so phones pick up the new version
sed -i "s/const CACHE = 'fitness-[^']*'/const CACHE = 'fitness-$(date +%s)'/" public/sw.js
rsync -a --delete --exclude config.php public/ "$HOST:$WEB/"
rsync -a server/setpass.php server/setpass.sh "$HOST:$DATA/"
echo "Deployed to https://fitness.simonsmind.com"
