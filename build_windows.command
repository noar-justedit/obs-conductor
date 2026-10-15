#!/bin/bash
# ==========================================================================
# OBS Conductor - builds the Windows installer ON A MAC. Double-click it.
#
# Result: dist/OBSConductor-Setup-X.Y.Z.exe   (Windows 10 / 11, 64-bit)
#
# How: the Windows version of Node.js (renamed OBSConductor.exe: nothing is
# compiled) + the app's code, packed by NSIS, an installer maker that also
# runs on macOS. NSIS comes from Homebrew (brew install makensis): the script
# offers to install it when missing.
#
# Not signed for Windows (no Windows certificate): SmartScreen shows
# "Windows protected your PC" the first time -> More info -> Run anyway.
# ==========================================================================
cd "$(dirname "$0")" || exit 1
source scripts/build_common.sh
trap 'echo; read -r -p "Press Enter to close..." _' EXIT

say "=== OBS Conductor $APP_VERSION - Windows build ==="

# ---- 1. NSIS ---------------------------------------------------------------
if ! command -v makensis >/dev/null; then
  command -v brew >/dev/null || fail "NSIS is missing and Homebrew isn't installed (https://brew.sh), then: brew install makensis"
  ask "NSIS (installer maker) is missing. Install it with Homebrew now?" || fail "stopped"
  brew install makensis || fail "brew install makensis failed"
fi
echo "NSIS $(makensis -VERSION)"

# ---- 2. tests + Node.js for Windows ------------------------------------------
host_node
run_tests
say "Node.js $NODE_VERSION for Windows"
ZIP="$(fetch_node "node-v$NODE_VERSION-win-x64.zip")"
WORK="$ROOT/build/win"; rm -rf "$WORK"; mkdir -p "$WORK"
unzip -q "$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$WORK"

# ---- 3. app folder: node.exe renamed + launchers + sources --------------------
# OBSConductor.exe is Node.js itself, renamed: the name tells paths.js it runs
# installed (settings in %LOCALAPPDATA%), and Node.js's own signature stays.
say "Putting the app together"
OUT="$WORK/OBSConductor"
mkdir -p "$OUT"
cp "$WORK/node-v$NODE_VERSION-win-x64/node.exe" "$OUT/OBSConductor.exe"
cp "$WORK/node-v$NODE_VERSION-win-x64/LICENSE" "$OUT/NODE-LICENSE.txt"
cp installer/OBSConductor.vbs installer/OBSConductor.cmd "$OUT/"
stage_app "$OUT/app"
# Windows' own line endings for its scripts
for f in "$OUT/OBSConductor.vbs" "$OUT/OBSConductor.cmd"; do
  perl -pi -e 's/\r?\n/\r\n/' "$f"
done

# ---- 4. installer -------------------------------------------------------------
say "Installer"
mkdir -p "$DIST"
SETUP="$DIST/OBSConductor-Setup-$APP_VERSION.exe"
rm -f "$SETUP"
makensis -V2 -DVERSION="$APP_VERSION" -DSRCDIR="$OUT" -DOUTFILE="$SETUP" installer/OBSConductor.nsi \
  || fail "NSIS could not build the installer - see above"

say "=== Done ==="
echo "$SETUP"
echo "Copy it to a Windows PC and double-click it."
[ "$(uname -s)" = "Darwin" ] && open -R "$SETUP"
exit 0
