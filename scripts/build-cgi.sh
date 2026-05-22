#!/usr/bin/env sh
set -eu

mkdir -p dist build/zig-global-cache build/zig-local-cache

ZIG_GLOBAL_CACHE_DIR="$PWD/build/zig-global-cache" \
ZIG_LOCAL_CACHE_DIR="$PWD/build/zig-local-cache" \
zig build-exe \
  -target x86_64-linux-musl \
  -O ReleaseSmall \
  -femit-bin=dist/jcomment-cgi \
  server/cgi/jcomment_cgi.zig
