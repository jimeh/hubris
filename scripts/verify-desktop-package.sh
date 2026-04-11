#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: verify-desktop-package <platform> <arch>" >&2
  exit 1
fi

PLATFORM=$1
ARCH=$2
PACKAGE_ROOT="$(pwd)/dist/Hubris-$PLATFORM-$ARCH"

case "$PLATFORM" in
  darwin)
    RESOURCES_DIR="$PACKAGE_ROOT/Hubris.app/Contents/Resources"
    ARTIFACT_GLOB="dist/make/**/*.zip"
    ;;
  *)
    echo "unsupported platform: $PLATFORM" >&2
    exit 1
    ;;
esac

if [[ ! -d "$PACKAGE_ROOT" ]]; then
  echo "expected packaged app at $PACKAGE_ROOT" >&2
  exit 1
fi

if [[ ! -d "$RESOURCES_DIR/dist" ]]; then
  echo "expected bundled frontend dist at $RESOURCES_DIR/dist" >&2
  exit 1
fi

if [[ ! -f "$RESOURCES_DIR/hubris-desktop-runtime" ]]; then
  echo "expected packaged runtime at $RESOURCES_DIR/hubris-desktop-runtime" >&2
  exit 1
fi

shopt -s globstar nullglob
artifacts=($ARTIFACT_GLOB)
shopt -u globstar nullglob

if [[ ${#artifacts[@]} -ne 1 ]]; then
  echo "expected exactly one artifact matching $ARTIFACT_GLOB" >&2
  printf 'found: %s\n' "${artifacts[@]-<none>}" >&2
  exit 1
fi

case "$PLATFORM" in
  darwin)
    unzip -l "${artifacts[0]}" >/dev/null
    ;;
esac
