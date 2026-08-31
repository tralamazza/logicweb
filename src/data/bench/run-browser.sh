#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Daniel Tralamazza
# Build the bench, serve it cross-origin isolated, and drive Brave at it.
#
#   src/data/bench/run-browser.sh            # 100M samples, 1000 columns
#   SAMPLES=10000000 src/data/bench/run-browser.sh
#
# Brave is used because it is the only WebUSB-capable browser on this machine, so it is
# the browser this project will actually run in. It is Chromium, so the numbers transfer.
#
# Every run writes into its own timestamped directory under /tmp/logicweb-bench and this
# script DELETES NOTHING - not the output directory, not the browser profile. An earlier
# version started with `rm -rf` on its output directory, which meant no run's artifact
# survived the next one and not one number in NOTES.md could be audited afterwards. If you
# want the old runs gone, remove them yourself, deliberately.
set -eu

repo=$(cd "$(dirname "$0")/../../.." && pwd)
stamp=$(date +%Y%m%d-%H%M%S)
outdir=/tmp/logicweb-bench/$stamp
result=$outdir/result.json
samples=${SAMPLES:-100000000}
bins=${BINS:-1000}
port=${PORT:-5297}
brave=${BRAVE:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}

mkdir -p "$outdir"
echo "run directory: $outdir"

"$repo/node_modules/.bin/esbuild" "$repo/src/data/bench/main.ts" \
  --bundle --format=esm --target=es2022 --outfile="$outdir/main.js"
cp "$repo/src/data/bench/index.html" "$outdir/"

node "$repo/src/data/bench/serve.mjs" "$outdir" "$result" "$port" >"$outdir/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
sleep 1

# Headed by default: headless Brave reports hardwareConcurrency 2 on this machine and is
# not the environment the app will run in. HEADLESS=1 to force headless.
# The profile directory is left behind on purpose; this script does not delete things.
profile=$(mktemp -d)
echo "browser profile: $profile"
# shellcheck disable=SC2086
"$brave" \
  --user-data-dir="$profile" \
  --no-first-run --no-default-browser-check --disable-brave-update \
  ${HEADLESS:+--headless=new --disable-gpu} \
  --js-flags=--max-old-space-size=6144 \
  "http://127.0.0.1:$port/?samples=$samples&bins=$bins" >"$outdir/brave.log" 2>&1 &
browser=$!
trap 'kill $server $browser 2>/dev/null || true' EXIT

wait $server || true
kill $browser 2>/dev/null || true

if [ -f "$result" ]; then
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const text = (r.log || []).join("\n");
    fs.writeFileSync(process.argv[2], text + "\n");
    console.log(text);
  ' "$result" "$outdir/bench.log"
  echo ""
  echo "artifacts kept in $outdir (result.json, bench.log, main.js, brave.log, server.log)"
else
  echo "no result produced; brave log:" >&2
  cat "$outdir/brave.log" >&2
  exit 1
fi
