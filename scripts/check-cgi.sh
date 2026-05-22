#!/usr/bin/env sh
set -eu

tmp="${TMPDIR:-/tmp}/jcomment-cgi-check-$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT

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
test -s "$tmp/jcomment.sqlite3"
sqlite3 "$tmp/jcomment.sqlite3" '.tables' | grep -q 'comments'
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$tmp/post.out" | head -n 1)
test -n "$id"

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
  REMOTE_ADDR='127.0.0.1' \
  CONTENT_LENGTH="$len" \
  ./dist/jcomment-cgi >"$tmp/vote.out" <<JSON
$body
JSON

grep -q '"score":1' "$tmp/vote.out"

env \
  JCOMMENT_DATA_DIR="$tmp" \
  REQUEST_METHOD=GET \
  QUERY_STRING='thread=cgi' \
  PATH_INFO='/api/comments' \
  ./dist/jcomment-cgi >"$tmp/get.out"

grep -q 'Hello from CGI' "$tmp/get.out"

signup_body='{"username":"Ada","email":"ada@example.test","password":"correct horse battery staple"}'
signup_len=$(printf '%s' "$signup_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/signup' \
  CONTENT_LENGTH="$signup_len" \
  ./dist/jcomment-cgi >"$tmp/signup.out" <<JSON
$signup_body
JSON
grep -q '"token":' "$tmp/signup.out"

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
post_locked='{"author":"Ada","body":"Locked post"}'
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

reset_body='{"username":"Ada","email":"ada@example.test"}'
reset_len=$(printf '%s' "$reset_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  JCOMMENT_PASSWORD_RESET_EXPOSE_TOKEN=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/request' \
  CONTENT_LENGTH="$reset_len" \
  ./dist/jcomment-cgi >"$tmp/reset.out" <<JSON
$reset_body
JSON
grep -q '"token":' "$tmp/reset.out"
reset_token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$tmp/reset.out" | head -n 1)
test -n "$reset_token"

confirm_body="{\"token\":\"$reset_token\",\"password\":\"new password value\"}"
confirm_len=$(printf '%s' "$confirm_body" | wc -c)
env \
  JCOMMENT_DATA_DIR="$tmp" \
  JCOMMENT_EMAIL_MODE=required \
  JCOMMENT_PASSWORD_RESET_ENABLED=1 \
  REQUEST_METHOD=POST \
  QUERY_STRING='site=cgi' \
  PATH_INFO='/api/comments/reset/confirm' \
  CONTENT_LENGTH="$confirm_len" \
  ./dist/jcomment-cgi >"$tmp/reset-confirm.out" <<JSON
$confirm_body
JSON
grep -q '"ok":true' "$tmp/reset-confirm.out"

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
