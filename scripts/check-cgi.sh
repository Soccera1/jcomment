#!/usr/bin/env sh
set -eu

tmp="${TMPDIR:-/tmp}/jcomment-cgi-check-$$"
mkdir -p "$tmp"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT
export SERVER_NAME=cgi
export JCOMMENT_PASSWORD_RESET_COMMAND=/bin/true
export REMOTE_ADDR=127.0.0.1

test ! -e dist/jcomment-cgi.o

env \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/missing-data-dir.out" 2>"$tmp/missing-data-dir.err"
grep -q 'JCOMMENT_DATA_DIR is required' "$tmp/missing-data-dir.out"

unsafe_dir="$tmp/unsafe-data"
mkdir -p "$unsafe_dir"
chmod 755 "$unsafe_dir"
env \
  JCOMMENT_DATA_DIR="$unsafe_dir" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/unsafe-data-dir.out"
grep -q 'JCOMMENT_DATA_DIR must be a private directory' "$tmp/unsafe-data-dir.out"
chmod 700 "$unsafe_dir"

ln -s "$tmp" "$tmp/data-link"
env \
  JCOMMENT_DATA_DIR="$tmp/data-link" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/symlink-data-dir.out"
grep -q 'JCOMMENT_DATA_DIR must be a private directory' "$tmp/symlink-data-dir.out"

mkdir -p "$tmp/symlink-parent-target"
ln -s "$tmp/symlink-parent-target" "$tmp/symlink-parent-link"
env \
  JCOMMENT_DATA_DIR="$tmp/symlink-parent-link/nested" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/symlink-parent.out"
grep -q 'JCOMMENT_DATA_DIR must be a private directory' "$tmp/symlink-parent.out"

env \
  JCOMMENT_DATA_DIR="$tmp/../jcomment-cgi-parent-traversal" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/parent-traversal-data-dir.out"
grep -q 'JCOMMENT_DATA_DIR must be a private directory' "$tmp/parent-traversal-data-dir.out"

symlink_db_dir="$tmp/symlink-db"
mkdir -p "$symlink_db_dir"
chmod 700 "$symlink_db_dir"
ln -s "$tmp/target.sqlite3" "$symlink_db_dir/jcomment.sqlite3"
env \
  JCOMMENT_DATA_DIR="$symlink_db_dir" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/symlink-db.out"
grep -q 'JCOMMENT_DATA_DIR must be a private directory' "$tmp/symlink-db.out"

symlink_marker_dir="$tmp/symlink-marker"
mkdir -p "$symlink_marker_dir"
chmod 700 "$symlink_marker_dir"
ln -s "$tmp/target-marker" "$symlink_marker_dir/.jcomment-schema-v2"
env \
  JCOMMENT_DATA_DIR="$symlink_marker_dir" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/symlink-marker.out"
grep -q 'JCOMMENT_DATA_DIR must be a private directory' "$tmp/symlink-marker.out"

sqlite_fail_dir="$tmp/sqlite-fail"
mkdir -p "$sqlite_fail_dir"
chmod 700 "$sqlite_fail_dir"
cat >"$tmp/sqlite-fail-bin" <<'SH'
#!/bin/sh
printf 'sqlite wrapper leaked secret-reset-token\n' >&2
exit 1
SH
chmod 700 "$tmp/sqlite-fail-bin"
env \
  JCOMMENT_DATA_DIR="$sqlite_fail_dir" \
  JCOMMENT_SQLITE_BIN="$tmp/sqlite-fail-bin" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/sqlite-fail.out" 2>"$tmp/sqlite-fail.err" || true
! grep -q 'secret-reset-token' "$tmp/sqlite-fail.err"
grep -q 'sqlite command failed' "$tmp/sqlite-fail.err"
grep -q 'Status: 500 Internal Server Error' "$tmp/sqlite-fail.out"
grep -q 'Storage operation failed' "$tmp/sqlite-fail.out"

