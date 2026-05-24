#!/usr/bin/env sh
set -eu

JCOMMENT_DEMO_SELF_TEST=1 \
JCOMMENT_DB=/secret/jcomment.sqlite3 \
JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN=1 \
./dist/jcomment-demo

test ! -e dist/jcomment-cgi.o
test ! -e dist/jcomment-demo.o

tmp="${TMPDIR:-/tmp}/jcomment-demo-check-$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT

PORT=48787 ./dist/jcomment-demo >"$tmp/server.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT
sleep 0.2

curl -fsS "http://127.0.0.1:48787/demo/" >"$tmp/index.html"
grep -q '<j-comment' "$tmp/index.html"

curl -fsS "http://127.0.0.1:48787/jcomment.js" >"$tmp/jcomment.js"
grep -q 'customElements.define' "$tmp/jcomment.js"

curl -sS -D "$tmp/api.headers" -o "$tmp/api.out" -w '%{http_code}' "http://127.0.0.1:48787/api/comments" >"$tmp/api.status"
test "$(cat "$tmp/api.status")" = "200"
if grep -qi '^access-control-allow-origin:' "$tmp/api.headers"; then
  echo "demo API must not expose wildcard CORS" >&2
  exit 1
fi
grep -qi 'cache-control: no-store' "$tmp/api.headers"
grep -qi 'x-content-type-options: nosniff' "$tmp/api.headers"

curl -sS -D "$tmp/cgi.headers" -o "$tmp/cgi.out" -w '%{http_code}' "http://127.0.0.1:48787/jcomment-cgi" >"$tmp/cgi.status"
test "$(cat "$tmp/cgi.status")" = "404"
grep -qi 'cache-control: no-store' "$tmp/cgi.headers"
grep -qi 'x-content-type-options: nosniff' "$tmp/cgi.headers"

curl -sS -D "$tmp/object.headers" -o "$tmp/object.out" -w '%{http_code}' "http://127.0.0.1:48787/jcomment-demo.o" >"$tmp/object.status"
test "$(cat "$tmp/object.status")" = "404"
grep -qi 'cache-control: no-store' "$tmp/object.headers"
grep -qi 'x-content-type-options: nosniff' "$tmp/object.headers"

curl -sS -D "$tmp/hidden.headers" -o "$tmp/hidden.out" -w '%{http_code}' "http://127.0.0.1:48787/.demo-data/jcomment.sqlite3" >"$tmp/hidden.status"
test "$(cat "$tmp/hidden.status")" = "404"
grep -qi 'cache-control: no-store' "$tmp/hidden.headers"
grep -qi 'x-content-type-options: nosniff' "$tmp/hidden.headers"

curl -sS -D "$tmp/put.headers" -o "$tmp/put.out" -w '%{http_code}' -X PUT --data '{}' "http://127.0.0.1:48787/api/comments" >"$tmp/put.status"
test "$(cat "$tmp/put.status")" = "405"
grep -q 'Method not allowed' "$tmp/put.out"
grep -qi 'x-content-type-options: nosniff' "$tmp/put.headers"

kill "$pid"
wait "$pid" 2>/dev/null || true
echo "demo server ok"
