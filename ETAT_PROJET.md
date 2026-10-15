# OBS Conductor — état du projet

*(ex OBS Playlist, ex OBS Scheduler)*, mis à jour le 15 oct. 2026, version **2.2.1**.

## En bref
Dock OBS de playlist de scènes, **Windows, macOS et Linux** (depuis la 2.0),
public sur GitHub (`github.com/noar-justedit/obs-conductor`, GPL-3.0-or-later).
Une appli compagnon (Node.js 22+) tourne en tâche de fond sur chaque PC : elle
déroule la playlist et pilote OBS par obs-websocket (serveur WebSocket intégré à
OBS 28+). Le dock est une page servie par l'appli (`http://localhost:8090/`),
ajoutée dans OBS comme *Custom Browser Dock*. Mode maître / esclave : l'esclave
copie le maître en direct (il le trouve sur le réseau). Windows : icône dans la
barre des tâches avec notifications ; macOS : icône dans la barre de menus
(état + Quit, sans notifications) ; Linux : pas d'icône, l'appli tourne en
arrière-plan sans fenêtre.

## Architecture
| Fichier | Rôle |
|---|---|
| `src/main.js` | point d'entrée, classe `Companion` : boucle de lecture, état pour le dock |
| `src/player.js` | moteur de playlist, logique pure (testé : `test/player.test.js`) |
| `src/server.js` | serveur HTTP + API du dock |
| `src/dock.html` | le dock (HTML/CSS/JS, aucune ressource externe) |
| `src/store.js` | playlists (YAML) + `settings.yaml` (commentaires conservés), fichiers `.obsplaylist` |
| `src/obs.js` | client obs-websocket (WebSocket de Node, reconnexion auto) + helpers (scènes, vidéos, transitions) |
| `src/fake-obs.js` | OBS simulé (`--simulate`) |
| `src/follower.js` | esclave : suivi en direct du maître + lecture de sa playlist |
| `src/scene-sync.js` | esclave : bouton « Sync scenes » (collection du master chargée dans l'OBS local) |
| `src/collection.js` | collections de scènes sur disque, médias et plugins utilisés, chargement dans OBS sans redémarrage |
| `src/media-serve.js` | master : liste, empreinte (cache `media-hashes.json`) et envoi des médias des scènes, reprise par Range |
| `src/media-sync.js` | esclave : copie des médias (comparaison taille + date, `.obsc-part`, vérif SHA-256, archive datée, manifeste `media-manifest.json`) |
| `src/auth.js` | signature des requêtes slave → master avec le mot de passe WebSocket du master |
| `src/dock-loader.html` | page locale ouverte par le dock d'OBS : passe la main à l'appli, ou dit qu'elle ne tourne pas |
| `src/discovery.js` | esclave : scan du réseau (OBS 4455 + OBS Conductor 8090), test du mot de passe |
| `src/tally/index.js` | tally : le moteur (propre à OBS Conductor), la liste des machines (`DRIVERS`), le scan réseau, `suggestInput` |
| `src/tally/guard.js` | tally : garde LECTURE SEULE (HTTP, TCP, UDP) : tout message est comparé à la liste fermée du driver avant l'envoi |
| `src/tally/drivers/*.js` | tally : un driver par famille (atem, roland, vmix, tricaster, eventmaster, livepremier, livecore, pixelhue, kairos) qui traduit le protocole en image commune ; détail et ajout d'une machine : `docs/TALLY-DEVICES.md` |
| `src/update.js` | versions master / slave, mise à jour d'un slave depuis son master |
| `src/tray.js`, `src/tray.ps1` | Windows : icône de barre des tâches + notifications (PowerShell WinForms, lancé par l'appli) ; macOS : lance `OBSConductorMenu` (voir ci-dessous) ; rien sur Linux |
| `installer/mac/menubar.m` | macOS : icône de la barre de menus (Objective-C, AppKit), compilée par `build_mac.command` en `Contents/MacOS/OBSConductorMenu` ; interroge `GET /api/tray` toutes les 1,5 s ; Quit = `POST /api/app/quit`. Non testée sur un vrai Mac au moment de l'écriture (2.1) |
| `src/media-duration.js` | durée d'une vidéo lue dans le fichier (.mov / .mp4) quand OBS n'en donne pas |
| `src/icons/` | icône (dessin Lucide « list-video », ISC) et variantes de la barre des tâches, `app.svg` source ; `scripts/make_icons.py` |
| `src/dialogs.js` | boîtes « Enregistrer sous / Ouvrir / Dossier » : Windows (PowerShell), macOS (osascript), Linux (zenity, sinon kdialog) |
| `src/paths.js` | emplacement des réglages par système (dev / installé, migration depuis OBSPlaylist / OBSScheduler sous Windows) |
| `src/obs-setup.js` | dossier de réglages d'OBS par système (+ Flatpak), OBS ouvert ou non ; ajoute / retire le dock dans OBS, active le serveur WebSocket d'OBS ; lit son port et son mot de passe (aussi utilisé à chaque connexion). Appelé par l'appli au premier lancement, `--add-dock`, et la désinstallation Windows |
| `src/fonts/` | Poppins Bold (logo, OFL) |
| `config/` | modèles : `settings.yaml`, `playlists/default.yaml` |
| `scripts/build_common.sh` | partagé par les 3 builds : téléchargement de Node.js (version fixée, `NODE_VERSION`, vérifié par SHA-256), tests, dossier de l'appli |
| `build_mac.command` (Mac) | `.app` universelle : lanceur C (`installer/mac/launcher.c`) + Node.js (lipo arm64 + x64) + sources dans `Resources/app`, `Info.plist` (LSUIElement), petit programme de barre de menus compilé avec clang (non bloquant s'il ne compile pas) ; signature de l'intérieur vers l'extérieur : `node`, puis `OBSConductorMenu`, puis `OBSConductor`, puis l'app (2.1.1), signature Developer ID + runtime durci (`node.entitlements`), notarisation de l'app puis du `.dmg` |
| `build_windows.command` (Mac) | node.exe Windows renommé `OBSConductor.exe` + sources, installeur NSIS (`installer/OBSConductor.nsi`, `brew install makensis`), lanceur sans fenêtre `OBSConductor.vbs` (démarrer, /stop, /adddock, /log) |
| `build_linux.sh` (Linux x86_64) | `.deb` (`/opt/obs-conductor`, commande `obs-conductor`, entrée de menu avec actions) et AppImage (appimagetool); si `src/icons/app-512.png` manque, le script le redessine depuis `app.svg` (2.0.1) |
| `scripts/push_github.command` | publication sur GitHub (voir « Publication ») |
| `version.json` | version publiée + adresse du dépôt (lu par `push_github.command`) |
| `docs/screenshots/` | captures du README (refaites depuis la simulation, Playwright) |
| `LICENSE`, `THIRD_PARTY_LICENSES.md` | GPL-3.0 ; Node.js, yaml, Poppins, Oswald, Lucide |
| `run_dev.bat` | lancer depuis les sources (Windows) ; ailleurs `npm start` |
| `scripts/make_icons.py` | régénère les icônes (`.ico`, `app.svg`, `app-512.png` Linux, `app-mac-1024.png` macOS) |
| `test/` | `npm test` (107 tests) |
| `INSTALL.txt` / `GUIDE.txt` | installation (français, court) / mode d'emploi complet du dock |

Format d'une playlist : voir l'en-tête de `src/player.js`
(`loop`, `end_action`, `end_scene`, `items[]` avec `scene`, `duration`,
`transition`, `video_ref`, `enabled`). Réglages généraux : `settings.yaml`
(`role`, `obs`, `dashboard`, `playback`, `default_transition`, `default_duration`,
`active_playlist`, `slave`).

## Décisions et raisons
- **Slave : un seul statut** (FOLLOWING MASTER vert, FREE RUN orange,
  DISCONNECTED rouge) et une rangée MASTER (switch) / AUTO SYNC / SYNC,
  demande de Noar (oct. 2026) pour une interface plus claire. Le switch MASTER
  coupé = free run (`slave.free_run`).
- **Dock navigateur + appli compagnon** plutôt qu'un plugin C++ : un seul code,
  pas de recompilation à chaque version d'OBS, la lecture ne dépend pas du dock.
- **Playlist séquentielle** à la place des heures de passage fixes de l'ancienne
  version.
- **Windows, macOS, Linux** (2.0, demande de Noar ; avant : Windows seul).
  Le Mac builde Mac et Windows, une machine Linux builde Linux, comme ses
  autres applis. Node.js est téléchargé par les scripts (rien à installer) et
  livré avec l'appli : même code partout, pas d'Electron.
- **Installeur Windows en NSIS** au lieu d'Inno Setup (2.0) : Inno Setup ne
  compile que sous Windows, NSIS tourne sur le Mac (Homebrew). L'installeur
  reprend une installation Inno 1.x (même dossier, ancienne entrée de
  désinstallation retirée), garde les options choisies (démarrage, pare-feu)
  pour les mises à jour, et relance l'appli en tant qu'utilisateur par
  l'explorateur Windows (l'installeur tourne en administrateur).
- **Le dock est ajouté par l'appli elle-même** (2.0, tous systèmes), au
  premier lancement, dès qu'OBS est fermé (`_hookObsOnce` dans main.js,
  drapeau `obs_hooked` dans settings.yaml) : sur macOS et Linux il n'y a pas
  d'installeur qui pourrait le faire, et l'appli tourne sous le bon compte.
  Fait une seule fois : un dock retiré à la main par l'utilisateur ne revient
  pas (sauf `--add-dock`, ou un changement du port du dock, qui remet le
  drapeau à zéro). Le dock pointe vers une copie de `dock-loader.html` dans le
  dossier de réglages de l'utilisateur : l'appli peut bouger (AppImage montée
  ailleurs à chaque lancement, app Mac déplacée), pas cette copie.
- **macOS** : `.app` sans fenêtre ni icône de Dock (LSUIElement, 2.1 ; avant LSBackgroundOnly) : son interface
  est le dock d'OBS, plus une icône de barre de menus (`OBSConductorMenu`). Programme principal = petit lanceur C (pas un script
  shell : signature et notarisation l'attendent), qui passe la main à Node.js.
  App universelle (Apple Silicon + Intel), macOS 11+ (minimum de Node 22).
  Identifiant `fr.justedit.obsconductor`.
- **Mises à jour depuis le master : Windows ↔ Windows seulement.** Le master
  dit son système (`platform`) ; un slave d'un autre système, ou sur
  macOS / Linux, affiche « install by hand » (Releases GitHub).
- **Publication GitHub** (2.0, choix de Noar) : dépôt public
  `noar-justedit/obs-conductor`, licence GPL-3.0-or-later (choix de Noar,
  comme TOP!), README en anglais avec captures.
- **Node.js** (ex Python), sans Electron : léger, aucune compilation.
- **Synchro des médias retirée** en 1.2.0 (demande de Noar : « plus tard »).
  Elle utilisait le moteur syncto copié dans `vendor/` ; voir la version 1.1.0
  pour la reprendre. Les scènes du slave doivent exister à l'identique.
- **Rôle choisi dans le dock** (boutons MASTER / SLAVE en haut, confirmation),
  demandé au premier lancement (`role: ""`).
- **Esclave : scan du réseau** plutôt qu'une adresse à taper : /24 de chaque
  carte réseau, ports 4455 (Hello d'obs-websocket) et 8090 (`/api/whoami`
  d'OBS Conductor, qui donne le port OBS réel). Le mot de passe du maître sert
  de clé : il est testé avant d'être enregistré.
- **Mot de passe WebSocket du maître affiché** dans Settings, mais seulement
  pour une requête venant du PC lui-même (le dock dans OBS) ; masqué depuis le
  réseau. Idem pour `/api/tray` et `/api/app/quit`.
- **État du WebSocket local** (`ok / off / closed / auth / unreachable`) déduit
  de la config d'OBS (`server_enabled`) et de la présence du processus d'OBS
  (`obs64.exe` sous Windows, `OBS` sous macOS, `obs` sous Linux, `pgrep`) ; dès
  que le serveur passe à « on », reconnexion immédiate.
- **Icône de barre des tâches en PowerShell** (WinForms NotifyIcon) : Node
  n'en sait pas faire ; pas de binaire natif ni de dépendance. Elle interroge
  l'appli toutes les 1,5 s et s'arrête quand l'appli s'arrête.
- **Durée par défaut des scènes** = réglage général ; une cue sans durée
  (`duration: null`) la suit en direct, comme la transition par défaut.
- **Durée vidéo lue dans le fichier** (atome `mvhd`) quand OBS n'en donne pas
  (ProRes .mov constaté par Noar, fichier non chargé).
- **Icône** : dessin Lucide « list-video » choisi par Noar (licence ISC, notice
  dans `src/icons/LUCIDE-LICENSE.txt`), sur carré noir, triangle rose. Barre des
  tâches : la même icône, seule la couleur du triangle change (demande de
  Noar : pas de forme ajoutée) ; vert = tout va bien, orange = à regarder
  (WebSocket coupé, souci de Sync, versions différentes), rouge = connexion
  perdue (OBS local ou master) ; rose d'origine tant que le rôle n'est pas
  choisi. Calculé par
  `trayInfo().level` dans main.js. Pas de dérivé du logo OBS (marque de l'OBS
  Project).
- **Pas de réglages Playback sur un slave** (demande de Noar) : la section est
  cachée ; master perdu, le slave prend ceux du master, lus dans son état
  (`state().playback`) et gardés : transition vers la scène de secours,
  « Restart videos » et défauts quand il continue seul. Master antérieur à
  1.3.0 : les valeurs propres du slave (cachées) servent encore.
- **Config générale OBS copiée par la Sync** (étape 4 ; choix fait en
  l'absence de Noar, à valider) : canvas, sortie, FPS (`SetVideoSettings`),
  et les valeurs de profil de `PARAMS` (filtre de réduction, format / espace /
  plage de couleur, niveaux HDR, fréquence et canaux audio) par
  `SetProfileParameter`. Pas de copie du profil OBS en fichier (OBS fermé,
  plus lourd). Jamais copiés : sorties (service et clé de stream,
  enregistrement : format, dossier, encodeurs, qui dépendent du matériel et
  des dossiers de chaque PC), périphériques, raccourcis. Vidéo refusée par
  OBS quand une sortie est active : on vérifie avant (`GetOutputList`) pour ne
  rien appliquer à moitié. L'audio ne s'applique qu'au prochain démarrage
  d'OBS. L'empreinte de l'Auto sync inclut ces réglages. `SetVideoSettings`
  enregistre toujours le FPS en fraction : après le reset, on remet la façon
  du master (`FPSType`, `FPSCommon`, `FPSInt`, `FPSNum`, `FPSDen`), constaté
  par Noar en 1.4.0.
- **Sécurité (review complète après 1.5.4, choix de Noar : « ce PC
  seulement »)** : `hostAllowed` refuse un nom d'hôte qui n'est pas celui du
  PC (DNS rebinding) ; `changeAllowed` réserve POST / DELETE à ce PC, sans
  page étrangère (Origin) et en JSON ; le mot de passe OBS n'est rendu qu'au
  dock local appelé en localhost. Signatures slave -> master v2 : méthode +
  chemin + requête, 2 min (l'ancienne forme 1.5.x n'est acceptée que pour la
  mise à jour, pour qu'un vieux slave puisse se mettre à jour). La mise à jour
  est « scellée » par le master (HMAC du mot de passe sur version, taille,
  empreinte) : un faux master ou un intermédiaire ne peut pas proposer son
  installeur. La copie des médias refuse `..`, les programmes / scripts et
  les dossiers système (`unsafeTarget`). Restent : installeur non signé
  (pas de certificat), HTTP en clair sur le réseau du show.
- **Tally en lecture seule, règle absolue de Noar** : jamais de commande
  vers un switcher. En 2.2, Noar a choisi d'autoriser aussi ce qui est
  nécessaire pour lire sans rien changer (ouverture de session ATEM, mot de
  passe Roland / Analog Way / KAIROS / TriCaster, abonnement). Chaque driver
  a sa liste fermée (`RULES`) et des exemples interdits (`FORBIDDEN`) ;
  `src/tally/guard.js` refuse tout le reste avant l'envoi ;
  `test/tally-drivers.test.js` vérifie, contre une fausse machine par
  driver, que tout ce qui part est dans la liste. Voir AGENTS.md.
- **Tally multi-machines (2.2, demande de Noar)** : moteur propre à OBS
  Conductor + un driver de « traduction » par famille, protocoles repris des
  modules Bitfocus Companion (MIT) et des docs constructeurs, sans copier
  leur code (un module Companion peut envoyer des commandes à son
  initialisation : impossible à garantir en lecture seule). Machines :
  ATEM (UDP 9910), Roland V-160HD (TCP 8023), vMix (TCP 8099), TriCaster
  (HTTP 80), Barco E2 / S3 / EX / Encore 3 (JSON-RPC 9999), Analog Way
  Aquilon (REST 80) et Ascender (LiveCore TCP 10600), PixelHue Q8 / P10 /
  P20 / P80, Panasonic KAIROS (REST 1234). Exclus : Roland V-60HD / XS-62S
  (une seule connexion, choix de Noar), V-1200HD (pas de lecture connue),
  ancien Barco Encore (pas de lecture du tally). Autodétection par bouton
  « Scan » seulement (choix de Noar), à défaut liste des modèles + adresse.
  2.2.1 (choix de Noar, après « je veux la garantie qu'il ne déclenchera
  JAMAIS une commutation ») : le Scan n'envoie à une machine inconnue
  qu'une connexion et au plus UN GET (listes `<id>-scan`) ; ATEM (le hello
  ouvre une session) et Barco (POST) ne sont plus scannés. Proposés et non
  retenus pour l'instant : vérification d'identité avant toute lecture,
  listes figées par un test, suppression du Scan.
  STOP TALLY (2.2.1, demande de Noar, d'abord appelé PANIC, « tant que le système de Tally n'est pas
  approuvé ») : le tally démarre COUPÉ (`guard.js`, `cut = true` au
  chargement) ; bouton STOP TALLY rouge en haut du dock et interrupteur dans
  Settings > Tally (`POST /api/tally/panic`, permis même verrouillé pour
  couper) ; coupé, plus aucune connexion ni aucun octet vers un switcher,
  les connexions ouvertes sont fermées. OBS et master / slave continuent
  (choix de Noar : « tout le tally », pas tout le réseau).
  Réglages : `tally.device` (id du driver), `host`, `port`, `user`,
  `password` (jamais renvoyé au dock : `has_password`), `input` (id),
  `input_name`. Un réglage 2.1 sans `device` = PixelHue.
- **Tally : lecture par les layers** (correctif après la 1.5.0, rien n'était
  jamais ON AIR chez Noar) : la doc fournie passait par les presets
  (`currentRegion`), mais les layers n'ont pas d'id de preset. Logique reprise
  du code du module Companion : layer `layerIdObj.sceneType` 2 = PGM, 4 = PVW,
  sur l'écran `attachScreenId` ; on ignore le multiviewer (type 8), un écran
  désactivé ou en FTB, ni un layer éteint (`enable` 0). `/api/tally/debug`
  (local) donne les réponses brutes. Vérifié sur une vraie réponse du Q8 de
  Noar (extrait anonymisé dans `test/fixtures/q8-hall8.json`) : la logique
  est juste, l'erreur venait du choix de l'input (« HALL 8 », retour de
  l'écran vu au seul multiviewer, au lieu de « OBS HALL 8 ») ; la liste
  indique maintenant où est chaque input pour éviter cette confusion.
- **Tally PixelHue** (demande de Noar) : chaque PC interroge lui-même le
  switcher (adresse + nom de l'input dans Settings > Tally, réglage propre à
  chaque PC, pas copié du master ; l'input se choisit dans la liste lue sur
  le switcher, `/interface/list-detail`, demande de Noar ; présélection
  automatique de l'input dont le nom contient celui du PC, si un seul
  correspond, `suggestInput`) toutes les secondes en REST, sans le
  WebSocket (trames binaires, plus fragile). Barre en haut du dock : rouge ON
  AIR, vert PVW, rien sinon. Après la 1.5.2 (demande de Noar) : badge dans la
  carte on-air au lieu de la barre, et cadre rouge « respirant » autour du
  panel quand ON AIR (pas de cadre en PVW) ; badge en style « boîte lumineuse
  de studio » (police Oswald, SIL OFL, `src/fonts/Oswald-OFL.txt`), ON AIR
  pulse au rythme du cadre. Ajout de ma part : badge orange
  « NO TALLY » quand le switcher ne répond plus, pour ne pas croire être hors
  antenne à tort. `tally.api_port` (settings.yaml, caché) saute la
  découverte sur le port 19998 si besoin.
- **Sync au choix** (demande de Noar) : fenêtre à interrupteurs Scenes /
  Media / OBS settings / All, dernier choix gardé dans le navigateur du dock
  (localStorage). L'empreinte de l'Auto sync n'est gardée qu'après une Sync
  complète, sinon l'Auto sync ne verrait plus les changements non copiés.
- **Mise à jour des slaves par le master** (choix de Noar : bouton Update) :
  l'installeur garde une copie de lui-même dans `<app>\update\` ; le master
  la sert (`/api/update/info` libre, `/api/update/installer` signé) ; le slave
  lit la version du master toutes les 30 s, affiche l'écart, et « Update to
  vX » télécharge, vérifie l'empreinte SHA-256, puis lance l'installeur
  (PowerShell `Start-Process`, `/VERYSILENT /SUPPRESSMSGBOXES /UPDATE=1`).
  Pas de `-Verb RunAs` : l'installeur demande lui-même l'accord
  administrateur, ce qui garde le vrai utilisateur (l'appli relancée tourne
  sous son compte, pas en admin). Accord refusé : le dock le dit au bout de
  2 min (l'appli tourne encore). Avec `/UPDATE=1`, l'installeur ne demande pas
  de fermer OBS, ne touche pas au dock et relance l'appli. Pourquoi pas une
  mise à jour 100 % automatique : Program Files exige l'accord administrateur
  de Windows (UAC), et un remplacement en plein direct doit rester un choix.
  Le dock se recharge quand la version de l'appli change.
  Générée par `scripts/make_icons.py` (`pip install cairosvg pillow`).
- **Synchro des scènes** (bouton sur le slave, choix de Noar) : le fichier de
  collection du master (seul moyen d'avoir tout : filtres, plugins…) est chargé
  dans l'OBS du slave sous « <nom> (from master) », sans redémarrer OBS :
  CreateSceneCollection puis bascule aller-retour (OBS relit le fichier à
  chaque activation, vérifié dans ses sources). Médias supposés au même
  chemin ; manquants et plugins absents listés. Empreinte gardée : « Up to
  date » si rien n'a changé.
- **Requêtes privées slave → master signées** (HMAC du mot de passe WebSocket
  du master, 5 min, par chemin) : collection maintenant, médias ensuite. Rien
  de plus à configurer côté slave.
- **Dock de secours** : le dock ouvre une page locale (`dock-loader.html`)
  qui bascule sur l'appli dès qu'elle répond. Une page web ne peut pas lancer
  l'appli : démarrage par le menu Démarrer / Applications / le menu des
  applications, ou à l'ouverture de session (texte adapté au système).
- **Quitter** : dock (Settings), icône (clic droit, confirmation), menu Démarrer.
- **Textes courts** partout (demande de Noar : descriptions simples).
- **Vidéo de référence** d'une cue : la plus longue, visible, qui ne boucle
  pas (`looping` / `loop` dans les réglages de la source). Une vidéo en boucle
  n'a pas de fin : une boucle de fond de 60 s dans chaque scène donnait 60 s
  à chaque cue (retour de Noar).
- **Cue à l'antenne verrouillée** dans le dock et refusée par le serveur (409)
  si elle change ; déplacer les autres cues reste possible.
- **Mode verrouillé** (`locked` dans settings.yaml) : le serveur refuse tout
  POST / DELETE sauf le déverrouillage et le Quit de l'icône (423). Valable
  pour tous les docks et navigateurs.
- **Save / Save to...** : le fichier de chaque playlist est retenu
  (`playlist_files` dans settings.yaml), aussi au chargement d'un fichier.
- **Synchro des médias d'appli à appli** (demande de Noar : pas de partage
  Windows, slave très simple) : HTTP sur le port 8090 déjà ouvert, requêtes
  signées, seuls les médias de la collection ouverte sont servis. Empreinte
  SHA-256 calculée par le master pendant l'envoi (pas de double lecture) et
  gardée en cache ; le slave la recalcule sur sa copie. Fichier remplacé ou
  plus utilisé : archive datée « <dossier> (archive) » (choix de Noar). Lecteur
  absent sur le slave : il choisit un dossier (choix de Noar), les chemins de
  la collection sont convertis. Un fichier ouvert par OBS ne peut pas être
  remplacé sous Windows : remis à la Sync suivante.
- **Master perdu** (son OBS ou son appli, 3 s) : notification, le slave cesse
  de suivre, puis selon `fallback_mode` (réglage, demande de Noar) : scène de
  secours (`fallback_scene`), ou « continuer » : un 2e lecteur rejoue la
  playlist du master depuis son dernier état connu (cue et temps restant,
  vieilli de l'âge de cet état), sur l'horloge du slave. Retour 2 s : ce
  lecteur s'arrête, le slave suit de nouveau et rattrape la scène du master.
  Limite : ce que le master a changé pendant la coupure n'est pas connu.
- **Auto sync** (case à cocher sur le slave, demande de Noar) : toutes les 5 s
  le slave demande au master une empreinte (collection sans les clés que
  OBS réécrit à chaque changement de scène + liste des médias) ; différente
  de celle de la dernière Sync complète → Sync. Une Sync incomplète (fichier
  ouvert, erreur) est retentée 30 s plus tard au plus tôt.
- **Reconnexion** : Node 22 n'envoie pas de « close » après une connexion
  refusée : l'« error » vaut fermeture (bug corrigé : l'appli ne se
  reconnectait jamais à un OBS lancé après elle). OBS « not ready » (207) :
  réessayé 3 s.
- **Barres de progression** dessinées à chaque image (transform), sur une
  horloge locale corrigée seulement au-delà de 0,15 s d'écart.
- **Charte just edit lab** (syncto / ingesto) ; couleur de l'app rose `#ff5ca8`
  (logo uniquement), validée par Noar.
- **Transition par défaut = réglage général** (Settings), pas par playlist.
- **Free run (slave)** : `slave.free_run` (booléen, remis à faux par tout
  `setRole`). `slaveConfig().enabled` = rôle slave ET pas free run : le
  follower se déconnecte, `_watchLink` remet le lien à zéro. Le dock garde la
  disposition slave (le rôle ne change pas) ; l'état est envoyé en free run
  (`master_link.free_run`). Ce que fait le PC pendant free run : rien du
  master, son OBS garde sa scène ; `_step` le traite comme un non-slave, donc
  son lecteur local existe, mais rien ne le lance tout seul. À confirmer avec
  Noar : doit-il jouer sa propre playlist en free run ?
- **Medias location (slave)** : `slave.media_mode` = `same` | `custom`. En
  `same`, les dossiers choisis restent enregistrés mais ne servent pas
  (`store.mediaMappings()` renvoie []), pour pouvoir revenir à `custom` sans
  tout refaire. Pas de mode écrit (réglages ≤ 1.6.3) : `custom` si un dossier
  avait été choisi. Choisir un dossier (Settings ou la Sync) passe en `custom`.
- **Tally > Test connection** (`/api/tally/test`, ce PC seulement) : nouvelle
  connexion puis lecture des entrées et des écrans, toujours via la liste
  liste fermée du driver (`src/tally/guard.js`).
- **Temps restant de la Sync** = octets restants / vitesse moyenne depuis le
  début de la copie (calculé par `media-sync.js`, `eta_s`). Seuls les octets
  réellement reçus comptent dans la vitesse (une reprise de copie coupée
  arrive d'un coup) ; le temps de vérification est dedans. Affiché après 3 s.
  Moyenne et non vitesse instantanée : plus stable, mais réagit lentement si
  le débit change beaucoup en cours de route.
- **Pas de bouton Next** (retiré à la demande de Noar).
- **Mot de passe OBS jamais renvoyé** au dock (le dock peut être joignable du
  réseau).
- **Ajout du dock dans OBS** : écrit directement dans la config d'OBS
  (`[BasicWindow] ExtraBrowserDocks` de `user.ini`, ou `global.ini` avant
  OBS 31) avec activation du serveur WebSocket
  (`plugin_config/obs-websocket/config.json`). OBS doit être fermé : il
  réécrit ces fichiers en quittant. Fait par l'appli depuis la 2.0 (voir plus
  haut), par l'installeur Inno avant.
- **Mot de passe WebSocket relu dans OBS** à chaque connexion quand OBS est
  sur le même PC : plus de copie à la main, suit un changement dans OBS.
- **Appli sans fenêtre** (lanceur VBScript `wscript`) + fichier journal :
  Node n'a pas d'icône de barre des tâches sans code natif.
- **Démarrage avec Windows par la clé Run** de l'utilisateur plutôt qu'une
  tâche planifiée (visible et désactivable dans le Gestionnaire des tâches).
- **Pare-feu** : réseaux privés et domaine seulement (l'appli n'a pas de mot
  de passe).
- **Nom OBS Conductor** (logo `obs.conductor`, choisi par Noar ; ex OBS
  Playlist, ex OBS Scheduler) : même AppId d'installeur pour mettre à jour les
  anciennes versions ; réglages copiés depuis `%LOCALAPPDATA%\OBSPlaylist` ou
  `OBSScheduler` ; le dock « OBS Playlist » est renommé dans OBS ; le scan
  reconnaît encore les masters 1.2.x. (« OBS » dans le nom : voir
  Problèmes connus, depuis que le projet est public.)
  Les fichiers de playlist gardent l'extension `.obsplaylist`.

## État
- Testé sous simulation (Linux + Chromium) : dock maître et esclave, choix du
  rôle, confirmation, bandeau WebSocket désactivé puis activé, recherche du
  maître (résultats simulés), mauvais mot de passe, Settings (durée par défaut,
  infos pour les esclaves), glisser-déposer, menus, ACTIVE / SKIPPED, loop.
- Synchro des scènes : testée entre deux applis simulées (mauvais mot de passe
  refusé, création + chargement de la collection, « Up to date »).
- Mise à jour par le master : testée entre deux applis simulées (master 1.3.0,
  slave 1.2.0 : écart affiché, téléchargement, vérification) et par tests
  automatiques (mauvais mot de passe, fichier abîmé, master sans copie).
  Le lancement réel de l'installeur reste à tester sur Windows.
- Scan réseau et test du mot de passe : testés contre un faux serveur
  obs-websocket (`test/helpers/fake-obs-ws.js`).
- Installeur : `setup.iss` compilé avec Inno Setup 6.4.1 (sous Wine) ; build et
  appli installée testés sous Wine (dock ajouté / retiré, WebSocket, journal).
- 2.0 : build Linux lancé ici (Debian, Node.js local à la place du
  téléchargement, nodejs.org bloqué dans le bac à sable) : `.deb` installé,
  appli lancée, dock ajouté dans un faux dossier OBS, `--stop` ; AppImage
  lancée en simulation. Installeur NSIS compilé avec makensis 3.09 (avec un
  faux node.exe) : syntaxe validée, pas lancé. `push_github.command` testé
  contre un dépôt git local et une fausse API GitHub (envoi sans Release,
  version.json gardé, Release publiée puis version.json seul, version
  identique refusée, version.json / package.json différents refusés, fichier
  supprimé retiré, annulation, droits d'exécution gardés). Lanceur Mac
  compilé et testé sous Linux (gcc, branche non Apple).
- **Non vérifié (2.0)** : tout le build Mac (lipo, signature, notarisation,
  iconutil), l'app Mac elle-même, les dialogues osascript et zenity,
  l'installeur NSIS sur un vrai Windows (reprise d'une installation 1.x,
  relance par l'explorateur, mise à jour silencieuse depuis un master),
  OBS réel sur macOS et Linux.
- **Non vérifié** : tout ce qui touche Windows réel (installeur, icône de barre
  des tâches PowerShell et ses notifications, lanceur VBS, winget, pare-feu,
  scan sur un vrai réseau, mise à jour d'un slave par son master) ; OBS réel (dock visible après installation, durées
  vidéo dont ProRes, transitions) ; maître / esclave sur deux PC.

## Problèmes connus / limites
- **Le nom « OBS Conductor » sur un dépôt public** : l'OBS Project demande
  de ne pas utiliser « OBS » pour nommer un outil tiers (règle de son forum :
  « Do not use the letters "OBS" to identify the resource », « for OBS »
  toléré au cas par cas), et a déjà fait retirer « OBS » du nom de Streamlabs
  OBS (2021). Risque : demande de renommage. Décision de Noar à prendre.
- macOS : icône dans la barre de menus (2.1, demande de Noar, « mac
  uniquement ») mais pas de notifications ; Linux : ni icône ni
  notifications ; Windows a les deux. Le
  lancement à l'ouverture de session se règle à la main (Ouverture / Login
  Items, applications au démarrage) ; pas de mise à jour depuis le master.
- Linux : dialogues Enregistrer / Ouvrir / Dossier seulement avec zenity ou
  kdialog et un affichage (sinon le dock fait taper le chemin). x86_64
  seulement. Désinstaller le .deb laisse le dock dans OBS (page « not
  running ») : il n'y a pas d'accès propre aux dossiers des utilisateurs.
- Master et slaves de systèmes différents : la collection copiée par la Sync
  garde les sources propres au système du master (capture de fenêtre,
  périphériques audio, texte GDI+...) : signalées « unknown » sur le slave.
  Chemins des médias : la racine (`/Volumes/<disque>`, `/Users/<nom>`,
  `/home/<nom>`, `/media/<user>/<disque>`, lettre de lecteur) absente sur le
  slave lui fait choisir un dossier.
- Windows (2.0) : la relance de l'appli après installation passe par
  l'explorateur, qui ouvre `OBSConductor.vbs` avec le programme associé aux
  .vbs (wscript par défaut ; si un administrateur l'a changé, lancer l'appli
  par le menu Démarrer). La clé « démarrage avec Windows » est écrite pour le
  compte qui accepte l'élévation (le même dans le cas courant).
- Sync des positions / tailles : OBS n'écrit pas son fichier de collection
  quand on déplace ou redimensionne une source (vérifié dans les sources
  d'OBS : `OBSBasicPreview::mouseReleaseEvent` n'appelle pas `SaveProject`).
  Le master lit donc les transformations en direct (`GetSceneItemList`) et
  les pose sur le fichier (`collection.withLiveTransforms`), en retirant les
  copies relatives `pos_rel` / `scale_rel` / `bounds_rel` qu'OBS 30.1+
  lirait en priorité. Les autres réglages non encore enregistrés par OBS
  (visibilité, propriétés d'une source) restent ceux du fichier. Chaque
  déplacement déclenche un Auto sync, donc un rechargement des scènes du
  slave (écran noir bref).
- Passage à 1.6.0 : la signature slave -> master change. Mettre le master à
  jour en premier ; un slave en 1.5.x ne peut plus faire de Sync avec lui
  mais peut toujours se mettre à jour depuis lui (bouton Update, ancienne
  signature acceptée pour la mise à jour seulement). Un slave 1.6.0 face à
  un master 1.5.x ne peut pas faire de Sync.
- Restent de la review : installeur non signé, HTTP en clair sur le réseau
  du show. Pare-feu : règles limitées au sous-réseau local
  (`remoteip=localsubnet`) ; un master et ses slaves sur deux sous-réseaux
  routés ne se verraient plus (régler la règle à la main).
- Tally : protocole PixelHue non officiel (rétro-ingénierie, `docs/`).
  Layers « orphelins » (hors preset) ignorés.
- Tally 2.2 : les 8 nouveaux drivers sont testés contre de fausses machines
  construites d'après les documents, **jamais sur du vrai matériel**. Points
  à vérifier listés par machine dans `docs/TALLY-DEVICES.md` (keys / DSK
  comptés ou non, bits de tally KAIROS, statuts de layers Aquilon, numéros
  de sources LiveCore). Le hello UDP ATEM du scan 2.2.0 n'est plus envoyé
  (2.2.1) ; le Scan ouvre une connexion sur les ports
  connus ; sur un Roland V-60HD, elle occupe un instant sa seule place.
- Garantie (dit à Noar) : le code ne peut émettre que les messages des
  listes fermées ; ce qui ne peut pas être garanti par le logiciel : la
  réaction d'un firmware à une lecture, et une mauvaise adresse saisie
  (les lectures d'un modèle envoyées à une autre machine).
- Dialogues Windows (Save / Load / dossier) et question Quit de l'icône :
  PowerShell est lancé caché, et Windows cache la première fenêtre du
  processus ; une fenêtre invisible la prend (`dialogs.js`, `tray.ps1`).
  Corrigé en 1.4.1 après le retour de Noar, non vérifié ici (pas de Windows).
- Réglages OBS copiés par la Sync : l'audio (fréquence, canaux) ne s'applique
  qu'au prochain démarrage d'OBS ; la vidéo attend la Sync suivante si une
  sortie est active sur le slave. Les encodeurs et réglages d'enregistrement
  ne sont pas copiés (choix).
- Durée vidéo inconnue si OBS n'a pas chargé le fichier (« Close file when
  inactive », source VLC jamais lue) : saisir la durée à la main.
- Une *Transition Override* posée sur une scène dans OBS passe avant celle de la
  playlist ; la lecture change la transition courante d'OBS.
- Alignement maître / esclave : quelques ms en filaire, pas de genlock.
- Mise à jour par le master : un slave en 1.2.x (sans le bouton) et un master
  installé avant la 1.3.0 (sans copie de l'installeur) se mettent à jour une
  fois à la main. Windows demande l'accord administrateur sur le slave à chaque
  mise à jour. Pendant l'installation (quelques secondes), le slave ne change
  plus de scène. Non testé sur Windows réel (le silencieux ne tourne pas sous
  Wine).
- Scan limité au sous-réseau du PC (a.b.c.1-254) : sinon, adresse à la main.
- Icône de barre des tâches absente si PowerShell est bloqué ; les
  notifications peuvent afficher « Windows PowerShell » comme expéditeur.
- Durée vidéo lue dans le fichier : .mov / .mp4 seulement.
- Réseau en lecture seule (choix de Noar après la review de sécurité 1.5.4) :
  toute modification (POST / DELETE) ne vient que de ce PC, de son dock (pas
  d'Origin étrangère, JSON seulement) ; le réseau peut seulement lire (les
  slaves). Un dock ouvert dans un navigateur sur un autre PC ne peut plus rien
  changer. Le pare-feu reste ouvert pour l'appli (les slaves lisent le
  master).
- Installeur non signé (SmartScreen au premier lancement).
- Le Gestionnaire des tâches affiche OBSConductor.exe comme « Node.js
  JavaScript Runtime » (c'est node.exe renommé) ; pas d'icône propre.
- Le dock n'est ajouté que pour le compte Windows qui installe. Autre compte :
  menu Démarrer > Add the dock to OBS depuis ce compte.
- Port 4455 ouvert dans le pare-feu : si le port WebSocket d'OBS est changé
  sur le maître, la règle ne suit pas.
- Mise à jour depuis OBS Scheduler : le dossier d'installation et le groupe du
  menu Démarrer gardent l'ancien nom.

## Prochaines étapes
Programme de Noar (oct. 2026), dans l'ordre :
1. Test de la 1.2.0 sur Windows : validé par Noar. Reste à tester la 1.7.0
   sur Windows et deux PC (copie des médias, mise à jour d'un slave par son
   master, icône de la barre des tâches, installeur).
2. Synchro des scènes master → slave : faite, validée par Noar.
3. Synchro des médias sans partage Windows : faite (testée entre deux applis
   simulées et par tests automatiques), à tester sur deux PC.
4. Config générale de l'OBS master sur le slave : faite (étape de Sync, par
   WebSocket, `src/obs-settings.js`), testée en simulation et par tests ; à
   tester sur deux PC.
5. Code couleur, nettoyage (CSS mort retiré), recherche de bugs : relecture
   par deux sous-agents Claude (backend ; dock + installeur) : 22 bugs
   confirmés, tous corrigés (liste dans CHANGELOG). Ce n'est pas une autre
   IA au sens strict : une relecture par un autre outil reste utile.
   Design : reste à revoir avec Noar (rien changé sans sa demande).
6. Tally multi-machines : fait en 2.2 (10 familles demandées, V-60HD
   exclu). À tester sur chaque vraie machine (Test connection +
   `/api/tally/debug`), et corriger les points « à vérifier » de
   `docs/TALLY-DEVICES.md`. Possibles ensuite : Midra 4K / Alta 4K (AWJ),
   choix des sorties qui comptent comme antenne (ex. exclure un aux
   d'enregistrement).
7. Proposés, en attente d'un « oui » : retirer le bouton film (doublon de
   Auto-detect), même menu de durée pour la durée par défaut des Settings,
   sélecteur à deux boutons pour Medias location, retirer la police Oswald
   (plus utilisée), « MEDIA » au lieu de « MEDIAS ».
8. 2.0 : tester les builds sur le Mac (signature, notarisation, `.dmg`) et
   sous Pop!_OS, puis l'appli sur les trois systèmes avec un vrai OBS.
9. Décider du nom (voir Problèmes connus) avant d'annoncer le dépôt.

## Publication d'une version
1. Builds : `build_mac.command` et `build_windows.command` sur le Mac,
   `build_linux.sh` sur le PC Linux. Résultats dans `dist/`.
2. Décompresser `obsConductor_vX.Y.Z.zip`, double-cliquer
   `scripts/push_github.command` : le code part, `version.json` reste.
3. Créer la Release `vX.Y.Z` sur GitHub, y joindre le `.dmg`, le `.exe`, le
   `.deb` et l'`.AppImage` (texte de la Release fourni à part).
4. Relancer le script : `version.json` part.
Premier envoi : créer le dépôt vide sur github.com ; git demande le nom
GitHub et un jeton (github.com/settings/tokens), gardé ensuite par le
trousseau macOS.

## Emplacements de la version
À mettre à jour ensemble à chaque bump (puis vérifier) :
1. `package.json` — `"version"`
2. `package-lock.json` — `"version"` (2 fois : racine et `packages[""]`) —
   régénéré par `npm install --package-lock-only`
3. `version.json` — `"version"`
4. `CHANGELOG.md` — nouvelle entrée
5. `ETAT_PROJET.md` — version en tête de fichier

Lus dans `package.json` au moment du build, rien à changer à la main :
l'installeur Windows (`makensis -DVERSION`), l'`Info.plist` macOS, le
`control` du .deb, les noms des fichiers de `dist/`. Le dock affiche la
version de `package.json` (Settings > OBS Conductor server).

Vérification après un bump :
`grep -rn "<ancienne version>" --exclude-dir=node_modules --exclude-dir=build --exclude-dir=dist --exclude=CHANGELOG.md .`
ne doit renvoyer que l'historique d'ETAT_PROJET.md.
