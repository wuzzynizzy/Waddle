#!/bin/sh
# One-step local startup for a Waddle source checkout.
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo 'Waddle needs Node.js 20 or newer. Install Node, then run this again.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Waddle needs Node.js 20 or newer; found $(node --version)." >&2
  exit 1
fi

export WADDLE_PROFILE="${WADDLE_PROFILE:-small}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=320}"
export WADDLE_OPEN_BROWSER="${WADDLE_OPEN_BROWSER:-1}"
exec node server.js