post_body='{"author":"Ada","body":"Hello from CGI"}'
post_len=$(printf '%s' "$post_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/post.out" <<JSON
$post_body
JSON

grep -q '"comments":' "$tmp/post.out"
grep -q 'Cache-Control: no-store' "$tmp/post.out"
grep -q 'Pragma: no-cache' "$tmp/post.out"
grep -q 'X-Content-Type-Options: nosniff' "$tmp/post.out"
! grep -q 'Access-Control-Allow-Origin' "$tmp/post.out"
quota_thread_dir="$tmp/quota-thread"
mkdir -p "$quota_thread_dir"
chmod 700 "$quota_thread_dir"
env \
  JCOMMENT_DATA_DIR="$quota_thread_dir" \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  JCOMMENT_MAX_COMMENTS_PER_THREAD=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=quota-thread' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/quota-thread-first.out" <<JSON
$post_body
JSON
grep -q '"comments":' "$tmp/quota-thread-first.out"
env \
  JCOMMENT_DATA_DIR="$quota_thread_dir" \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  JCOMMENT_MAX_COMMENTS_PER_THREAD=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=quota-thread' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/quota-thread-second.out" <<JSON
$post_body
JSON
grep -q 'Comment store is full' "$tmp/quota-thread-second.out"
quota_site_dir="$tmp/quota-site"
mkdir -p "$quota_site_dir"
chmod 700 "$quota_site_dir"
env \
  JCOMMENT_DATA_DIR="$quota_site_dir" \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  JCOMMENT_MAX_COMMENTS_PER_SITE=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=quota-site-a' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/quota-site-first.out" <<JSON
$post_body
JSON
grep -q '"comments":' "$tmp/quota-site-first.out"
env \
  JCOMMENT_DATA_DIR="$quota_site_dir" \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  JCOMMENT_MAX_COMMENTS_PER_SITE=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=quota-site-b' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/quota-site-second.out" <<JSON
$post_body
JSON
grep -q 'Comment store is full for this site' "$tmp/quota-site-second.out"
format_body=$(printf '{"author":"A\342\200\215da","body":"Hello\342\200\215CGI"}')
format_len=$(printf '%s' "$format_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi-format' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$format_len" \
  ./dist/jcomment-cgi >"$tmp/post-format.out" <<JSON
$format_body
JSON
grep -q '"author":"Ada"' "$tmp/post-format.out"
grep -q '"body":"HelloCGI"' "$tmp/post-format.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REMOTE_ADDR='203.0.113.10, 198.51.100.10' \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/post-bad-remote-addr.out" <<JSON
$post_body
JSON
grep -q 'Server rate limit identity is not configured' "$tmp/post-bad-remote-addr.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REMOTE_ADDR='127.evil' \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/post-bad-localhost-addr.out" <<JSON
$post_body
JSON
grep -q 'Server rate limit identity is not configured' "$tmp/post-bad-localhost-addr.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REMOTE_ADDR='+127.0.0.1' \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/post-plus-localhost-addr.out" <<JSON
$post_body
JSON
grep -q 'Server rate limit identity is not configured' "$tmp/post-plus-localhost-addr.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REMOTE_ADDR='12_7.0.0.1' \
  JCOMMENT_TRUST_PROXY_HEADERS=1 \
  JCOMMENT_TRUST_PROXY_HEADER=x-real-ip \
  HTTP_X_REAL_IP='203.0.113.10' \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/post-underscore-localhost-proxy-addr.out" <<JSON
$post_body
JSON
grep -q 'Server rate limit identity is not configured' "$tmp/post-underscore-localhost-proxy-addr.out"
test "$(stat -c '%a' "$tmp")" = "700"
test -s "$tmp/jcomment.sqlite3"
sqlite3 "$tmp/jcomment.sqlite3" '.tables' | grep -q 'comments'
test -f "$tmp/.jcomment-schema-v2"
sqlite3 "$tmp/jcomment.sqlite3" 'drop index accounts_site_username_key_idx;'
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/schema-marker-migration.out"
test "$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from sqlite_master where type = 'index' and name = 'accounts_site_username_key_idx';")" = "1"
test "$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from sqlite_master where type = 'index' and name = 'resets_site_username_idx';")" = "1"
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$tmp/post.out" | head -n 1)
test -n "$id"

legacy_tmp="$tmp/legacy-parent-id"
mkdir -p "$legacy_tmp"
chmod 700 "$legacy_tmp"
sqlite3 "$legacy_tmp/jcomment.sqlite3" "create table comments(id text primary key, site text not null default 'default', thread text not null, author text not null, body text not null, created_at text not null, score integer not null default 0); insert into comments(id, site, thread, author, body, created_at, score) values('legacy-cgi-comment', 'cgi', 'legacy-cgi-thread', 'Ada', 'Legacy CGI root', '2026-01-01T00:00:00.000Z', 0);"
env \
  JCOMMENT_DATA_DIR="$legacy_tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=legacy-cgi-thread' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$legacy_tmp/legacy-parent-id.out"
grep -q '"id":"legacy-cgi-comment"' "$legacy_tmp/legacy-parent-id.out"
grep -q '"parentId":""' "$legacy_tmp/legacy-parent-id.out"

