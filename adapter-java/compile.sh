#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
OUT="$ROOT/build/classes"
rm -rf "$OUT"
mkdir -p "$OUT"
find "$ROOT/src/main/java" -name '*.java' -print0 | xargs -0 javac --release 17 -encoding UTF-8 -d "$OUT"
