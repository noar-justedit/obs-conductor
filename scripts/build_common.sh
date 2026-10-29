#!/bin/bash
# OBS Conductor - shared by build_mac.command, build_windows.command (both on
# a Mac) and build_linux.sh (on Linux). Not meant to be run on its own.
#
# What every build does the same way:
#  - downloads the official Node.js runtime from nodejs.org (the version
#    below) and checks it against nodejs.org's SHA-256 list: nothing to
#    install on the build machine, not even Node.js;
#  - runs the tests with that Node.js;
#  - puts together the app folder: sources, the "yaml" library, the settings
#    templates, the licences.
# Downloads are kept in build/cache (reused by the next build).

set -euo pipefail

# Node.js shipped inside the app. 22 = LTS until April 2027. To move on: change
# the number, build, test on each system.
NODE_VERSION="22.22.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/build/cache"
DIST="$ROOT/dist"
APP_VERSION="$(sed -n 's/^ *"version": *"\([0-9.]*\)".*/\1/p' "$ROOT/package.json" | head -1)"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# fetch_node <file name on nodejs.org>  ->  prints the path of the checked file
fetch_node() {
  local name="$1" base="https://nodejs.org/dist/v$NODE_VERSION"
  mkdir -p "$CACHE"
  local sums="$CACHE/SHASUMS256-v$NODE_VERSION.txt"
  if [ ! -s "$sums" ]; then
    # kept only when it is the real list (a cut download or a hotel page is not)
    curl -fsSL "$base/SHASUMS256.txt" -o "$sums.part" || { rm -f "$sums.part"; fail "could not reach nodejs.org"; }
    grep -q "node-v$NODE_VERSION" "$sums.part" || { rm -f "$sums.part"; fail "nodejs.org's list could not be read (a web page instead?): try again"; }
    mv "$sums.part" "$sums"
  fi
  local want; want="$(awk -v f="$name" '$2 == f { print $1 }' "$sums")"
  [ -n "$want" ] || { rm -f "$sums"; fail "$name is not in nodejs.org's list for v$NODE_VERSION (list deleted: run the build again)"; }
  local file="$CACHE/$name"
  if [ ! -s "$file" ] || [ "$(sha256 "$file")" != "$want" ]; then
    echo "Downloading $name..." >&2
    curl -fL --progress-bar "$base/$name" -o "$file.part" || fail "download of $name failed"
    mv "$file.part" "$file"
  fi
  [ "$(sha256 "$file")" = "$want" ] || { rm -f "$file"; fail "$name does not match nodejs.org's fingerprint - deleted, run the build again"; }
  echo "$file"
}

# host_node: a Node.js for this machine, to run npm and the tests
# (sets NODE_BIN and NPM_CLI)
host_node() {
  local os arch name dir
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "unsupported build machine: $(uname -s)" ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) fail "unsupported processor: $(uname -m)" ;; esac
  name="node-v$NODE_VERSION-$os-$arch"
  dir="$CACHE/$name"
  if [ ! -x "$dir/bin/node" ]; then
    local tgz; tgz="$(fetch_node "$name.tar.gz")"
    tar -xzf "$tgz" -C "$CACHE"
  fi
  NODE_BIN="$dir/bin/node"
  NPM_CLI="$dir/lib/node_modules/npm/bin/npm-cli.js"
}

npm_run() { "$NODE_BIN" "$NPM_CLI" "$@"; }

# run_tests: dependencies of the project + the whole test suite
run_tests() {
  say "Tests"
  mkdir -p "$ROOT/build"
  local logf="$ROOT/build/tests.log"
  if ( cd "$ROOT" && export PATH="$(dirname "$NODE_BIN"):$PATH" && npm_run ci --no-audit --no-fund --loglevel=error && npm_run test --silent ) >"$logf" 2>&1; then
    grep -E '^# (pass|fail)' "$logf" || true
  else
    grep -E -B2 -A12 '^not ok' "$logf" | head -60 || tail -30 "$logf"
    fail "some tests failed - nothing was built (all of it: build/tests.log)"
  fi
}

# check_template: config/ becomes the first settings of every install. After a
# run from the sources (npm start) it may hold this Mac's role, addresses and
# passwords: then nothing is built (review 2.2.2)
check_template() {
  local f="$ROOT/config/settings.yaml" bad
  bad="$(grep -nE '^ *(role|master_host|host|user|master_obs_password|password): *"[^"]+"' "$f" \
         | grep -vE '^[0-9]+: *host: *"localhost"' | grep -vE 'password: *"YOUR_WEBSOCKET_PASSWORD"' || true)"
  grep -qE '^ *obs_hooked: *true' "$f" && bad="$bad obs_hooked: true"
  [ -z "$bad" ] || fail "config/settings.yaml is not the clean template (a run from the sources wrote into it): $bad
Put back the one from the ZIP, then build again."
}

# stage_app <dest>: the app folder (what runs, with the runtime next to it)
stage_app() {
  local dest="$1"
  check_template
  rm -rf "$dest"; mkdir -p "$dest"
  cp -R "$ROOT/src" "$dest/src"
  cp -R "$ROOT/config" "$dest/config_template"
  cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_LICENSES.md" "$dest/"
  ( cd "$dest" && PATH="$(dirname "$NODE_BIN"):$PATH" npm_run ci --omit=dev --no-audit --no-fund --loglevel=error ) || fail "npm install failed"
  rm -f "$dest/package-lock.json"
  find "$dest" -name '.DS_Store' -delete
}

# ask "question" -> 0 when the answer is y
ask() { local a; read -r -p "$1 [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ]; }

[ -n "$APP_VERSION" ] || fail "no version found in package.json"
command -v curl >/dev/null || fail "curl is missing (Linux: sudo apt install curl)"
