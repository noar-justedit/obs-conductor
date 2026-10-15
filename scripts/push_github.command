#!/bin/bash
# ==========================================================================
# OBS Conductor - sends this folder to GitHub. Double-click it (Mac).
#
# GitHub becomes exactly this folder: files added, changed AND removed.
# Never the GitHub web upload (it removes nothing and loses the "executable"
# mark of the .command / .sh scripts).
#
# How it works:
#  - works in a temporary copy of the GitHub repository (this folder is
#    never touched);
#  - refuses to send when version.json and package.json disagree, or when
#    version.json is not strictly newer than the one on GitHub;
#  - version.json goes last: until the GitHub Release vX.Y.Z exists with its
#    files (.dmg, .exe, .deb, .AppImage), GitHub keeps the previous
#    version.json. Publish the Release, then run this script again: it sends
#    version.json alone;
#  - shows the list of changes and waits for "y". Never a forced push.
#
# First time: create the repository on github.com (empty: no README, no
# licence). git asks for your GitHub name and a token (github.com/settings/
# tokens, "repo" rights) instead of the password; the macOS keychain keeps it.
# ==========================================================================
set -uo pipefail
# the list of changes is long on a first push: never open it in a pager (less shows ":" and waits)
export GIT_PAGER=cat PAGER=cat
SRC="$(cd "$(dirname "$0")/.." && pwd)"
trap 'echo; read -r -p "Press Enter to close..." _' EXIT
fail() { printf '\n\033[31m[STOPPED] %s\033[0m\n' "$*" >&2; exit 1; }
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v git >/dev/null || fail "git is missing (xcode-select --install)"
command -v curl >/dev/null || fail "curl is missing"

# ---- versions ----------------------------------------------------------------
json_field() { sed -n "s/^ *\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -1; }
[ -f "$SRC/version.json" ] || fail "version.json is missing"
VERSION="$(json_field "$SRC/version.json" version)"
REPO_URL="$(json_field "$SRC/version.json" repository)"
PKG_VERSION="$(json_field "$SRC/package.json" version)"
[ -n "$VERSION" ] || fail "no version in version.json"
[ -n "$REPO_URL" ] || fail "no repository in version.json"
[ "$VERSION" = "$PKG_VERSION" ] || fail "version.json says $VERSION but package.json says $PKG_VERSION"
SLUG="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#\.git$##; s#/$##')"
TAG="v$VERSION"

# 1 when $1 > $2 (X.Y.Z)
newer() {
  local IFS=.; local -a a=($1) b=($2)
  for i in 0 1 2; do
    [ "${a[i]:-0}" -gt "${b[i]:-0}" ] && return 0
    [ "${a[i]:-0}" -lt "${b[i]:-0}" ] && return 1
  done
  return 1
}

say "=== OBS Conductor $VERSION -> github.com/$SLUG ==="

# ---- temporary copy of the repository ---------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; echo; read -r -p "Press Enter to close..." _' EXIT
CLONE="$TMP/repo"
echo "Reading GitHub..."
# (PUSH_REMOTE / PUSH_API: only to test the script against a local copy)
git clone --quiet "${PUSH_REMOTE:-https://github.com/$SLUG.git}" "$CLONE" 2>"$TMP/clone.log" || { cat "$TMP/clone.log"; fail "could not read github.com/$SLUG (does the repository exist?)"; }
cd "$CLONE" || exit 1
git config core.autocrlf false
git config core.fileMode true
HAS_HISTORY=0; git rev-parse --verify -q HEAD >/dev/null && HAS_HISTORY=1

PUBLISHED=""
[ $HAS_HISTORY = 1 ] && PUBLISHED="$(git show HEAD:version.json 2>/dev/null | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -1)"
if [ -n "$PUBLISHED" ]; then
  echo "On GitHub: $PUBLISHED   This folder: $VERSION"
  newer "$VERSION" "$PUBLISHED" || fail "version $VERSION is not newer than the one on GitHub ($PUBLISHED): bump the version first"
else
  echo "On GitHub: no version yet   This folder: $VERSION"
fi

# ---- is the Release published, with its files? --------------------------------------
RELEASE_OK=0
code="$(curl -s -o "$TMP/release.json" -w '%{http_code}' "${PUSH_API:-https://api.github.com}/repos/$SLUG/releases/tags/$TAG")"
if [ "$code" = "200" ] && grep -q '"browser_download_url"' "$TMP/release.json" && ! grep -q '"draft": *true' "$TMP/release.json"; then
  RELEASE_OK=1
  echo "Release $TAG: published, with its files"
elif [ "$code" = "200" ] || [ "$code" = "404" ]; then
  echo "Release $TAG: not published yet (or without its files)"
else
  echo "Release $TAG: GitHub didn't answer (HTTP $code) - counted as not published"
fi

# ---- GitHub = this folder ----------------------------------------------------------
find "$CLONE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
( cd "$SRC" && tar -cf - --exclude='./.git' --exclude='./node_modules' --exclude='./dist' --exclude='./dist_installer' \
    --exclude='./build' --exclude='.DS_Store' --exclude='*/.DS_Store' --exclude='./scripts/signing.local' . ) | tar -xf - -C "$CLONE" \
  || fail "copy failed"
if [ $RELEASE_OK = 0 ]; then
  # version.json waits for the Release: GitHub keeps its own (or none)
  if [ $HAS_HISTORY = 1 ] && git cat-file -e HEAD:version.json 2>/dev/null; then git checkout -q HEAD -- version.json; else rm -f version.json; fi
fi
git add -A
# the scripts stay executable on every Mac / Linux that downloads them
git ls-files -- '*.command' '*.sh' | while read -r f; do git update-index --chmod=+x "$f"; done

if git diff --cached --quiet; then
  if [ $RELEASE_OK = 0 ]; then
    echo; echo "Nothing new to send. Next: publish the Release $TAG on GitHub (with its files), then run this script again for version.json."
  else
    echo; echo "GitHub is already up to date ($VERSION)."
  fi
  exit 0
fi

say "Changes to send"
git diff --cached --name-status
echo
git diff --cached --shortstat
if [ $RELEASE_OK = 0 ]; then
  MSG="$TAG"
  echo; echo "version.json is NOT sent yet (the Release $TAG is not published)."
else
  MSG="$TAG"
  [ $HAS_HISTORY = 1 ] && [ "$(git diff --cached --name-only)" = "version.json" ] && MSG="version.json: $VERSION (Release $TAG published)"
fi
echo
read -r -p "Send these changes to GitHub? [y/N] " a
[ "$a" = "y" ] || [ "$a" = "Y" ] || fail "nothing sent"

# who signs the change: your git settings, else asked once
if [ -z "$(git config user.name)" ]; then
  read -r -p "Your name for GitHub's history: " n; git config --global user.name "$n"
fi
if [ -z "$(git config user.email)" ]; then
  read -r -p "Your e-mail for GitHub's history (or your GitHub noreply address): " e; git config --global user.email "$e"
fi
git commit -q -m "$MSG" || fail "commit failed"
git push origin HEAD:main || fail "GitHub refused the push (nothing forced). Read the message above."

say "=== Sent: $MSG ==="
if [ $RELEASE_OK = 0 ]; then
  echo "Next:"
  echo "  1. github.com/$SLUG/releases/new  -> tag $TAG, attach the files from dist/"
  echo "  2. run this script again: it sends version.json"
fi
