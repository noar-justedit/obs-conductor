#!/bin/bash
# ==========================================================================
# OBS Conductor - builds the Linux versions, ON LINUX (64-bit PC).
#   ./build_linux.sh          (or: bash build_linux.sh)
#
# Result, in dist/:
#   obs-conductor_X.Y.Z_amd64.deb         Debian, Ubuntu, Pop!_OS, Mint...
#   OBSConductor-X.Y.Z-x86_64.AppImage    any distribution, nothing to install
#
# Needs: curl and dpkg-deb (there on Debian / Ubuntu / Pop!_OS). Node.js is
# downloaded by the script; appimagetool too (from its GitHub page).
#
# Installed to /opt/obs-conductor (.deb), started from the applications menu
# ("OBS Conductor") or with the command  obs-conductor
# ==========================================================================
cd "$(dirname "$0")" || exit 1
source scripts/build_common.sh

say "=== OBS Conductor $APP_VERSION - Linux build ==="
[ "$(uname -s)" = "Linux" ] || fail "this script runs on Linux (the Mac builds macOS and Windows)"
[ "$(uname -m)" = "x86_64" ] || fail "64-bit PC (x86_64) only"
command -v dpkg-deb >/dev/null || fail "dpkg-deb is missing (sudo apt install dpkg)"

# the 512 x 512 icon of the packages (src/icons/app-512.png). If the file is
# missing from your copy, it is redrawn from src/icons/app.svg.
ICON="src/icons/app-512.png"
if [ ! -s "$ICON" ]; then
  [ -s src/icons/app.svg ] || fail "src/icons/app-512.png and src/icons/app.svg are both missing: your copy of the project is incomplete (unzip obsConductor_vX.Y.Z.zip again, or git pull)"
  echo "src/icons/app-512.png is missing: drawing it from app.svg..."
  # each tool is tried in turn; one that fails (e.g. ImageMagick without SVG support) is skipped
  { command -v rsvg-convert >/dev/null && rsvg-convert -w 512 -h 512 src/icons/app.svg -o "$ICON"; } >/dev/null 2>&1 || true
  [ -s "$ICON" ] || { command -v inkscape >/dev/null && inkscape src/icons/app.svg -w 512 -h 512 -o "$ICON"; } >/dev/null 2>&1 || true
  [ -s "$ICON" ] || { command -v magick >/dev/null && magick -background none -density 1536 src/icons/app.svg -resize 512x512 "$ICON"; } >/dev/null 2>&1 || true
  [ -s "$ICON" ] || { command -v convert >/dev/null && convert -background none -density 1536 src/icons/app.svg -resize 512x512 "$ICON"; } >/dev/null 2>&1 || true
  [ -s "$ICON" ] || python3 -c 'import cairosvg; cairosvg.svg2png(url="src/icons/app.svg", write_to="src/icons/app-512.png", output_width=512, output_height=512)' >/dev/null 2>&1 || true
  [ -s "$ICON" ] || { rm -f "$ICON"; fail "src/icons/app-512.png is missing and nothing here can draw it. Fix: sudo apt install librsvg2-bin   (then run the build again), or unzip the project again"; }
  [ -s "$ICON" ] || fail "could not draw src/icons/app-512.png - get the file from the project (unzip again, or git pull)"
fi

host_node
run_tests
say "Node.js $NODE_VERSION for Linux"
TGZ="$(fetch_node "node-v$NODE_VERSION-linux-x64.tar.gz")"
WORK="$ROOT/build/linux"; rm -rf "$WORK"; mkdir -p "$WORK"
tar -xzf "$TGZ" -C "$WORK"
NODE_DIR="$WORK/node-v$NODE_VERSION-linux-x64"

# app_tree <dest>: node + app + launcher script, as installed in /opt
app_tree() {
  local d="$1"
  mkdir -p "$d"
  cp "$NODE_DIR/bin/node" "$d/node"
  cp "$NODE_DIR/LICENSE" "$d/NODE-LICENSE.txt"
  stage_app "$d/app"
}

DESKTOP_ENTRY='[Desktop Entry]
Type=Application
Name=OBS Conductor
GenericName=Playlist dock for OBS Studio
Comment=Scenes on air one after the other, master / slave
Exec=obs-conductor
Icon=obs-conductor
Terminal=false
Categories=AudioVideo;Video;
Keywords=OBS;playlist;scenes;
Actions=stop;adddock;simulate;

[Desktop Action stop]
Name=Stop OBS Conductor
Exec=obs-conductor --stop

[Desktop Action adddock]
Name=Add the dock to OBS (OBS closed)
Exec=obs-conductor --add-dock

[Desktop Action simulate]
Name=OBS Conductor (simulation, no OBS)
Exec=obs-conductor --simulate'

# ---- .deb ---------------------------------------------------------------------
say ".deb package"
DEB="$WORK/deb"
app_tree "$DEB/opt/obs-conductor"
mkdir -p "$DEB/usr/bin" "$DEB/usr/share/applications" "$DEB/DEBIAN" \
         "$DEB/usr/share/icons/hicolor/512x512/apps" "$DEB/usr/share/icons/hicolor/scalable/apps" "$DEB/usr/share/doc/obs-conductor"
