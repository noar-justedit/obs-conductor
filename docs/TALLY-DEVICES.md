# Tally : machines supportées et ajout d'une machine

Utilisé par `src/tally/`. À lire avant de toucher au tally.

## Règle absolue (Noar)

OBS Conductor **n'envoie JAMAIS de commande** à un switcher : jamais de cut,
de take, de changement de source, de rappel de preset, de réglage. Il **lit**.

Autorisé (choix de Noar, 2.2) : les lectures, et ce que certaines machines
exigent avant de laisser lire, sans rien changer à l'image ni aux réglages :
ouverture de session (ATEM), identification par mot de passe (Roland, Analog
Way, KAIROS, TriCaster), abonnement aux changements.

Comment c'est garanti : un driver ne touche jamais une connexion lui-même.
Tout message passe par `src/tally/guard.js`, qui le compare à la **liste
fermée** des messages de lecture du driver (`RULES`) et refuse tout le reste
avant qu'il quitte le PC. Chaque driver donne aussi des exemples de messages
interdits (`FORBIDDEN`) : le test `test/tally-drivers.test.js` vérifie qu'ils
sont refusés, et que tout ce qu'une fausse machine reçoit est dans la liste.

## STOP TALLY : couper tout le tally (Noar, 2.2.1)

Tant que le tally n'est pas approuvé par Noar :
- **Le tally démarre COUPÉ** à chaque lancement de l'appli.
- Bouton rouge **STOP TALLY** en haut du dock (visible quand le tally est en
  marche) : un clic coupe tout. Settings > Tally : « Turn the tally on » /
  « Stop tally ». STOP TALLY marche aussi en mode verrouillé.
- Coupé, `guard.js` n'ouvre plus aucune connexion et n'envoie plus un octet
  (HTTP, TCP, UDP, Scan) ; les connexions ouvertes sont fermées sur-le-champ.
  Le WebSocket d'OBS et les liens master / slave ne passent pas par là :
  ils continuent. Test : `STOP TALLY: the tally starts stopped...` dans
  `test/tally-drivers.test.js` (aucune connexion, aucun paquet reçu par les
  fausses machines une fois coupé).

## Architecture : protocole machine → driver (traduction) → moteur

```
machine  --(son protocole)-->  drivers/xxx.js  --(image commune)-->  index.js (moteur)  -->  dock
```

- `src/tally/index.js` : le **moteur**, propre à OBS Conductor. Il ne connaît
  aucune machine. Il interroge le driver choisi, garde l'état de l'input
  choisi, gère la reconnexion, le test, le scan réseau.
- `src/tally/drivers/*.js` : un **driver** par famille de machines. Il traduit
  le protocole de la machine en une **image commune** :

```js
{
  model:  'ATEM Mini Pro',                       // affiché dans Settings
  inputs: [{ id: '3', name: 'Cam 3' }, ...],      // la liste où l'on choisit l'input de cet OBS
  tally:  { '3': { pgm: ['PGM'], pvw: [] } },     // où chaque input est à l'antenne / en preview
  screens: 2,                                     // facultatif (Test connection)
}
```

- `src/tally/guard.js` : le **garde lecture seule** (HTTP, TCP, UDP).

## Ajouter une machine

1. Lire le protocole (module Bitfocus Companion de la machine, sous licence
   MIT, et la doc du constructeur). Repérer **uniquement** les messages de
   lecture nécessaires au tally, et ceux qui agissent (à interdire).
