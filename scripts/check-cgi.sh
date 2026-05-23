#!/usr/bin/env sh
set -eu

tmp="${TMPDIR:-/tmp}/jcomment-cgi-check-$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT
export SERVER_NAME=cgi
export JCOMMENT_PASSWORD_RESET_COMMAND=/bin/true
export REMOTE_ADDR=127.0.0.1

env \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/missing-data-dir.out" 2>"$tmp/missing-data-dir.err"
grep -q 'JCOMMENT_DATA_DIR is required' "$tmp/missing-data-dir.out"

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
! grep -q 'Access-Control-Allow-Origin' "$tmp/post.out"
test "$(stat -c '%a' "$tmp")" = "700"
test -s "$tmp/jcomment.sqlite3"
sqlite3 "$tmp/jcomment.sqlite3" '.tables' | grep -q 'comments'
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$tmp/post.out" | head -n 1)
test -n "$id"

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
grep -q 'Cookie-authenticated state-changing requests require browser origin metadata' "$tmp/cookie-post-no-metadata.out"

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
test "$reset_count_before" = "$reset_count_after"
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

printf 'cgi server ok\n'
