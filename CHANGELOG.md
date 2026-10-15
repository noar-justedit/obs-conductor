# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions X.Y.Z.

## [2.2.1] — 2026-10-15

### Added
- **STOP TALLY** (the tally is in beta): the tally starts stopped each time
  the app starts; Settings > Tally > "Turn the tally on". While it runs, a
  red STOP TALLY button at the top of the dock stops it in one click, even
  when the dock is locked. Stopped, OBS Conductor opens no connection and
  sends not one byte to any switcher, and the open ones are closed at once
  (`src/tally/guard.js`, tested). OBS and the master / slave links go on.
- macOS: the log says when the menu bar icon starts, and why it stopped if
  it does (its error messages).

### Changed
- Scan: to a machine not known yet it sends nothing but a TCP connection
  and, for some models, ONE read request (GET). vMix, Roland and Ascender
  are found by their greeting (nothing sent); TriCaster, Aquilon, PixelHue
  and KAIROS by one GET. ATEM (a hello would open a session on any device)
  and Barco (POST requests) are no longer scanned: choose them in the list.
  KAIROS is found on its REST port (GET /inputs) instead of port 3005.

### Fixed
- Text centred in the MASTER / SLAVE switch, STOP TALLY, the ON AIR / PVW
  badge and the slave status badge (small capitals sat about 1 px high).

## [2.2.0] — 2026-10-15

### Added
- Tally from many switchers, not only PixelHue: Blackmagic ATEM, Roland
  V-160HD, vMix, TriCaster / Viz Vectar, Barco E2 / S3 / EX / Encore 3,
  Analog Way Aquilon (LivePremier) and Ascender (LiveCore), PixelHue Q8 /
  P10 / P20 / P80, Panasonic KAIROS. Settings > Tally: choose the model, or
  **Scan** the network (on demand only) and click the one found; address,
  port, login when the model has one; the input of this OBS in the list read
  from the switcher.
- Architecture: OBS Conductor's own tally engine (`src/tally/index.js`), one
  "translation" driver per family (`src/tally/drivers/`), protocols taken
  from the Bitfocus Companion modules (MIT) and the makers' guides, no
  Companion code copied. Adding a machine: `docs/TALLY-DEVICES.md`.

