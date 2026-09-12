#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$ROOT/compile.sh"
find "$ROOT/src/test/java" -name '*.java' -print0 | xargs -0 javac --release 17 -encoding UTF-8 -cp "$ROOT/build/classes" -d "$ROOT/build/classes"
exec java -cp "$ROOT/build/classes" biz.capricornus.arcsuite.mcp.adapter.SelfTest
