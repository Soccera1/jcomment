#!/usr/bin/env sh
set -eu

./scripts/build.sh
./scripts/build-cgi.sh
./scripts/build-demo.sh