2. Créer `src/tally/drivers/<id>.js` qui exporte :
   - `id`, `label` (liste du dock), `vendor`, `port` (port habituel),
     `portHint`, `auth` (`null`, `'password'` ou `'userpass'`), `authHint`,
     `defaultUser`, `pollMs`, `source` (module Companion d'origine) ;
   - `RULES` : la liste fermée des messages autorisés (`guard.rule(desc, RegExp)`),
     le message entier, fin de ligne comprise ;
   - `FORBIDDEN` : des exemples de commandes de cette machine, qui doivent
     être refusées ;
   - `create(cfg, log)` → un objet `{ read(): Promise<image commune>, close(), debug?() }`.
     `cfg` = `{ host, port, user, password }` ;
   - pour le scan (facultatif) : `scanPorts` (ports TCP à tester) et
     `probe(host)` → `{ model, needsAuth }` ou `null`, en lecture seule.
3. N'envoyer qu'à travers `guard.httpClient(id, RULES)`, `new guard.GuardedSocket(id, RULES, …)`
   ou `guard.udpSend(…)`.
4. L'ajouter à `DRIVERS` dans `src/tally/index.js`.
5. Écrire son test dans `test/tally-drivers.test.js` : une fausse machine qui
   répond comme la vraie et note tout ce qu'elle reçoit ; vérifier l'image
   commune et `assertAllRead(...)`.
6. Mettre à jour ce fichier, `README.md`, `GUIDE.txt`, `THIRD_PARTY_LICENSES.md`.

## Le Scan (choix de Noar, 2.2.1)

Sur bouton seulement. À une machine pas encore connue, le Scan n'envoie
qu'une connexion TCP et, selon le modèle, **une seule requête GET** de
lecture, rien d'autre (listes `<id>-scan`, testées) :

| Modèle | Ce que le Scan envoie |
|---|---|
| vMix, Roland, Ascender | rien : ils se présentent d'eux-mêmes à la connexion |
| TriCaster | `GET /v1/version` |
| Aquilon | `GET /api/tpp/v1/system` |
| PixelHue | `GET /unico/v1/ucenter/device-list?clientType=8` (HTTPS 19998) |
| KAIROS | `GET /inputs` (port 1234) |
| ATEM, Barco | non scannés : à choisir dans la liste |

## Les machines

Toutes testées contre de fausses machines construites d'après les
documentations ; **aucune n'a encore été testée sur du vrai matériel**
(sauf le PixelHue Q8, déjà utilisé avant la 2.2). Les points marqués
« à vérifier » sont des déductions des documents.

### Blackmagic ATEM (`atem`)
- UDP 9910. Envoyé : le « hello » de 20 octets (toujours le même) qui ouvre
  la session, puis des accusés de réception de 12 octets sans contenu.
  **Rien d'autre ne peut être construit** : `isAllowedPacket` refuse tout paquet
  avec un contenu (les commandes ATEM en ont toutes un).
- Lu : `_pin` (modèle), `InPr` (inputs : id, nom ; seuls les inputs externes
  sont listés), `TlSr` (tally par source, calculé par l'ATEM : bit 0 PGM,
  bit 1 PVW), `InCm` (fin de l'état initial).
- Scan : **non scanné** (un hello ouvrirait une session sur tout appareil qui
  écoute ce port) : à choisir dans la liste.
- À vérifier : que `TlSr` compte les keys / DSK / SuperSource (très probable,
  il suit le multiviewer) ; sur les modèles multi-M/E, quel M/E il suit (ME1).
- Chaque session occupe une place de client sur l'ATEM pendant quelques
  secondes (le scan aussi).
- Source : `companion-module-bmd-atem` (bibliothèque atem-connection), pyatem.

### Roland V-160HD (`roland`)
- TCP 8023, mot de passe réseau à 4 chiffres (MENU > LAN CONTROL).
- Envoyé : le mot de passe (après « Enter password: »), `VER;`,
  `RQH:0C0000,000010;` (lecture de la zone tally, en lecture seule sur la
  machine). Jamais `DTH:` (écriture). Companion active « tally auto send »
  (une écriture) : pas ici, le tally est relu toutes les 0,4 s.
- Lu : un octet par source (HDMI 1-8, SDI 1-8) : bit 0 PGM, bit 1 PST.
- À vérifier : si le tally compte les sources en PinP / KEY / DSK ; les lignes
  partent sans STX (0x02), terminées par LF (conseil de Roland pour le LAN) ;
  la réponse attendue est `DTH:0C0000,<32 chiffres hexa>;`.
- Un autre modèle derrière le mot de passe (V-60HD, V-600UHD…) : reconnu à
  `VER;`, plus rien ne lui est envoyé, et pas de nouvel essai tant que les
  réglages ne changent pas.
- **Non supportés** : V-60HD et XS-62S (une seule connexion réseau : OBS
  Conductor bloquerait Companion ; exclus à la demande de Noar), V-1200HD
  (aucune commande de lecture connue), V-600UHD (lecture non vérifiée),
  V-8HD, V-1HD(+), V-02HD (pas de contrôle réseau).
- Source : `companion-module-roland-v160hd`, Roland V-160HD Remote Control Guide.

### vMix (`vmix`)
- TCP 8099 (API TCP, toujours active, sans mot de passe).
- Envoyé : `XML` uniquement (vMix répond `XML <octets>` puis son état). Jamais
  `FUNCTION` (actions).
- Lu : les inputs (`key`, `number`, `title`), `<active>` / `<preview>` (Mix 1),
  les overlays (`<overlay number="n">input</overlay>`, `preview="True"`).
  Un input est identifié par sa `key` (son numéro change quand on déplace les
  inputs). Les Mix 2 à 16 ne comptent pas comme antenne.
- Source : `companion-module-studiocoast-vmix`, doc TCP API de vMix.

### TriCaster / Viz Vectar (`tricaster`)
- HTTP 80. Envoyé : `GET /v1/version`, `GET /v1/dictionary?key=tally`,
  `GET /v1/dictionary?key=shortcut_states`, exactement. Jamais `/v1/shortcut`,
  `/v1/trigger`, `/v1/datalink?…&value=` (actions).
- Lu : `<column name="input2" on_pgm="true" on_prev="false"/>` (calculé par le
  TriCaster), noms `input2_long_name`. Mot de passe LivePanel : utilisateur et
  mot de passe dans Settings (réponse Basic ou Digest quand il est demandé).
- À vérifier : si `on_pgm` compte les sources visibles via un M/E ou un DSK.
- Source : `companion-module-newtek-tricaster`, Tally Arbiter, newtek-go.

### Barco E2 / S3 / EX / Encore 3 (`eventmaster`)
- JSON-RPC, HTTP POST sur le port 9999 (`/jsonrpc`). La même adresse lit ET
  agit : chaque appel est vérifié **méthode par méthode** (5 méthodes de
  lecture, paramètres entiers seulement) : `getFrameSettings`, `listSources`,
  `listDestinations`, `listContent`, `listAuxContent`.
- Lu : les sources (`InputCfgIndex` = l'input), les écrans et aux, les layers
  de chaque écran (`LastSrcIdx`, `PgmMode`, `PvwMode`), le fond (`BGLyr`),
  les aux (`PgmLastSrcIndex`, `PvwLastSrcIndex`).
- À vérifier : sur Encore 3, les layers par sortie (`DestOutMap`) et la
  numérotation du fond.
- Scan : **non scanné** (ses lectures sont des POST) : à choisir dans la liste.
- **Non supporté** : l'ancien Barco Encore (Folsom, TCP 3000) : aucune lecture
  du tally n'existe.
- Source : `companion-module-barco-eventmaster`, documents JSON-RPC Barco, qmsk/e2.

### Analog Way Aquilon / LivePremier (`livepremier`)
- REST, HTTP 80, `/api/tpp/v1`. Envoyé : des GET sur `system`, `screens/{s}`,
  `screens/{s}/layers/{l}`, `…/presets/program|preview`, `auxiliary-screens/…`,
  `inputs/{n}`. Tous les POST de `/api/tpp/v1` agissent : jamais envoyés.
  Mot de passe Web RCS : un `POST /auth/login {"password": …}` (ouvre une
  session, comme se connecter au Web RCS).
- Lu : la source de chaque layer en program / preview (`sourceType` "input",
  `sourceId`), le nom des inputs.
- Coût : 2 lectures par layer et par seconde ; la liste des écrans / layers /
  inputs est relue toutes les 30 s.
- À vérifier : le sens exact des `status` de layer (off, close, preempted…).
- Source : LivePremier REST API Programmer's Guide v4.0,
  `companion-module-analogway-livepremier`, `companion-module-analogway-awj`.

### Analog Way Ascender (LiveCore) (`livecore`)
- TCP 10600. Dans ce protocole, une lecture et une écriture se ressemblent :
  `0,1SPscl` ÉCRIT, `0,SPscl` LIT. Envoyé : `?` (type), `<i>,TAopr` et
  `<i>,TAopw` (tally program / preview de la source i, calculé par la machine,
  tous écrans). Jamais `TPdie` ni une ligne avec une valeur.
- Les noms d'inputs ne se lisent pas dans ce protocole : « Source 1, 2… ».
- À vérifier : la correspondance numéro de source / input, et l'envoi
  spontané des changements (relu toutes les 2 s de toute façon).
- Source : LiveCore TPP Programmer's Guide v03.00.88, `companion-module-analogway-livecore`.

### PixelHue Q8 / P10 / P20 / P80 (`pixelhue`)
- Même API sur tous les modèles. Voir `docs/Q8-TALLY-API.md`. GET uniquement
  sur 5 adresses.
- Source : `companion-module-pixelhue-switcher`.

### Panasonic KAIROS (`kairos`)
- REST, HTTP 1234 (API REST activée dans KAIROS, mode « Basic » ; utilisateur
  `Kairos`). Envoyé : `GET /inputs` uniquement. Les écritures KAIROS sont des
  PATCH : jamais envoyés.
- Lu : chaque input avec son nom et son `tally`, calculé par KAIROS (keys,
  PinP, scènes imbriquées) : bit 0 rouge (antenne), bit 1 vert (preview).
- Scan : un `GET /inputs` sur le port REST 1234 (KAIROS répond 401 en
  se nommant, ou la liste). Le protocole « simple control » (port 3005)
  n'est jamais utilisé : y lire un attribut qui est une fonction l'EXÉCUTE.
- À vérifier : la signification des bits de `tally` (dépend des couleurs de
  tally réglées dans KAIROS).
- Source : `companion-module-panasonic-kairos`, manuel KAIROS, kairos-go.
