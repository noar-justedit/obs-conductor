# Récupérer l'état OnAir/OffAir d'un input sur Pixelhue Q8

Fourni par Noar (oct. 2026). Utilisé par `src/tally.js`.

Guide pratique pour une app qui a juste besoin de savoir **si un input donné
est ON AIR (PGM) ou pas** sur un Q8 / P20 / P80.

Contexte : aucune doc officielle, protocole reverse-engineered depuis
l'API Companion et testé sur le terrain. Tout est en HTTP/WS, JSON pour
le REST, TLV binaire pour le WebSocket.

## TL;DR

1. Découvre le device en HTTPS sur le port **19998**
2. Récupère le `sn` et le `startTime` via une première requête HTTP
3. Signe un JWT **HS256** avec `startTime` comme clé secrète, payload `{SN}`
4. GET trois endpoints : `preset`, `layers/list-detail`, `interface/list-detail`
5. Pour chaque preset, regarde `currentRegion` (2 = PGM, 4 = PVW, 6 = PGM+clear)
6. Pour chaque preset PGM, regarde ses layers : `source.general.sourceName` est
   le nom de l'input. Si ça matche ton input → il est ON AIR
7. Re-polle toutes les 1-2s OU abonne-toi au WebSocket pour du push

## 1. Découverte

`GET https://<host>:19998/unico/v1/ucenter/device-list?clientType=8`

Retourne un JSON avec `data.list[]`. Chaque device a un `protocols[]`
contenant des `{ linkType, port }`. Le `linkType === 'http'` donne le port
REST (souvent 80 ou 8080). Le port 19998 est toujours le WebSocket (WSS).
Le certificat est auto-signé : désactiver la vérification SSL.

## 2. Authentification

`GET http://<host>:<apiPort>/unico/v1/node/open-detail`

Retourne `data.sn` (numéro de série) et `data.startTime` (timestamp en
string, sert de clé secrète).

JWT : header `{"alg":"HS256","typ":"JWT"}`, payload `{"SN":"<sn>"}`,
signature `HMAC-SHA256(startTime, "<headerB64>.<payloadB64>")`, base64 URL
sans padding. Envoyé dans l'en-tête `Authorization: <token>`.

## 3. Endpoints utiles (port REST, en clair)

| Endpoint | Ce qu'il retourne |
|---|---|
| `GET /unico/v1/preset` | Presets ; chacun a `currentRegion` (2/4/6) et `screens[]` |
| `GET /unico/v1/layers/list-detail` | Layers ; chacun a `source.general.sourceName` |
| `GET /unico/v1/interface/list-detail` | Inputs physiques (nom, slot, type, signal) |
| `GET /unico/v1/screen/list-detail` | Écrans de sortie |
| `GET /unico/v1/system/ctrl/source-backup` | Config backup (optionnel) |

## 4. Logique

Pour chaque preset P avec `currentRegion` 2 ou 6 (PGM), pour chaque layer L
de P (lien : `L.presetId` / `L.presetSerial` = `P.serial` / `P.presetSerial`) :
si `L.source.general.sourceName` = nom de l'input, il est ON AIR. PVW :
`currentRegion` 4.

Ne jamais utiliser `sourceId` / `sourceIndex` (locaux à chaque carte) :
seul le **nom** identifie un input. Sensible à la casse ; trim des espaces.

Layers orphelins (non rattachés à un preset) : cas rare, ignoré.

## 5. Pièges

1. Certificat auto-signé sur 19998.
2. Le token vaut tant que le Q8 tourne (nouveau `startTime` à chaque
   démarrage : refaire `open-detail`).
3. Nom de l'input sensible à la casse.
4. `currentRegion` 6 = PGM + clear : ON AIR aussi.
5. WebSocket : fermé après ~60 s sans PING ; trames TLV binaires
   (0x40103 PRESET_TAKEN, 0x40501 LAYER_UPDATED, 0x4050d
   SOURCE_BACKUP_UPDATED). Plus simple : poller toutes les 1-2 s.
6. Référence : module Companion Bitfocus
   https://github.com/bitfocus/companion-module-pixelhue-switcher

## Correction (après la 1.5.0, constatée par Noar sur un vrai Q8)

La logique « preset + currentRegion » ci-dessus ne marche pas : les layers
n'ont pas de `presetId`, donc aucun input n'était jamais vu ON AIR.

Ce que fait le module Companion lui-même (`src/interfaces/Layer.ts`,
`src/feedbacks.ts`, `src/interfaces/Screen.ts`) et ce que fait maintenant
`src/tally.js` :

- `GET /unico/v1/layers/list-detail` : chaque layer a
  `layerIdObj.sceneType` (2 = PGM, 4 = PVW), `layerIdObj.attachScreenId`
  (l'écran) et `source.general.sourceName` (l'input affiché).
- `GET /unico/v1/screen/list-detail` : chaque écran a `screenId`,
  `screenIdObj.type` (2 = écran, 4 = AUX, 8 = multiviewer), `enable`,
  `ftb.enable` (fondu au noir).
- Un input est ON AIR s'il est sur un layer PGM d'un écran qui n'est ni le
  multiviewer, ni désactivé, ni en FTB. PVW pareil avec sceneType 4.

Vérifié sur la réponse d'un vrai Q8 (`test/fixtures/q8-hall8.json`) :
`layerIdObj.attachScreenId` = `screenId` de l'écran ; un layer a aussi
`enable` (0 = éteint, ne compte pas) et `layerIdObj.type` (8 = layer de
multiviewer). Piège constaté : un input « HALL 8 » (retour de l'écran, vu
seulement au multiviewer) à côté de « OBS HALL 8 » (la vraie sortie d'OBS).

Diagnostic : `http://localhost:8090/api/tally/debug` (sur le PC même)
renvoie les deux listes brutes et l'état calculé. Lecture seule.
