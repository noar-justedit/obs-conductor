#!/bin/bash
# ==========================================================================
# OBS Conductor - builds the macOS version. Double-click it (on a Mac).
#
# Result: dist/OBSConductor-X.Y.Z-mac.dmg
#   for Macs with Apple Silicon (M1 and newer), macOS 11 or newer (no Intel
#   version since 2.3.0, Noar's choice),
#   signed with your Developer ID and notarized by Apple.
#
# Needs: Xcode's command line tools (clang, codesign, notarytool), installed
# with "xcode-select --install". Node.js is downloaded by the script itself.
#
# Signing: the "Developer ID Application" certificate of your keychain is
# found by itself. Notarization uses a notarytool profile saved in the
# keychain; its name is asked once and kept in scripts/signing.local (never
# sent to GitHub). No certificate: the script offers an unsigned build.
# ==========================================================================
cd "$(dirname "$0")" || exit 1
source scripts/build_common.sh
trap 'echo; read -r -p "Press Enter to close..." _' EXIT

say "=== OBS Conductor $APP_VERSION - macOS build ==="
[ "$(uname -s)" = "Darwin" ] || fail "this script runs on a Mac"
command -v clang >/dev/null && command -v codesign >/dev/null \
  || fail "Xcode's command line tools are missing: run  xcode-select --install  then this script again"

# ---- 1. signing identity + notarization profile --------------------------
SIGN_ID="" NOTARY_PROFILE=""
[ -f scripts/signing.local ] && source scripts/signing.local
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "$SIGN_ID" ]; then
  echo "No \"Developer ID Application\" certificate in your keychain."
  ask "Build an UNSIGNED app (macOS will block it until it is allowed by hand)?" || fail "stopped"
else
  echo "Signing as: $SIGN_ID"
  if [ -z "$NOTARY_PROFILE" ]; then
    echo "Name of your notarytool profile (the one given to: xcrun notarytool store-credentials <name>)."
    read -r -p "Profile name (empty = no notarization): " NOTARY_PROFILE
    printf 'SIGN_ID="%s"\nNOTARY_PROFILE="%s"\n' "$SIGN_ID" "$NOTARY_PROFILE" > scripts/signing.local
    echo "Saved in scripts/signing.local (stays on this Mac)."
  fi
fi

# ---- 2. Node.js for both processors + tests --------------------------------
host_node
run_tests
say "Node.js $NODE_VERSION for Apple Silicon"
ARM="$(fetch_node "node-v$NODE_VERSION-darwin-arm64.tar.gz")"
WORK="$ROOT/build/mac"; rm -rf "$WORK"; mkdir -p "$WORK"
tar -xzf "$ARM" -C "$WORK"
NODE_DIR="$WORK/node-v$NODE_VERSION-darwin-arm64"

# ---- 3. the app bundle ------------------------------------------------------
say "Putting the app together"
APP="$WORK/OBS Conductor.app"
C="$APP/Contents"
mkdir -p "$C/MacOS" "$C/Resources"
cp "$NODE_DIR/bin/node" "$C/MacOS/node"
# Node.js's licence goes with it (MIT: its text must be shipped). Looked for
# wherever the archive put it; none: stop and show what the archive holds.
NODE_LIC="$(find "$NODE_DIR" -maxdepth 3 -type f \( -iname 'LICENSE' -o -iname 'LICENSE.md' -o -iname 'LICENSE.txt' \) 2>/dev/null | head -1)"
if [ -z "$NODE_LIC" ]; then
  ls -la "$NODE_DIR"
  fail "Node.js's LICENSE file is not in the archive (contents above): send this window"
fi
cp "$NODE_LIC" "$C/Resources/NODE-LICENSE.txt"
stage_app "$C/Resources/app"
# the launcher: a small program that starts Node.js with the app
clang -O2 -arch arm64 -mmacosx-version-min=11.0 -o "$C/MacOS/OBSConductor" installer/mac/launcher.c \
  || fail "the launcher did not compile"
# the menu bar icon (top right of the screen): a second small program, started
# by the app. If it does not compile the app is built without it (no icon,
# everything else works); the dock's Settings > Quit and --stop still quit.
if clang -O2 -fobjc-arc -arch arm64 -mmacosx-version-min=11.0 -framework Cocoa \
     -o "$C/MacOS/OBSConductorMenu" installer/mac/menubar.m 2>"$WORK/menubar.log"; then
  echo "Menu bar icon: built"
else
  rm -f "$C/MacOS/OBSConductorMenu"
  printf '\n\033[33m[WARNING] the menu bar icon did not compile - the app is built WITHOUT it (details: build/mac/menubar.log)\033[0m\n'
  head -20 "$WORK/menubar.log"
fi
# icon: 1024 px drawing -> every size macOS wants
ICONSET="$WORK/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s src/icons/app-mac-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) src/icons/app-mac-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$C/Resources/AppIcon.icns"
sed "s/@VERSION@/$APP_VERSION/g" installer/mac/Info.plist > "$C/Info.plist"
printf 'APPL????' > "$C/PkgInfo"

# ---- 4. signature + notarization ------------------------------------------
notarize() {   # notarize <file>
  [ -n "$NOTARY_PROFILE" ] || return 0
  echo "Notarizing $(basename "$1") (a few minutes)..."
  # its own error must reach the message below (set -e would stop here silently)
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 | tee "$WORK/notary.log" || true
  grep -q "status: Accepted" "$WORK/notary.log" || fail "Apple refused the notarization - see above (xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE)"
}
if [ -n "$SIGN_ID" ]; then
  say "Signing"
  # Node.js compiles JavaScript as it runs: it needs these rights under the
  # hardened runtime (installer/mac/node.entitlements)
  codesign --force --timestamp --options runtime --entitlements installer/mac/node.entitlements --sign "$SIGN_ID" "$C/MacOS/node"
  # inside out: the menu bar program BEFORE OBSConductor (signing the main program
  # signs the whole app, which refuses an unsigned program inside it)
  if [ -f "$C/MacOS/OBSConductorMenu" ]; then
    codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$C/MacOS/OBSConductorMenu"
  fi
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$C/MacOS/OBSConductor"
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$APP"
  codesign --verify --strict --deep "$APP" || fail "the signature does not check out"
  # the app itself is notarized and stapled first: it then opens without
  # internet, wherever it is copied
  ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip"
  [ -n "$NOTARY_PROFILE" ] && xcrun stapler staple "$APP"
fi

# ---- 5. the .dmg -----------------------------------------------------------
say "Disk image"
mkdir -p "$DIST"
DMG="$DIST/OBSConductor-$APP_VERSION-mac.dmg"
rm -f "$DMG"
STAGE="$WORK/dmg"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/OBS Conductor.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "OBS Conductor $APP_VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null || fail "hdiutil failed"
if [ -n "$SIGN_ID" ]; then
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  notarize "$DMG"
  [ -n "$NOTARY_PROFILE" ] && xcrun stapler staple "$DMG"
fi

say "=== Done ==="
echo "$DMG"
if [ -n "$SIGN_ID" ] && [ -n "$NOTARY_PROFILE" ]; then
  spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | tail -1 || true
else
  # other Macs block an app that is not notarized: said plainly (review 2.2.2)
  printf '\n\033[33mWARNING: this .dmg is NOT notarized%s: other Macs will block it. Do not publish it.\033[0m\n' \
    "$([ -z "$SIGN_ID" ] && echo ' (not even signed)')"
fi
open -R "$DMG"