oversized_body=$(printf '%8193s' x)
oversized_len=$(printf '%s' "$oversized_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$oversized_len" \
  ./dist/jcomment-cgi >"$tmp/oversized.out" <<JSON
$oversized_body
JSON
grep -q 'Request body is too large' "$tmp/oversized.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH='not-a-number' \
  ./dist/jcomment-cgi >"$tmp/bad-content-length.out"
grep -q 'Invalid request body' "$tmp/bad-content-length.out"

long_query='thread='
i=0
while [ "$i" -lt 9000 ]; do
  long_query="${long_query}x"
  i=$((i + 1))
done
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING="$long_query" \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/long-query.out"
grep -q 'Request metadata is too large' "$tmp/long-query.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE="$long_query" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/long-email-mode.out"
grep -q 'Request metadata is too large' "$tmp/long-email-mode.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN="$long_query" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/long-cors-origin.out"
grep -q 'Request metadata is too large' "$tmp/long-cors-origin.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=PUT \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH='+2' \
  ./dist/jcomment-cgi >"$tmp/put-method.out" <<JSON
{}
JSON
grep -q 'Method not allowed' "$tmp/put-method.out"
! grep -q 'Invalid request body' "$tmp/put-method.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=PATCH \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/login' \
  CONTENT_LENGTH='+2' \
  ./dist/jcomment-cgi >"$tmp/patch-login-method.out" <<JSON
{}
JSON
grep -q 'Method not allowed' "$tmp/patch-login-method.out"
! grep -q 'Invalid request body' "$tmp/patch-login-method.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH='+2' \
  ./dist/jcomment-cgi >"$tmp/plus-content-length.out" <<JSON
{}
JSON
grep -q 'Invalid request body' "$tmp/plus-content-length.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH='1_0' \
  ./dist/jcomment-cgi >"$tmp/underscore-content-length.out" <<JSON
{}
JSON
grep -q 'Invalid request body' "$tmp/underscore-content-length.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH='4' \
  ./dist/jcomment-cgi >"$tmp/short-body.out" <<JSON
{}
JSON
grep -q 'Invalid request body' "$tmp/short-body.out"

invalid_json='not-json'
invalid_json_len=$(printf '%s' "$invalid_json" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$invalid_json_len" \
  ./dist/jcomment-cgi >"$tmp/invalid-json.out" <<JSON
$invalid_json
JSON
grep -q 'Invalid JSON' "$tmp/invalid-json.out"

orphan_body='{"author":"Ada","body":"Orphan","parentId":"missing"}'
orphan_len=$(printf '%s' "$orphan_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$orphan_len" \
  ./dist/jcomment-cgi >"$tmp/orphan.out" <<JSON
$orphan_body
JSON
grep -q 'Parent comment was not found' "$tmp/orphan.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_LOGIN_ENABLED=0 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-config.out"
grep -q 'Invalid jcomment configuration' "$tmp/bad-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN=1 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cookie-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN is not supported' "$tmp/bad-cookie-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  JCOMMENT_SESSION_COOKIE_SAMESITE=None \
  JCOMMENT_SESSION_COOKIE_SECURE=0 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-samesite-cookie-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_SAMESITE=None requires JCOMMENT_SESSION_COOKIE_SECURE=1' "$tmp/bad-samesite-cookie-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_ENABLED=maybe \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cookie-bool-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_ENABLED must be 1, true, on, yes, 0, false, off, or no' "$tmp/bad-cookie-bool-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_NAME='bad name' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cookie-name-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name' "$tmp/bad-cookie-name-config.out"

long_cookie_name='jcomment_'
i=0
while [ "$i" -lt 300 ]; do
  long_cookie_name="${long_cookie_name}x"
  i=$((i + 1))
done
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_NAME="$long_cookie_name" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/long-cookie-name-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name' "$tmp/long-cookie-name-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_SAMESITE=Sometimes \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cookie-samesite-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_SAMESITE must be Strict, Lax, or None' "$tmp/bad-cookie-samesite-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  BROKEN_CONFIG=maybe \
  JCOMMENT_LOGIN_ENABLED=0 \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-broken-config-bool.out"
grep -q 'BROKEN_CONFIG must be 1, true, on, yes, 0, false, off, or no' "$tmp/bad-broken-config-bool.out"
grep -q 'JCOMMENT_REQUIRE_LOGIN_TO_POST requires JCOMMENT_LOGIN_ENABLED' "$tmp/bad-broken-config-bool.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_RATE_LIMIT_WINDOW_MS=soon \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-numeric-config.out"
grep -q 'JCOMMENT_RATE_LIMIT_WINDOW_MS must be a positive integer' "$tmp/bad-numeric-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_MAX_COMMENTS_PER_SITE=lots \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-quota-config.out"
grep -q 'JCOMMENT_MAX_COMMENTS_PER_SITE must be a positive integer' "$tmp/bad-quota-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=mandatory \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-email-mode-config.out"
grep -q 'JCOMMENT_EMAIL_MODE must be none, optional, or required' "$tmp/bad-email-mode-config.out"

bad_reserved_vtab=$(printf 'admin\v')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_RESERVED_USERNAMES="$bad_reserved_vtab" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-reserved-vtab-config.out"
grep -q 'JCOMMENT_RESERVED_USERNAMES must contain non-empty account names' "$tmp/bad-reserved-vtab-config.out"

bad_reserved_variation=$(printf 'admin\357\270\217')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_RESERVED_USERNAMES="$bad_reserved_variation" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-reserved-variation-config.out"
grep -q 'JCOMMENT_RESERVED_USERNAMES must contain non-empty account names' "$tmp/bad-reserved-variation-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='ftp://comments.example.test' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-origin-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN must be \* or an absolute http(s) origin' "$tmp/bad-cors-origin-config.out"
! grep -q 'Access-Control-Allow-Origin: ftp://comments.example.test' "$tmp/bad-cors-origin-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='https://comments.example.test/path' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-path-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN must be \* or an absolute http(s) origin' "$tmp/bad-cors-path-config.out"
! grep -q 'Access-Control-Allow-Origin: https://comments.example.test/path' "$tmp/bad-cors-path-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='https://COMMENTS.example.test' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-uppercase-host-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN must be \* or an absolute http(s) origin' "$tmp/bad-cors-uppercase-host-config.out"
! grep -q 'Access-Control-Allow-Origin: https://COMMENTS.example.test' "$tmp/bad-cors-uppercase-host-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='https://comments.example.test:443' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-default-port-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN must be \* or an absolute http(s) origin' "$tmp/bad-cors-default-port-config.out"
! grep -q 'Access-Control-Allow-Origin: https://comments.example.test:443' "$tmp/bad-cors-default-port-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='*' \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-wildcard-cookie-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN=\* requires JCOMMENT_SESSION_COOKIE_ENABLED=0' "$tmp/bad-cors-wildcard-cookie-config.out"
! grep -q 'Access-Control-Allow-Origin: \*' "$tmp/bad-cors-wildcard-cookie-config.out"
! grep -Fq 'Access-Control-Allow-Origin: *' "$tmp/bad-cors-wildcard-cookie-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='*' \
  JCOMMENT_SESSION_COOKIE_ENABLED=maybe \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-cookie-bool-config.out"
grep -q 'JCOMMENT_SESSION_COOKIE_ENABLED must be 1, true, on, yes, 0, false, off, or no' "$tmp/bad-cors-cookie-bool-config.out"
! grep -Fq 'Access-Control-Allow-Origin: *' "$tmp/bad-cors-cookie-bool-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='https://comments.example.test ' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-space-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN must be \* or an absolute http(s) origin' "$tmp/bad-cors-space-config.out"
! grep -q 'Access-Control-Allow-Origin: https://comments.example.test' "$tmp/bad-cors-space-config.out"

bad_cors_vtab=$(printf 'https://comments.example.test\v')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN="$bad_cors_vtab" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-cors-vtab-config.out"
grep -q 'JCOMMENT_CORS_ORIGIN must be \* or an absolute http(s) origin' "$tmp/bad-cors-vtab-config.out"
! grep -q 'Access-Control-Allow-Origin: https://comments.example.test' "$tmp/bad-cors-vtab-config.out"

bad_public_del=$(printf 'https://comments.example.test\177')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PUBLIC_ORIGIN="$bad_public_del" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-public-del-config.out"
grep -q 'JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin' "$tmp/bad-public-del-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PUBLIC_ORIGIN='https://comments.example.test/path' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-public-origin-config.out"
grep -q 'JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin' "$tmp/bad-public-origin-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PUBLIC_ORIGIN='https://COMMENTS.example.test' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-public-uppercase-host-config.out"
grep -q 'JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin' "$tmp/bad-public-uppercase-host-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PUBLIC_ORIGIN='https://comments.example.test:443' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-public-default-port-config.out"
grep -q 'JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin' "$tmp/bad-public-default-port-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SITE=fixed-cgi \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/fixed-site-cookie-public-origin-config.out"
grep -q 'JCOMMENT_PUBLIC_ORIGIN is required when JCOMMENT_SITE is set and cookie sessions are enabled' "$tmp/fixed-site-cookie-public-origin-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SITE=fixed-cgi \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  JCOMMENT_PUBLIC_ORIGIN='http://fixed-cgi' \
  SERVER_NAME=alternate-cgi \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/fixed-site-cookie-alternate-origin.out"
grep -q 'Bad Request' "$tmp/fixed-site-cookie-alternate-origin.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_TRUST_PROXY_HEADERS=1 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/missing-proxy-header-config.out"
grep -q 'JCOMMENT_TRUST_PROXY_HEADER must be cf-connecting-ip, x-real-ip, or x-forwarded-for' "$tmp/missing-proxy-header-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_TRUST_PROXY_HEADERS=1 \
  JCOMMENT_TRUST_PROXY_HEADER=forwarded \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-proxy-header-config.out"
grep -q 'JCOMMENT_TRUST_PROXY_HEADER must be cf-connecting-ip, x-real-ip, or x-forwarded-for' "$tmp/bad-proxy-header-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SQLITE_BIN=sqlite3 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-sqlite-bin-config.out"
grep -q 'JCOMMENT_SQLITE_BIN must be an absolute executable path' "$tmp/bad-sqlite-bin-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SQLITE_BIN="$tmp/missing-sqlite3" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/missing-sqlite-bin-config.out"
grep -q 'JCOMMENT_SQLITE_BIN must be an absolute executable path' "$tmp/missing-sqlite-bin-config.out"

not_executable_sqlite="$tmp/not-executable-sqlite3"
printf '#!/bin/sh\nexit 0\n' >"$not_executable_sqlite"
chmod 600 "$not_executable_sqlite"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SQLITE_BIN="$not_executable_sqlite" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/not-executable-sqlite-bin-config.out"
grep -q 'JCOMMENT_SQLITE_BIN must be an absolute executable path' "$tmp/not-executable-sqlite-bin-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_RATE_LIMIT_WINDOW_MS='+60000' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-positive-int-plus-config.out"
grep -q 'JCOMMENT_RATE_LIMIT_WINDOW_MS must be a positive integer' "$tmp/bad-positive-int-plus-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_MAX_COMMENTS_PER_THREAD='1_000' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-positive-int-underscore-config.out"
grep -q 'JCOMMENT_MAX_COMMENTS_PER_THREAD must be a positive integer' "$tmp/bad-positive-int-underscore-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_COMMAND=send-reset-token \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/bad-reset-command-config.out"
grep -q 'JCOMMENT_PASSWORD_RESET_COMMAND must be an absolute executable path' "$tmp/bad-reset-command-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_COMMAND="$tmp/missing-reset-command" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/missing-reset-command-config.out"
grep -q 'JCOMMENT_PASSWORD_RESET_COMMAND must be an absolute executable path' "$tmp/missing-reset-command-config.out"

not_executable_reset="$tmp/not-executable-reset-command"
printf '#!/bin/sh\nexit 0\n' >"$not_executable_reset"
chmod 600 "$not_executable_reset"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_COMMAND="$not_executable_reset" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/not-executable-reset-command-config.out"
grep -q 'JCOMMENT_PASSWORD_RESET_COMMAND must be an absolute executable path' "$tmp/not-executable-reset-command-config.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_LOGIN_ENABLED=0 \
  BROKEN_CONFIG=1 \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/broken-config.out" 2>"$tmp/broken-config.err"
grep -q '"comments":' "$tmp/broken-config.out"
grep -q 'BROKEN_CONFIG=1 is unsupported' "$tmp/broken-config.err"

body="{\"id\":\"$id\",\"action\":\"upvote\"}"
len=$(printf '%s' "$body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=PATCH \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  JCOMMENT_LOCALHOST_VOTING_ENABLED=1 \
  REMOTE_ADDR='127.0.0.1' \
  CONTENT_LENGTH="$len" \
  ./dist/jcomment-cgi >"$tmp/vote.out" <<JSON
$body
JSON

grep -q '"score":1' "$tmp/vote.out"

downvote_body="{\"id\":\"$id\",\"action\":\"downvote\"}"
downvote_len=$(printf '%s' "$downvote_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=PATCH \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$downvote_len" \
  ./dist/jcomment-cgi >"$tmp/downvote.out" <<JSON
$downvote_body
JSON
grep -q 'Unsupported vote action' "$tmp/downvote.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/get.out"

grep -q 'Hello from CGI' "$tmp/get.out"

signup_body='{"username":"Ada","email":"ada@example.test","password":"correct horse battery staple"}'
signup_len=$(printf '%s' "$signup_body" | wc -c)
reserved_body='{"username":"admin","email":"admin@example.test","password":"correct horse battery staple"}'
reserved_len=$(printf '%s' "$reserved_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$reserved_len" \
  ./dist/jcomment-cgi >"$tmp/signup-reserved.out" <<JSON
$reserved_body
JSON
grep -q 'Username is reserved for this site' "$tmp/signup-reserved.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$signup_len" \
  ./dist/jcomment-cgi >"$tmp/signup.out" <<JSON
$signup_body
JSON
grep -q '"token":' "$tmp/signup.out"
signup_token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$tmp/signup.out" | head -n 1)
test ${#signup_token} -ge 64

cookie_signup_body='{"username":"CookieUser","password":"correct horse battery staple"}'
cookie_signup_len=$(printf '%s' "$cookie_signup_body" | wc -c)
broken_cookie_body='{"username":"BrokenCookieUser","password":"correct horse battery staple"}'
broken_cookie_len=$(printf '%s' "$broken_cookie_body" | wc -c)
bad_cookie_name=$(printf 'bad\r\nX-Injected-Cookie: yes')
bad_cookie_same_site=$(printf 'Strict\r\nX-Injected-SameSite: yes')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  BROKEN_CONFIG=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN=1 \
  JCOMMENT_SESSION_COOKIE_SECURE=0 \
  JCOMMENT_SESSION_COOKIE_NAME="$bad_cookie_name" \
  JCOMMENT_SESSION_COOKIE_SAMESITE="$bad_cookie_same_site" \
  JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE=1 \
  SERVER_NAME=broken-cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=broken-cookie-cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$broken_cookie_len" \
  ./dist/jcomment-cgi >"$tmp/broken-cookie-signup.out" 2>"$tmp/broken-cookie-signup.err" <<JSON
$broken_cookie_body
JSON
grep -q 'Set-Cookie: jcomment_session=' "$tmp/broken-cookie-signup.out"
grep -q 'SameSite=Lax' "$tmp/broken-cookie-signup.out"
! grep -q '"token":' "$tmp/broken-cookie-signup.out"
! grep -q 'X-Injected-Cookie' "$tmp/broken-cookie-signup.out"
! grep -q 'X-Injected-SameSite' "$tmp/broken-cookie-signup.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  JCOMMENT_SESSION_COOKIE_SECURE=0 \
  JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cookie-cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$cookie_signup_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-signup.out" <<JSON
$cookie_signup_body
JSON
grep -q 'Set-Cookie: jcomment_session=' "$tmp/cookie-signup.out"
grep -q 'HttpOnly' "$tmp/cookie-signup.out"
! grep -q '"token":' "$tmp/cookie-signup.out"
cookie_pair=$(sed -n 's/^Set-Cookie: \([^;]*\).*/\1/p' "$tmp/cookie-signup.out" | head -n 1)
test -n "$cookie_pair"
cookie_post='{"author":"Mallory","body":"Cookie post"}'
cookie_post_len=$(printf '%s' "$cookie_post" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_SEC_FETCH_SITE='same-origin' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post.out" <<JSON
$cookie_post
JSON
grep -q '"author":"CookieUser"' "$tmp/cookie-post.out"

bad_server_name=$(printf 'cookie\tcgi')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME="$bad_server_name" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_SEC_FETCH_SITE='same-origin' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-bad-server-name.out" <<JSON
$cookie_post
JSON
grep -q 'JCOMMENT_SITE and SERVER_NAME must not contain control characters' "$tmp/cookie-post-bad-server-name.out"

padded_server_name=' cookie-cgi'
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME="$padded_server_name" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_SEC_FETCH_SITE='same-origin' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-padded-server-name.out" <<JSON
$cookie_post
JSON
grep -q 'JCOMMENT_SITE and SERVER_NAME must not contain control characters' "$tmp/cookie-post-padded-server-name.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_SCHEME='not-http' \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_ORIGIN='http://cookie-cgi' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-bad-scheme-env.out" <<JSON
$cookie_post
JSON
grep -q '"author":"CookieUser"' "$tmp/cookie-post-bad-scheme-env.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  CONTENT_TYPE='application/json' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-no-metadata.out" <<JSON
$cookie_post
JSON
grep -q 'Cookie-authenticated state-changing requests require same-origin browser metadata' "$tmp/cookie-post-no-metadata.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_SEC_FETCH_SITE='same-site' \
  CONTENT_TYPE='application/json' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-same-site-no-origin.out" <<JSON
$cookie_post
JSON
grep -q 'Cookie-authenticated state-changing requests require same-origin browser metadata' "$tmp/cookie-post-same-site-no-origin.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_ORIGIN='https://evil.example' \
  HTTP_SEC_FETCH_SITE='cross-site' \
  CONTENT_TYPE='application/json' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-cross-site.out" <<JSON
$cookie_post
JSON
grep -q 'Cross-site state-changing requests are not allowed' "$tmp/cookie-post-cross-site.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_HOST='evil.example' \
  HTTP_ORIGIN='http://evil.example' \
  CONTENT_TYPE='application/json' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-host-spoof.out" <<JSON
$cookie_post
JSON
grep -q 'Request origin is not allowed' "$tmp/cookie-post-host-spoof.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  JCOMMENT_SESSION_COOKIE_ENABLED=1 \
  SERVER_NAME=cookie-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cookie-cgi&site=cookie-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_COOKIE="$cookie_pair" \
  HTTP_ORIGIN='http://cookie-cgi/path' \
  CONTENT_TYPE='application/json' \
  CONTENT_LENGTH="$cookie_post_len" \
  ./dist/jcomment-cgi >"$tmp/cookie-post-path-origin.out" <<JSON
$cookie_post
JSON
grep -q 'Request origin is not allowed' "$tmp/cookie-post-path-origin.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_TYPE='text/plain' \
  CONTENT_LENGTH="$post_len" \
  ./dist/jcomment-cgi >"$tmp/plain-post.out" <<JSON
$post_body
JSON
grep -q 'Content-Type must be application/json' "$tmp/plain-post.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_CORS_ORIGIN='https://comments.example.test' \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/cors.out"
grep -q 'Access-Control-Allow-Origin: https://comments.example.test' "$tmp/cors.out"

signup_case_body='{"username":"ADA","email":"ada2@example.test","password":"correct horse battery staple"}'
signup_case_len=$(printf '%s' "$signup_case_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$signup_case_len" \
  ./dist/jcomment-cgi >"$tmp/signup-case.out" <<JSON
$signup_case_body
JSON
grep -q '"ok":true' "$tmp/signup-case.out"
grep -q 'Status: 202 Accepted' "$tmp/signup-case.out"
! grep -q 'Account already exists for this site' "$tmp/signup-case.out"

bad_username_body='{"username":"Bad\tName","email":"bad@example.test","password":"correct horse battery staple"}'
bad_username_len=$(printf '%s' "$bad_username_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$bad_username_len" \
  ./dist/jcomment-cgi >"$tmp/signup-bad-username.out" <<JSON
$bad_username_body
JSON
grep -q 'Username contains invalid characters' "$tmp/signup-bad-username.out"

bad_del_username_body=$(printf '{"username":"Bad\177Name","email":"bad-del@example.test","password":"correct horse battery staple"}')
bad_del_username_len=$(printf '%s' "$bad_del_username_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$bad_del_username_len" \
  ./dist/jcomment-cgi >"$tmp/signup-bad-del-username.out" <<JSON
$bad_del_username_body
JSON
grep -q 'Username contains invalid characters' "$tmp/signup-bad-del-username.out"

bad_format_username_body=$(printf '{"username":"ad\342\200\215min","email":"bad-format@example.test","password":"correct horse battery staple"}')
bad_format_username_len=$(printf '%s' "$bad_format_username_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$bad_format_username_len" \
  ./dist/jcomment-cgi >"$tmp/signup-bad-format-username.out" <<JSON
$bad_format_username_body
JSON
grep -q 'Username contains invalid characters' "$tmp/signup-bad-format-username.out"

spaced_reserved_body='{"username":" admin ","email":"spaced-admin@example.test","password":"correct horse battery staple"}'
spaced_reserved_len=$(printf '%s' "$spaced_reserved_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$spaced_reserved_len" \
  ./dist/jcomment-cgi >"$tmp/signup-spaced-reserved.out" <<JSON
$spaced_reserved_body
JSON
grep -q 'Username is reserved for this site' "$tmp/signup-spaced-reserved.out"

boundary_prefix=$(printf '%079d' 0 | tr '0' 'a')
boundary_username="${boundary_prefix}é"
boundary_body="{\"username\":\"$boundary_username\",\"email\":\"boundary@example.test\",\"password\":\"correct horse battery staple\"}"
boundary_len=$(printf '%s' "$boundary_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$boundary_len" \
  ./dist/jcomment-cgi >"$tmp/signup-utf8-boundary.out" <<JSON
$boundary_body
JSON
grep -q '"ok":true' "$tmp/signup-utf8-boundary.out"
test "$(sqlite3 "$tmp/jcomment.sqlite3" "select length(hex(username)) from accounts where email = 'boundary@example.test';")" = "158"

login_body='{"username":"Ada","password":"correct horse battery staple"}'
login_len=$(printf '%s' "$login_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/login' \
  CONTENT_LENGTH="$login_len" \
  ./dist/jcomment-cgi >"$tmp/login.out" <<JSON
$login_body
JSON
grep -q '"token":' "$tmp/login.out"
bad_login_body='{"username":"Ada","password":"wrong password value"}'
bad_login_len=$(printf '%s' "$bad_login_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/login' \
  CONTENT_LENGTH="$bad_login_len" \
  ./dist/jcomment-cgi >"$tmp/login-bad-password.out" <<JSON
$bad_login_body
JSON
grep -q 'Invalid username or password' "$tmp/login-bad-password.out"
nested_login_body='{"username":"Ada","password":"correct horse battery staple"}'
nested_login_len=$(printf '%s' "$nested_login_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/anything/login' \
  CONTENT_TYPE=application/json \
  CONTENT_LENGTH="$nested_login_len" \
  ./dist/jcomment-cgi >"$tmp/nested-login-path.out" <<JSON
$nested_login_body
JSON
grep -q 'Status: 404 Not Found' "$tmp/nested-login-path.out"
grep -q 'Not found' "$tmp/nested-login-path.out"
post_locked='{"author":"Mallory","body":"Locked post"}'
post_locked_len=$(printf '%s' "$post_locked" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=locked&site=cgi' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_locked_len" \
  ./dist/jcomment-cgi >"$tmp/post-locked.out" <<JSON
$post_locked
JSON
grep -q 'Login is required to post comments' "$tmp/post-locked.out"
login_token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$tmp/login.out" | head -n 1)
test -n "$login_token"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_SITE=other-cgi-site \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=locked' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $login_token" \
  CONTENT_LENGTH="$post_locked_len" \
  ./dist/jcomment-cgi >"$tmp/post-other-site-token.out" <<JSON
$post_locked
JSON
grep -q 'Login is required to post comments' "$tmp/post-other-site-token.out"
test "$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from sessions where token = '$(printf '%s' "$login_token" | sha256sum | awk '{print "sha256:" $1}')' and site = 'cgi';")" = "1"
oversized_token=$(printf '%0300d' 0 | tr '0' 'x')
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=locked&site=cgi' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $oversized_token" \
  CONTENT_LENGTH="$post_locked_len" \
  ./dist/jcomment-cgi >"$tmp/post-locked-oversized-token.out" <<JSON
$post_locked
JSON
grep -q 'Login is required to post comments' "$tmp/post-locked-oversized-token.out"

body="{\"id\":\"$id\",\"action\":\"upvote\"}"
len=$(printf '%s' "$body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=PATCH \
  QUERY_STRING='thread=cgi&site=cgi' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $login_token" \
  CONTENT_LENGTH="$len" \
  ./dist/jcomment-cgi >"$tmp/login-vote.out" <<JSON
$body
JSON
grep -q '"score":2' "$tmp/login-vote.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/login' \
  CONTENT_LENGTH="$login_len" \
  ./dist/jcomment-cgi >"$tmp/login-again.out" <<JSON
$login_body
JSON
login_token_again=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$tmp/login-again.out" | head -n 1)
test -n "$login_token_again"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=PATCH \
  QUERY_STRING='thread=cgi&site=cgi' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $login_token_again" \
  CONTENT_LENGTH="$len" \
  ./dist/jcomment-cgi >"$tmp/login-vote-again.out" <<JSON
$body
JSON
grep -q 'Vote limit reached for this identity' "$tmp/login-vote-again.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=locked&site=cgi' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $login_token" \
  CONTENT_LENGTH="$post_locked_len" \
  ./dist/jcomment-cgi >"$tmp/post-locked-authed.out" <<JSON
$post_locked
JSON
grep -q 'Locked post' "$tmp/post-locked-authed.out"
grep -q '"author":"Ada"' "$tmp/post-locked-authed.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_SESSION_TTL_MS=1 \
  JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE=1 \
  SERVER_NAME=expired-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=expired-cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$signup_len" \
  ./dist/jcomment-cgi >"$tmp/expired-signup.out" <<JSON
$signup_body
JSON
expired_token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$tmp/expired-signup.out" | head -n 1)
test -n "$expired_token"
sleep 0.01
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  SERVER_NAME=expired-cgi \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=expired&site=expired-cgi' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $expired_token" \
  CONTENT_LENGTH="$post_locked_len" \
  ./dist/jcomment-cgi >"$tmp/expired-post.out" <<JSON
$post_locked
JSON
grep -q 'Login is required to post comments' "$tmp/expired-post.out"

reset_body='{"username":"Ada","email":"ada@example.test"}'
reset_len=$(printf '%s' "$reset_body" | wc -c)
failed_reset_count_before=$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from resets where site = 'cgi' and username = 'Ada';")
cat >"$tmp/reset-fail-token-stderr.sh" <<'SH'
#!/bin/sh
IFS= read -r token
printf 'delivery failed for token %s\n' "$token" >&2
exit 1
SH
chmod 700 "$tmp/reset-fail-token-stderr.sh"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_PASSWORD_RESET_COMMAND="$tmp/reset-fail-token-stderr.sh" \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/request' \
  CONTENT_LENGTH="$reset_len" \
  ./dist/jcomment-cgi >"$tmp/reset-failed-delivery.out" 2>"$tmp/reset-failed-delivery.err" <<JSON
$reset_body
JSON
grep -q '"ok":true' "$tmp/reset-failed-delivery.out"
! grep -q 'delivery failed for token' "$tmp/reset-failed-delivery.err"
failed_reset_count_after=$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from resets where site = 'cgi' and username = 'Ada';")
test "$failed_reset_count_before" = "$failed_reset_count_after"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_PASSWORD_RESET_TTL_MS=1 \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/request' \
  CONTENT_LENGTH="$reset_len" \
  ./dist/jcomment-cgi >"$tmp/reset.out" <<JSON
$reset_body
JSON
grep -q '"ok":true' "$tmp/reset.out"
! grep -q '"token":' "$tmp/reset.out"
reset_token='expired reset token'
reset_digest=$(printf '%s' "$reset_token" | sha256sum | cut -d ' ' -f 1)
sqlite3 "$tmp/jcomment.sqlite3" "update resets set token = 'sha256:$reset_digest' where site = 'cgi' and username = 'Ada';"
sleep 0.01

confirm_body="{\"token\":\"$reset_token\",\"password\":\"new password value\"}"
confirm_len=$(printf '%s' "$confirm_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/confirm' \
  CONTENT_LENGTH="$confirm_len" \
  ./dist/jcomment-cgi >"$tmp/reset-confirm.out" <<JSON
$confirm_body
JSON
grep -q 'Invalid or expired reset token' "$tmp/reset-confirm.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/request' \
  CONTENT_LENGTH="$reset_len" \
  ./dist/jcomment-cgi >"$tmp/reset-active.out" <<JSON
$reset_body
JSON
grep -q '"ok":true' "$tmp/reset-active.out"
! grep -q '"token":' "$tmp/reset-active.out"
reset_count_before=$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from resets where site = 'cgi' and username = 'Ada' and expires_at >= (strftime('%s','now') * 1000);")
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/request' \
  CONTENT_LENGTH="$reset_len" \
  ./dist/jcomment-cgi >"$tmp/reset-active-repeat.out" <<JSON
$reset_body
JSON
reset_count_after=$(sqlite3 "$tmp/jcomment.sqlite3" "select count(*) from resets where site = 'cgi' and username = 'Ada' and expires_at >= (strftime('%s','now') * 1000);")
test "$reset_count_after" -le "$reset_count_before"
active_reset_token='active reset token'
active_reset_digest=$(printf '%s' "$active_reset_token" | sha256sum | cut -d ' ' -f 1)
sqlite3 "$tmp/jcomment.sqlite3" "update resets set token = 'sha256:$active_reset_digest' where site = 'cgi' and username = 'Ada' and expires_at = (select max(expires_at) from resets where site = 'cgi' and username = 'Ada');"
confirm_body="{\"token\":\"$active_reset_token\",\"password\":\"new password value\"}"
confirm_len=$(printf '%s' "$confirm_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/confirm' \
  CONTENT_LENGTH="$confirm_len" \
  ./dist/jcomment-cgi >"$tmp/reset-confirm-active.out" <<JSON
$confirm_body
JSON
grep -q '"ok":true' "$tmp/reset-confirm-active.out"
second_confirm_body="{\"token\":\"$active_reset_token\",\"password\":\"second reset should fail\"}"
second_confirm_len=$(printf '%s' "$second_confirm_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_RATE_LIMIT_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/confirm' \
  CONTENT_LENGTH="$second_confirm_len" \
  ./dist/jcomment-cgi >"$tmp/reset-confirm-active-repeat.out" <<JSON
$second_confirm_body
JSON
grep -q 'Invalid or expired reset token' "$tmp/reset-confirm-active-repeat.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_REQUIRE_LOGIN_TO_POST=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=locked&site=cgi' \
  PATH_INFO='/api/comments' \
  HTTP_AUTHORIZATION="Bearer $login_token" \
  CONTENT_LENGTH="$post_locked_len" \
  ./dist/jcomment-cgi >"$tmp/post-reset-old-session.out" <<JSON
$post_locked
JSON
grep -q 'Login is required to post comments' "$tmp/post-reset-old-session.out"

login_body='{"username":"Ada","password":"new password value"}'
login_len=$(printf '%s' "$login_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_LOGIN_ENABLED=0 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/login' \
  CONTENT_LENGTH="$login_len" \
  ./dist/jcomment-cgi >"$tmp/login-disabled.out" <<JSON
$login_body
JSON
grep -q 'Login is disabled' "$tmp/login-disabled.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_LOGIN_ENABLED=no \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/login' \
  CONTENT_LENGTH="$login_len" \
  ./dist/jcomment-cgi >"$tmp/login-disabled-no.out" <<JSON
$login_body
JSON
grep -q 'Login is disabled' "$tmp/login-disabled-no.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_VOTING_ENABLED=0 \
  REQUEST_METHOD=PATCH \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  REMOTE_ADDR='127.0.0.1' \
  CONTENT_LENGTH="$len" \
  ./dist/jcomment-cgi >"$tmp/voting-disabled.out" <<JSON
$body
JSON
grep -q 'Voting is disabled' "$tmp/voting-disabled.out"

post_a='{"author":"Ada","body":"Comment for A"}'
post_b='{"author":"Ada","body":"Comment for B"}'
post_a_len=$(printf '%s' "$post_a" | wc -c)
post_b_len=$(printf '%s' "$post_b" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=article-a' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_a_len" \
  ./dist/jcomment-cgi >"$tmp/article-a-post.out" <<JSON
$post_a
JSON
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=article-b' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$post_b_len" \
  ./dist/jcomment-cgi >"$tmp/article-b-post.out" <<JSON
$post_b
JSON
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=article-a' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/article-a-get.out"
grep -q 'Comment for A' "$tmp/article-a-get.out"
! grep -q 'Comment for B' "$tmp/article-a-get.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=article-b' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/article-b-get.out"
grep -q 'Comment for B' "$tmp/article-b-get.out"
! grep -q 'Comment for A' "$tmp/article-b-get.out"

dot_body='{"author":"Ada","body":"Dot thread"}'
slash_body='{"author":"Ada","body":"Slash thread"}'
underscore_body='{"author":"Ada","body":"Underscore thread"}'
dot_len=$(printf '%s' "$dot_body" | wc -c)
slash_len=$(printf '%s' "$slash_body" | wc -c)
underscore_len=$(printf '%s' "$underscore_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=collision.a' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$dot_len" \
  ./dist/jcomment-cgi >"$tmp/thread-dot-post.out" <<JSON
$dot_body
JSON
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=collision%2Fa' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$slash_len" \
  ./dist/jcomment-cgi >"$tmp/thread-slash-post.out" <<JSON
$slash_body
JSON
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=POST \
  QUERY_STRING='thread=collision_a' \
  PATH_INFO='/api/comments' \
  CONTENT_LENGTH="$underscore_len" \
  ./dist/jcomment-cgi >"$tmp/thread-underscore-post.out" <<JSON
$underscore_body
JSON
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=collision.a' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/thread-dot-get.out"
grep -q 'Dot thread' "$tmp/thread-dot-get.out"
! grep -q 'Slash thread' "$tmp/thread-dot-get.out"
! grep -q 'Underscore thread' "$tmp/thread-dot-get.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=collision%2Fa' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/thread-slash-get.out"
grep -q 'Slash thread' "$tmp/thread-slash-get.out"
! grep -q 'Dot thread' "$tmp/thread-slash-get.out"
! grep -q 'Underscore thread' "$tmp/thread-slash-get.out"
env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=collision_a' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/thread-underscore-get.out"
grep -q 'Underscore thread' "$tmp/thread-underscore-get.out"
! grep -q 'Dot thread' "$tmp/thread-underscore-get.out"
! grep -q 'Slash thread' "$tmp/thread-underscore-get.out"

printf 'cgi server ok\n'
