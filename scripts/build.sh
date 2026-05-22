#!/usr/bin/env sh
set -eu

mkdir -p dist/demo
mkdir -p build/zig-global-cache build/zig-local-cache

ZIG_GLOBAL_CACHE_DIR="$PWD/build/zig-global-cache" \
ZIG_LOCAL_CACHE_DIR="$PWD/build/zig-local-cache" \
zig cc \
  -target wasm32-freestanding \
  -std=c99 \
  -Oz \
  -nostdlib \
  -Wl,--no-entry \
  -Wl,--export-memory \
  -Wl,--export=jcomment_author_ptr \
  -Wl,--export=jcomment_body_ptr \
  -Wl,--export=jcomment_time_ptr \
  -Wl,--export=jcomment_score_ptr \
  -Wl,--export=jcomment_output_ptr \
  -Wl,--export=jcomment_render \
  -Wl,--export=jcomment_output_len \
  -o dist/jcomment.wasm \
  src/widget.c

cp web/jcomment.js dist/jcomment.js
cp demo/index.html dist/demo/index.html

ZIG_GLOBAL_CACHE_DIR="$PWD/build/zig-global-cache" \
ZIG_LOCAL_CACHE_DIR="$PWD/build/zig-local-cache" \
zig build-exe \
  -target x86_64-linux-musl \
  -O ReleaseSmall \
  -femit-bin=dist/jcomment-cgi \
  server/cgi/jcomment_cgi.zig

ZIG_GLOBAL_CACHE_DIR="$PWD/build/zig-global-cache" \
ZIG_LOCAL_CACHE_DIR="$PWD/build/zig-local-cache" \
zig build-exe \
  -O ReleaseSmall \
  -femit-bin=dist/jcomment-demo \
  server/demo_server.zig