cat > "$DEB/usr/bin/obs-conductor" <<'EOF'
#!/bin/sh
# OBS Conductor (installed by the .deb): runs in the background, its interface
# is the dock inside OBS. Log: ~/.config/obs-conductor/logs/OBSConductor.log
#   obs-conductor             start it
#   obs-conductor --stop      stop it
#   obs-conductor --add-dock  add the dock to OBS again (OBS closed)
#   obs-conductor --simulate  try it without OBS
OBSCONDUCTOR_PACKAGED=1 exec /opt/obs-conductor/node /opt/obs-conductor/app/src/main.js "$@"
EOF
chmod 755 "$DEB/usr/bin/obs-conductor"
printf '%s\n' "$DESKTOP_ENTRY" > "$DEB/usr/share/applications/obs-conductor.desktop"
cp src/icons/app-512.png "$DEB/usr/share/icons/hicolor/512x512/apps/obs-conductor.png"
cp src/icons/app.svg "$DEB/usr/share/icons/hicolor/scalable/apps/obs-conductor.svg"
cp LICENSE "$DEB/usr/share/doc/obs-conductor/copyright"
SIZE_KB="$(du -sk "$DEB" | cut -f1)"
cat > "$DEB/DEBIAN/control" <<EOF
Package: obs-conductor
Version: $APP_VERSION
Section: video
Priority: optional
Architecture: amd64
Maintainer: just edit lab <noreply@github.com>
Installed-Size: $SIZE_KB
Recommends: zenity
Homepage: https://github.com/noar-justedit/obs-conductor
Description: Playlist dock for OBS Studio, with master / slave mode
 Puts OBS scenes on air one after the other, each for its own duration, with
 the transition of your choice, and drives slave machines that copy
 everything the master does. Runs in the background; its interface is a dock
 inside OBS (added by the app the first time OBS is closed).
EOF
# the menu learns about the new entry and icon
cat > "$DEB/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
EOF
cp "$DEB/DEBIAN/postinst" "$DEB/DEBIAN/postrm"
chmod 755 "$DEB/DEBIAN/postinst" "$DEB/DEBIAN/postrm"
find "$DEB" -type d -exec chmod 755 {} +
mkdir -p "$DIST"
DEB_OUT="$DIST/obs-conductor_${APP_VERSION}_amd64.deb"
dpkg-deb --root-owner-group --build "$DEB" "$DEB_OUT" >/dev/null || fail "dpkg-deb failed"
echo "$DEB_OUT"

# ---- AppImage -------------------------------------------------------------------
say "AppImage"
# appimagetool and the AppImage runtime: fixed versions, checked against their
# SHA-256 (published on GitHub with the releases), like Node.js (2.3.0). The
# moving "continuous" builds are not used: what goes into the AppImage is
# always the same, known code.
AIT_VERSION="1.9.1"
AIT_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
RUNTIME_VERSION="20251108"
RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
fetch_checked() {   # fetch_checked <url> <file> <sha256>
  if [ ! -s "$2" ] || [ "$(sha256 "$2")" != "$3" ]; then
    echo "Downloading $(basename "$2")..."
    curl -fL --progress-bar "$1" -o "$2.part" || { rm -f "$2.part"; fail "$(basename "$2") could not be downloaded"; }
    mv "$2.part" "$2"
  fi
  [ "$(sha256 "$2")" = "$3" ] || { rm -f "$2"; fail "$(basename "$2") does not match its fingerprint - deleted, run the build again"; }
}
TOOL="$CACHE/appimagetool-$AIT_VERSION-x86_64.AppImage"
RUNTIME="$CACHE/runtime-$RUNTIME_VERSION-x86_64"
fetch_checked "https://github.com/AppImage/appimagetool/releases/download/$AIT_VERSION/appimagetool-x86_64.AppImage" "$TOOL" "$AIT_SHA256"
fetch_checked "https://github.com/AppImage/type2-runtime/releases/download/$RUNTIME_VERSION/runtime-x86_64" "$RUNTIME" "$RUNTIME_SHA256"
chmod +x "$TOOL"
APPDIR="$WORK/OBSConductor.AppDir"
app_tree "$APPDIR/usr/lib/obs-conductor"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
# OBS Conductor AppImage: same as the installed command (see the .deb)
HERE="$(dirname "$(readlink -f "$0")")"
OBSCONDUCTOR_PACKAGED=1 exec "$HERE/usr/lib/obs-conductor/node" "$HERE/usr/lib/obs-conductor/app/src/main.js" "$@"
EOF
chmod 755 "$APPDIR/AppRun"
printf '%s\n' "$DESKTOP_ENTRY" | sed '/^Actions=/,$d' > "$APPDIR/obs-conductor.desktop"
cp src/icons/app-512.png "$APPDIR/obs-conductor.png"
cp src/icons/app-512.png "$APPDIR/.DirIcon"
APPIMAGE_OUT="$DIST/OBSConductor-$APP_VERSION-x86_64.AppImage"
rm -f "$APPIMAGE_OUT"
# no FUSE needed to run the tool itself
# the runtime given (checked above): the tool downloads nothing itself
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream --runtime-file "$RUNTIME" "$APPDIR" "$APPIMAGE_OUT" >"$WORK/appimagetool.log" 2>&1 \
  || { tail -20 "$WORK/appimagetool.log"; fail "appimagetool failed"; }
chmod +x "$APPIMAGE_OUT"
echo "$APPIMAGE_OUT"

say "=== Done ==="
echo "Install the .deb:  sudo apt install ./dist/obs-conductor_${APP_VERSION}_amd64.deb"