### Security
- Tally read-only guard (`src/tally/guard.js`): every message to a switcher
  is checked against the driver's closed list of reads and refused
  otherwise. Allowed (Noar's choice): reads, plus opening a session (ATEM),
  a login (Roland, Analog Way, TriCaster, KAIROS), a subscription. Tested
  against a fake machine per driver; no driver can open a connection itself.
- The tally password never leaves this PC (the dock only sees
  `has_password`). The switcher address must be an IP or a name.

### Not supported
- Roland V-60HD / XS-62S (one network connection only: would lock out
  Companion), V-1200HD (no read command known), older Barco Encore (no tally
  read). Recognised on the Roland port and refused without retrying.

### Note
- The new drivers are tested against fake machines built from the protocol
  documents, not yet on real hardware (PixelHue: unchanged, field-tested).

## [2.1.2] — 2026-10-15

### Fixed
- `scripts/push_github.command`: on a first push the list of changes is long
  and git showed it in its pager (a ":" prompt, waiting for a key). The
  pager is now turned off, the list is printed in full. No change to the app.

## [2.1.1] — 2026-10-15

### Fixed
- `build_mac.command` (2.1.0): the build stopped while signing ("code object
  is not signed at all, in subcomponent OBSConductorMenu"), so no .dmg was
  made. The menu bar program is now signed before the main program (inside
  out, as macOS requires). No change to the app itself.

## [2.1.0] — 2026-10-15

### Added
- macOS: icon in the menu bar (top right of the screen): the logo with a
  coloured dot (green all good, orange to look at, red connection lost), a
  menu with the state, "Open the dock in a browser", "Show the log" and
  "Quit OBS Conductor" (asks first). It is a small program built by
  `build_mac.command` (`installer/mac/menubar.m`, signed with the app). If it
  does not compile, the app is built without it and the build says so.
  No notifications on macOS. Windows and Linux are unchanged.

### Changed
- macOS: `Info.plist` uses `LSUIElement` instead of `LSBackgroundOnly` (still
  no window and no Dock icon; needed for a menu bar icon).

## [2.0.2] — 2026-10-15

### Fixed
- macOS build: 4 media copy tests failed on a Mac because the tests worked in
  the system temp folder (`/var/folders/...`), which the media copy refuses as
  a system folder. The tests now work in `/tmp`. No change to the app itself.

## [2.0.1] — 2026-10-15

### Fixed
- `build_linux.sh`: when `src/icons/app-512.png` (the 512 x 512 icon of the
  .deb and the AppImage) is missing from the copy of the project, the script
  now redraws it from `src/icons/app.svg` (rsvg-convert, Inkscape, ImageMagick
  or cairosvg, whichever is there), and stops with a clear message if nothing
  can. No change to the app itself.

## [2.0.0] — 2026-10-14

### Added
- macOS and Linux versions. macOS: universal app (Apple Silicon and Intel,
  macOS 11+), signed and notarized, in a .dmg; no window and no Dock icon,
  the dock in OBS is its interface. Linux: .deb (Debian, Ubuntu, Pop!_OS...)
  and AppImage, x86_64; OBS from Flathub supported.
- The app adds its dock to OBS by itself the first time OBS is closed (all
  systems), then never again unless asked (`--add-dock`) or the dock's port
  changes. The dock points at a copy of its loader page in the user's
  settings folder, which never moves.
- Command line on every system: `--stop` (stops the running app),
  `--add-dock` (adds the dock again, OBS closed), `--simulate`.
- Save / Open / Choose folder windows on macOS (AppleScript) and Linux
  (zenity, else kdialog).
- Builds: `build_mac.command` and `build_windows.command` on the Mac,
  `build_linux.sh` on Linux. Each downloads the Node.js runtime itself
  (checked against nodejs.org's SHA-256 list) and runs the tests first.
- Published on GitHub (github.com/noar-justedit/obs-conductor) under the
  GNU GPL v3.0 or later: LICENSE, THIRD_PARTY_LICENSES.md, README with
  screenshots, `version.json` and `scripts/push_github.command`.

### Changed
- Top of the on-air card: the tally centred on the panel, the state badge
  (IDLE / RUNNING, or the slave's STATUS) at the top right, and under it the
  playlist's length and number of cues in one grey badge. ON AIR and PVW are
  semi-transparent (red / green, like the app's buttons) and breathe. On a
  slave and in a narrow dock, the tally sits on its own line above.
- Windows installer made with NSIS instead of Inno Setup (Inno only builds
  on Windows). It takes over a 1.x install (same folder, old uninstall entry
  replaced), keeps the chosen options across updates, no longer asks to
  close OBS (the app adds the dock itself) and starts the app as the user.
  Slaves update with `/S /UPDATE=1` (the 1.x flags still work).
- Updates from the master: Windows to Windows only. A slave on macOS /
  Linux, or whose master runs another system, says "install by hand".
- Media sync: the top folder of a macOS / Linux path is the disk or the
  user's folder (`/Volumes/SSD`, `/Users/name`, `/home/name`,
  `/media/user/SSD`, `/mnt/nas`), asked on a slave that doesn't have it.
  More file types and system folders refused (scripts, apps, packages,
  LaunchAgents, autostart, shell settings).
- Texts of the dock and its loader page worded for the system (Start menu /
  Applications / applications menu).

### Removed
- `build_windows.bat` and `installer/setup.iss` (Inno Setup).

## [1.8.0] — 2026-10-14

### Fixed
- Sync: the position and size of the sources (scale, rotation, crop,
  bounds) are taken from the master's OBS as they are now. OBS doesn't
  write a move or a resize to its collection file right away, so the slave
  could get the old ones (a media at its original size). Auto sync now also
  sees a move or a resize.

### Changed
- Slave on-air card, simplified: a STATUS badge at the top (FOLLOWING
  MASTER green, FREE RUN orange, DISCONNECTED red), and one row of controls:
  a MASTER switch (connect to / disconnect from the master; off = free run),
  AUTO SYNC ON / OFF and SYNC (icon + text), then the padlock. Replaces the
  MASTER SYNC / FREE RUN button and the SYNC FROM MASTER / AUTO SYNC badges.

## [1.7.1] — 2026-10-12

### Fixed
- Slave: the drift correction (every 2 s, after a reconnection, an OBS
  restart or a click on the slave) used a Cut and left OBS's transition on
  Cut. It now uses the master's transition: the slave stays a mirror of the
  master, and its transition is no longer changed by the correction.
- Master: when OBS comes back during a cue and the cue is put back on air,
  it uses the transition of that cue (or the playlist default) instead of a
  Cut, so the slaves no longer copy a Cut.

## [1.7.0] — 2026-10-10

### Added
- Slave: a FREE RUN button (red) on the on-air card. Click MASTER SYNC
  (green) to stop following the master: this PC keeps its scene, nothing
  from the master reaches it. Click FREE RUN to follow it again. Off in free
  run: SYNC FROM MASTER. New setting `slave.free_run`, reset by a new role.

### Changed
- The padlock moves to the bottom of the on-air card, after the transport
  (master) or the MASTER SYNC / FREE RUN button (slave), a little apart.
- Header: Home and Settings side by side on the right.
- The "at the end" button shows an arrow into a window (a scene) instead of
  a flag.
- Slave: the Sync button is named SYNC FROM MASTER and styled like AUTO SYNC
  (green when it can run, red otherwise).
- The link icon in the header is gone: its function (change master) is in
  Settings > Master > Find another master; the button now switches free run.



### Changed
- Header: Home (house) and the padlock right after MASTER / SLAVE, Settings
  on the right; the three buttons have the same size and colour. The
  padlock is red when locked.
- Tally badge: ON AIR / PVW are plain rectangles in the app's red / green
  (no gradient, no bezel, no glow), in the logo's font (Poppins Bold,
  capitals); ON AIR still pulses. ON AIR and PVW have the same size. Under
  it, the input's name as the switcher sends it, no wider than the badge
  (a longer name scrolls continuously); some space under the block.
- Cue duration: a field that opens a menu - Default, usual durations (5s to
  60s), Custom (any, typed) and Auto-detect (the longest video, or one of
  the scene's videos).
- Settings in sections. Master: DEFAULT SETTINGS (default transition and
  scene duration), WEBSOCKET SERVER (was "Slaves connect with"), TALLY,
  OBS CONDUCTOR SERVER (was "This app"). Slave: MASTER, FALLBACK (switch
  "Show a fallback scene" + "Choose a scene"; off: keeps playing the
  master's playlist), MEDIAS LOCATION (switch "Same as master"; off: a
  folder for each master folder), TALLY, OBS CONDUCTOR SERVER.
- Tally: the description line is gone; "Test connection" button (connects
  again, reads the inputs and screens: time, counts, or why it failed; reads
  only).

### Fixed
- 1.6.3: the slave's "Choose..." buttons (media folders) looked like a list.

 — 2026-10-09

### Added
- Sync on a slave: estimated time left while the media are copied
  ("~3 min 20s left"), shown after a few seconds of copy. It counts only
  what is really fetched (a part fetched by an earlier, cut Sync doesn't
  fake a high speed) and includes the time spent checking the copies.

### Changed
- Settings > Playback: the default transition and its length are chosen in
  two menus, the same as the playlist's badges (usual lengths 0.25s to 3s,
  or "Other" in seconds), instead of a list and a field in milliseconds.

## [1.6.2] — 2026-10-09

### Changed
- The Playlist tab icon is a house (Home).
- Transition of a cue: two badges, its name (FADE, CUT...) and its length
  (0.5s), instead of an icon button and one badge. Click the name: menu of
  transitions; click the length: usual lengths or any other. Same two
  badges, read-only, on a slave.

## [1.6.1] — 2026-10-09

### Changed
- Firewall rules (installer option): only the PCs of the same local network
  can reach the app and OBS's WebSocket (remote address: local subnet).
- Seconds are written the same way everywhere ("12.48s", "Fade 0.5s"); the
  playlist line shows whole seconds on both sides ("-1:43 / 1:49").

### Fixed
- Slave: while its master's app doesn't answer but its OBS is still
  followed (the 3 s before MASTER LOST), the card says FOLLOW MASTER and
  "Following the scenes · playlist not reachable" instead of IDLE.

## [1.6.0] — 2026-10-09

Full review (security, bugs, interface).

### Security
- Changes (playlist, play / stop, role, lock, settings, slave, update, quit)
  are accepted from this PC only; the network can only read. A foreign web
  page (other Origin), a non-JSON body or a foreign host name (DNS
  rebinding) is refused. The OBS password goes only to this PC's dock.
- Slave -> master signatures cover the whole address (path and query) and
  last 2 minutes. The update offered by the master is sealed with its
  password: a fake master can't push its own installer.
- Media copy refuses ".." paths, programs / scripts and Windows' folders.
- Dock: switcher screen names are escaped in the tally input list.

### Fixed
- Tally: a failed read of the screen list no longer shows everything ON
  AIR (multiviewer layers never count).
- Slave playing alone: a scene missed while OBS was away is sent when it is
  back.
- Media Sync no longer moves files put on the slave by hand.
- Two clicks on Update no longer start two installers.
- Switching a slave to master during a Sync stops the Sync before it loads
  the old master's scenes.
- After choosing a folder, the Sync goes on with its own parts.
- Archive folder and free-space check right for a whole drive (E:\) and
  network shares.

### Changed (interface)
- One cut for every small badge (the ACTIVE / SKIPPED one).
- Narrow dock (300 px): ON AIR on its own line, slave cue badges under the
  name, logo no longer cut; Sync and update status on their own line.
- The cue on air no longer looks skipped; lock mode dims the cue rows too.
- NO TALLY is red (disconnected), like the Settings badge; hints to act are
  orange; plain messages instead of technical errors (detail on hover).
- Confirm buttons take the colour of the action (Quit red, Update green).
- Slave Settings > Master: CONNECTED only when both the master's OBS and
  app answer (same rule as the link icon).
- Wording: "cue" everywhere, "(not in OBS)", "Choose...", tooltips.
- Settings show only what fits the role; version shown once (footer).
- The dock has an icon (favicon).

## [1.5.4] — 2026-10-08

### Fixed
- Build: a test failed when OBS was open on the PC that builds ("install
  refuses when OBS never ran"), which stopped the build. The tests no
  longer depend on OBS being open or closed (OBSCONDUCTOR_OBS_RUNNING, tests
  only). The app itself is unchanged.

## [1.5.3] — 2026-10-08

### Changed
- Tally: the bar at the top is gone; a big badge, centred in the free space of the on-air card, sits next to RUNNING /
  IDLE in the on-air card (ON AIR solid red, PVW solid green, NO TALLY
  orange). ON AIR also frames the whole panel in red, breathing. PVW: no
  frame. ON AIR and PVW look like a studio light box (lit panel, thick
  condensed letters: Oswald, SIL OFL, src/fonts); ON AIR pulses with the
  frame.
- Playlist: the transition of each cue is a badge cut like ACTIVE /
  SKIPPED, its length in brackets ("FADE (0.5s)"); grey = the default,
  blue = the cue's own.
- Slave playlist: the badges line up in columns (ACTIVE / SKIPPED, then the
  transition, then the length).

## [1.5.2] — 2026-10-08

### Changed
- Tally, Settings: each input in the list shows where it is now (on air /
  preview on which screen, or multiviewer only), and the status names the
  screens. An input seen only on the multiviewer is flagged: it is likely
  not the OBS feed (seen on a real Q8: "HALL 8" was the screen's return,
  "OBS HALL 8" the OBS feed).

### Fixed
- Tally: a layer switched off on the switcher no longer counts.

## [1.5.1] — 2026-10-08

### Fixed
- Tally: nothing was ever seen ON AIR. The on-air state is now read from
  the switcher's layers (PGM / PVW layers and the screen they are on, as
  the Companion module does), not from its presets. The multiviewer, a
  disabled screen or a screen faded to black don't count as on air.
- Tally diagnosis: http://localhost:8090/api/tally/debug shows what the
  switcher answers (reads only).

## [1.5.0] — 2026-10-08

### Added
- **Tally** from a PixelHue Q8 / P20 / P80: a bar at the top of the dock,
  red ON AIR when this PC's OBS input is on program, green PVW in preview,
  nothing otherwise (a thin orange NO TALLY when the switcher can't be
  reached). Set in Settings > Tally, on each PC: the switcher's address,
  then its input picked from the list the switcher sends. The input named
  like the PC (e.g. "OBS HALL 8" on the PC HALL8) is chosen by itself when
  none is set and only one matches.
  Read only, always: the app never sends a command to the switcher (only
  reads of a fixed list of addresses, checked by a test).

## [1.4.1] — 2026-10-08

### Added
- **Sync asks what to copy**: Scenes, Media, OBS settings, All, one switch
  each (the last choice is kept). Auto sync still copies everything.

### Fixed
- The slave's FPS showed as "Fractional FPS Value" after a Sync: it is now
  set the master's way (e.g. "Common FPS Values: 50").
- Save, Save to... and Load... did nothing: the Windows dialog opened
  hidden. Same fix for the folder dialog (Media on this PC) and the
  taskbar icon's Quit question.

## [1.4.0] — 2026-10-08

### Added
- **Sync copies the master's general OBS settings** (slave): canvas and
  output resolution, FPS, downscale filter, colour format / space / range,
  HDR levels, audio sample rate and channels (audio: at the next OBS start).
  Never the stream key, recording settings, encoders, devices or hotkeys.
  Not while an output is on here (the status says so). Auto sync follows
  these settings too.

### Fixed
- A settings.yaml that can't be read is put aside (settings.yaml.broken-<date>)
  before anything is written; settings are written whole or not at all.
- Media on a network share (\\server\share) no longer blocks Sync.
- Two PCs whose clocks differ no longer get "wrong password" (signed
  requests use the master's time).
- OBS restarted during a cue: the cue's scene is put back on air.
- A folder the slave can't write to is reported as such, not as "in use".
- Sync no longer archives files that were already on the slave, nor
  everything when the master opens another collection for a moment.
- The installer no longer takes over another local tool's dock.
- Cut or cancelled transfers close their file.
- Playback no longer drifts late over a long playlist.
- A new default duration applies at once to the cue on air.
- A deleted "default" playlist no longer comes back at each start.
- Dock: a failed save no longer stops the dock from following the server;
  dragging while the list is redrawn no longer duplicates a cue; the "Where
  to put these media" box hides after a choice; a dismissed error shows
  again when it happens again; errors also clear on a slave; defaults
  changed in another dock show at once.
- Update from the master: the app restarts under the user's account, not as
  administrator; a refused Windows OK is reported after 2 minutes.
- Quit no longer leaves a ghost taskbar icon; "Stop OBS Conductor" says when
  it could not stop the app.

## [1.3.0] — 2026-10-08

Renamed **OBS Conductor** (was OBS Playlist).

### Added
- **Sync scenes** (slave): one button loads the master's scene collection into
  this PC's OBS, without restarting OBS. Missing media and plugins are listed.
- **Quit** from the dock (Settings) and from the taskbar icon (asks first).
- When the app isn't running, the dock in OBS says so instead of an error page.
- New icon (Lucide "list-video").
- **Lock** (padlock at the top): nothing can be changed, played or stopped
  until unlocked.
- Playlist menu: **Save** (into its file, no question) and **Save to...**.
- The cue on air can't be edited.
- **Sync copies the media** (slave): the master's app sends the files its
  scenes use, no Windows share. Skips what is already there, checks every
  copy (SHA-256), resumes a cut copy, archives old versions (never deletes),
  asks for a folder when a master drive doesn't exist here (paths converted).
  Progress, speed, cancel.
- **Auto sync** (slave): syncs by itself when the master's scenes or media
  change. AUTO SYNC badge next to Sync: red off, green on, click to switch.
- Settings > Playback is shown on the master only. A slave that loses its
  master uses the master's values (transition to the fallback scene,
  restart videos when playing on alone).
- Slave playlist: ACTIVE / SKIPPED badges as on the master (read-only).
- State badge at the top of the on-air card instead of ON AIR / STOPPED:
  RUNNING (green) or IDLE (grey) on the master, FOLLOW MASTER or IDLE on a
  slave, MASTER LOST (red) when the master is lost.
- Slave Settings > Master: CONNECTED (green), DISCONNECTED (red) or NOT
  CONFIGURED (grey) badge.
- One colour code everywhere: green works / connected / on, red doesn't
  work / disconnected / off / error, orange the user must act. MASTER /
  SLAVE and the padlock are green when on; the on-air progress is green;
  the master link icon and the slave's problem line are red when the link
  is down.
- **Media on this PC** (slave Settings): the destination of each master
  folder; a change moves the copies already made.
- Version at the bottom of the dock.
- **Versions master / slave**: the slave shows when they differ (and its
  taskbar icon turns orange). **Update to vX** (slave): installs the
  master's newer version from the master itself (installer checked by its
  fingerprint, Windows asks for the OK, the app restarts, OBS stays open).
  The installer keeps a copy of itself for that.
- Taskbar icon: the colour of its play triangle shows the state (green /
  orange / red), nothing else changes.
- **Master lost** (slave): notification, MASTER LOST in the dock, then as
  chosen in Settings > Master: a fallback scene, or keep playing the
  master's playlist alone from where it was.

### Fixed
- A new cue took the length of a looping background video (60 s): loops
  and hidden videos no longer give the duration; with none left, the cue
  follows the default duration.
- The film button disappeared on some scenes: hidden videos are listed, and
  a failed read is tried again instead of hiding the button.
- The progress bars move smoothly (drawn every frame, local clock).
- A slave whose master quit kept counting down the master's playlist.
- **The app never reconnected** to an OBS (or a master) that wasn't running
  when it started (Node 22 sends no "close" after a refused connection).
- "OBS is not ready" (code 207): retried for up to 3 s instead of an error;
  an error now clears at the next scene on air or with a click.

### Changed
- Name, executable `OBSConductor.exe`, settings in `%LOCALAPPDATA%\OBSConductor`
  (copied from `OBSPlaylist` on first launch). The installer updates OBS
  Playlist and renames its dock in OBS.
- Shorter texts everywhere.

## [1.2.0] — 2026-10-07

Simple setup: install, choose master or slave, done. The installer does
everything: app + dock in OBS.

### Added
- **MASTER / SLAVE buttons** at the top of the dock (with confirmation); the
  dock asks at first launch.
- **Slave: finds the master on the network** (OBS with WebSocket on, OBS
  Playlist masters first): pick it, type its password (checked), Connect.
  Or type its address.
- **Master: "Slaves connect with"** in Settings: IP, port, password (show /
  copy; the password only on the master PC itself).
- **OBS WebSocket off**: a banner gives the 3 steps in OBS, and a Windows
  notification; the app connects as soon as it's on.
- **Icon in the Windows taskbar** (state dot, menu: open in a browser, log,
  quit) and **notifications** (started, WebSocket off, master lost / back).
- **Default scene duration** (Settings): cues without a video or a typed
  duration follow it, live (grey in the playlist).
- **Video length read in the file** (.mov / .mp4) when OBS gives none (ProRes
  .mov, file not loaded).
- The installer adds the **OBS Playlist dock to OBS**, switches on **OBS's
  WebSocket server** and copies its password. It asks to close OBS first.
  Uninstalling removes the dock.
- The app reads the **WebSocket port and password from OBS** on this PC at
  each connection.
- **Log file** `%LOCALAPPDATA%\OBSPlaylist\logs\OBSPlaylist.log`.
- Start menu: Stop OBS Playlist, Add the dock to OBS, OBS Playlist log.
- Installer option: **firewall** rules for master / slave, private networks.
- Installer in **French and English**, app icon.

### Changed
- The app runs **in the background, without a window**.
- Start with Windows: Windows "Run" entry of the user (was a scheduled task).
- `build_windows.bat` installs Node.js LTS and Inno Setup with winget when
  missing, stays open at the end and opens the result folder.
- Installer named `OBSPlaylist-Setup-X.Y.Z.exe`.
- `INSTALL.txt` rewritten short, in French; the dock reference is `GUIDE.txt`.

### Removed
- **Media sync** (syncto engine, shared folders, scene collection copy).
- Settings: "OBS on this PC" (read from OBS) and the master / slave switch
  (now at the top).

## [1.1.0] — 2026-10-07

Renamed **OBS Playlist** (was OBS Scheduler), new look and a lighter dock.

### Added
- **Settings tab** (gear): default transition and its length (now one setting
  for all playlists), restart videos on air, connection to the local OBS
  (address, port, password — no more editing settings.yaml), dock port and
  network access, master / slave.
- **Save / load playlists** to `.obsplaylist` files (Windows dialogs).
- **ACTIVE / SKIPPED** per cue: a skipped cue is jumped over, also live, and
  doesn't count in the total.
- **Loop** button and **end action** menu (stay on the last cue, or go to a
  scene) in the transport bar.
- **Video menu** per cue: lists the scene's videos with their length; the one
  picked gives the duration.
- **Transition menu** per cue: default, or a transition and its length.
- **Media folders discovered** on the master: the slave picks among the
  master's Windows shares; copy to the same path or force another folder (OBS
  source paths are then converted).

### Changed
- just edit lab look (same as syncto / ingesto), logo `obs.playlist`.
- Master dock condensed: two lines per cue (the scene name is never cut),
  transport as icons, playlist actions in a "…" menu, total in the on-air card.
- Slave dock much lighter: link status as one icon, one line per cue,
  settings saved as soon as a field is left.
- Executable `OBSPlaylist.exe`, settings in `%LOCALAPPDATA%\OBSPlaylist`
  (copied from `OBSScheduler` on first launch). The installer updates an
  existing OBS Scheduler and removes its startup task.

### Removed
- The **Next** button.
- The "At the end" choice in the playlist options (now the end action button)
  and the per-playlist default transition (now in Settings).

## [1.0.0] — 2026-10-06

OBS Scheduler turned into an OBS dock.

- Sequential playlist in an OBS Custom Browser Dock, served by a companion app
  rewritten in Node.js (was Python).
- Master / slave: the slave follows scenes, transitions and media actions of
  the master; project sync with the syncto engine through a Windows share.
- Windows only, built on Windows (installer with Inno Setup).
- Fixed air times and the day schedule removed.

## Before 1.0.0

OBS Scheduler (Python): day schedule with fixed air times, web dashboard,
master / slave.
