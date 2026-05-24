#!/usr/bin/env sh
set -eu

mkdir -p dist build/zig-global-cache build/zig-local-cache

ZIG_GLOBAL_CACHE_DIR="$PWD/build/zig-global-cache" \
ZIG_LOCAL_CACHE_DIR="$PWD/build/zig-local-cache" \
zig build-exe \
  -O ReleaseSmall \
  -femit-bin=dist/jcomment-demo \
  server/demo_server.zig

rm -f dist/jcomment-demo.o
