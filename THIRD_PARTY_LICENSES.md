# Third-party software and assets

OBS Conductor is licensed under the **GNU General Public License v3.0 or
later** (see [LICENSE](LICENSE)). It includes or ships with the following
works from other authors. All of their licences allow redistribution inside
a GPL-3.0 program.

| What | Where | Author | Licence | Licence text |
|---|---|---|---|---|
| **Node.js** runtime (in the builds only, not in this repository) | `OBSConductor.exe` (Windows), `OBS Conductor.app/Contents/MacOS/node` (macOS), `/opt/obs-conductor/node` (Linux) | OpenJS Foundation and Node.js contributors | MIT, with the licences of its bundled libraries | `NODE-LICENSE.txt`, next to the runtime in every build |
| **yaml** (npm package) | `node_modules/yaml` | Eemeli Aro | ISC | `node_modules/yaml/LICENSE` |
| **Poppins** typeface (logo, ON AIR sign) | `src/fonts/Poppins-Bold.ttf` | The Poppins Project Authors | SIL Open Font License 1.1 | [`src/fonts/Poppins-OFL.txt`](src/fonts/Poppins-OFL.txt) |
| **Oswald** typeface | `src/fonts/Oswald.ttf` | The Oswald Project Authors | SIL Open Font License 1.1 | [`src/fonts/Oswald-OFL.txt`](src/fonts/Oswald-OFL.txt) |
| **Lucide** icons (the app icon is Lucide's "list-video"; several dock icons follow Lucide's drawings) | `src/icons/`, `src/dock.html` | Lucide Icons and Contributors | ISC | [`src/icons/LUCIDE-LICENSE.txt`](src/icons/LUCIDE-LICENSE.txt) |

Protocol information for the tally (no code copied: OBS Conductor has its
own drivers, `src/tally/drivers/`) comes from these Bitfocus Companion
modules, all MIT licence: companion-module-bmd-atem (and its library
atem-connection), companion-module-roland-v160hd, companion-module-
studiocoast-vmix, companion-module-newtek-tricaster, companion-module-barco-
eventmaster, companion-module-analogway-livepremier, companion-module-
analogway-awj, companion-module-analogway-livecore, companion-module-
pixelhue-switcher, companion-module-panasonic-kairos
(https://github.com/bitfocus), and from the manufacturers' published
protocol guides (Roland, Barco, Analog Way, vMix, Panasonic). Brand and
product names belong to their owners.

Build tools used to make the installers (not shipped inside the app):
NSIS (zlib/libpng licence) for the Windows installer, appimagetool (MIT) for
the AppImage, Apple's Xcode command line tools for the macOS app.

OBS Studio is a trademark of its owners. OBS Conductor is an independent tool
that talks to OBS Studio through its WebSocket server; it is not made or
endorsed by the OBS Project.
