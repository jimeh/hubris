#!/usr/bin/env bash
set -euo pipefail

cargo run --quiet -p hubris-release-helper --locked -- package-server "$@"
