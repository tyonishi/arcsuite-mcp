#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ -d "$ROOT/build/classes" ] || "$ROOT/compile.sh"
exec java -cp "$ROOT/build/classes" biz.capricornus.arcsuite.mcp.adapter.Main
