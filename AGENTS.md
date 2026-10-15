# Règles de développement (pour toute IA reprenant ce projet)

Projet de **Noar** (just edit lab). Ces règles s'appliquent quelle que soit l'IA.

## Contexte
- Noar est monteur et technicien vidéo, pas développeur. Il travaille sur Mac.
- L'application tourne sur **Windows, macOS et Linux** (depuis la 2.0).
- Elle est publique sur GitHub (`github.com/noar-justedit/obs-conductor`,
  licence GPL-3.0-or-later). Noar publie lui-même : le code à partir du ZIP
  fourni, les builds dans les Releases.

## 1. Périmètre : rien en dehors de la demande
- Ne modifier que ce qui est demandé.
- Pour tout le reste (outillage, scripts de build, dépendances, organisation des
  fichiers, comportements par défaut) : proposer, expliquer l'impact, puis
  attendre un « oui » explicite. Jamais d'initiative silencieuse.

## 2. Communication
- Répondre en français, simplement, sans jargon.
- Expliquer en quelques phrases ce que fait le code et pourquoi cette méthode
  plutôt qu'une autre.
- Signaler les conséquences concrètes : ce qui peut casser plus tard, ce qui sera
  difficile à modifier, les limites, les impacts coût / sécurité / maintenance /
  performances.
- Pas de flatterie. Si Noar se trompe, le lui dire et expliquer pourquoi.

## 3. Builds
- Sur le Mac : `build_mac.command` (macOS, signé et notarisé) et
  `build_windows.command` (installeur Windows, NSIS).
- Sur un PC Linux : `build_linux.sh` (.deb et AppImage).
- Toute modification non demandée des scripts de build suit la règle 1.

## 4. Versions
- Aucun bump sans confirmation explicite du numéro par Noar. Format X.Y.Z.
- Procédure : proposer un numéro, attendre la confirmation, mettre à jour
  **tous** les emplacements listés dans `ETAT_PROJET.md` (section
  « Emplacements de la version »), puis vérifier qu'aucun n'a été oublié.

## 5. Livraison : le ZIP
- À chaque bump, fournir `obsConductor_vX.Y.Z.zip`.
- Décompressé, il correspond exactement à ce que Noar pousse sur GitHub :
  sources, scripts de build, documentation et fichiers de suivi.
- Il ne contient pas : les builds (qui vont dans les Releases), les dossiers
  générés (`node_modules`, `dist`, `build`), aucun secret (mot de passe, clé,
  certificat, `scripts/signing.local`).
- Il doit suffire à lui seul pour reprendre le développement avec n'importe
  quelle IA.

## 6. Fichiers de suivi (à jour à chaque bump)
- `README.md` : ce que fait l'app et comment la builder (en anglais, pour
  GitHub), avec les captures de `docs/screenshots/` (à refaire quand
  l'interface change).
- `AGENTS.md` : ces règles. `CLAUDE.md` renvoie ici.
- `ETAT_PROJET.md` : état, architecture, décisions et raisons, problèmes connus,
  prochaines étapes, emplacements de la version.
- `CHANGELOG.md` : historique des versions.

## 7. Publication sur GitHub : `scripts/push_github.command`
- Noar décompresse le ZIP et double-clique ce script dans le dossier obtenu :
  GitHub devient exactement le contenu du dossier (ajouts, modifications et
  fichiers retirés). Jamais d'envoi par l'upload web de GitHub.
- Le script travaille dans une copie temporaire du dépôt, affiche la liste des
  changements et attend un « y ». Jamais d'envoi forcé.
- Il refuse d'envoyer si `version.json` n'est pas strictement plus récent que
  celui publié sur GitHub, ou si `version.json` et `package.json` ne disent pas
  le même numéro.
- `version.json` part en dernier : tant que la Release `vX.Y.Z` et ses binaires
  ne sont pas publiés, le script garde l'ancien sur GitHub ; on le relance
  ensuite pour l'envoyer.

## 8. Licences
- Projet sous GPL-3.0-or-later. Tout code, police, icône ou bibliothèque
  ajouté doit avoir une licence compatible, et être listé dans
  `THIRD_PARTY_LICENSES.md`.

## Spécifique à ce projet
- **RÈGLE ABSOLUE : tally en LECTURE SEULE.** OBS Conductor n'envoie JAMAIS
  de commande au switcher de tally (PixelHue Q8 / P20 / P80, et tout appareil
  ajouté plus tard : Aquilon, E2, Encore 3...). Uniquement des lectures :
  requêtes GET vers une liste fermée d'adresses de lecture (`READ_ONLY` dans
  `src/tally.js`), aucun POST / PUT / DELETE, aucun envoi sur un WebSocket,
  aucun TAKE, aucun changement de preset, d'input ou de layer. Demande
  explicite de Noar, non négociable : un appareil de régie en direct ne doit
  pas pouvoir être modifié par cette appli. Un test (`test/tally.test.js`)
  vérifie que seules ces lectures partent. Tout nouvel appareil suit la même
  règle, avec sa propre liste fermée et son test.
- Code de couleurs de Noar : VERT = marche / connecté / activé ; ROUGE = ne
  marche pas / déconnecté / désactivé / erreur ; ORANGE = action de
  l'utilisateur attendue / avertissement.
- Charte graphique « just edit lab » (comme syncto / ingesto) : voir le haut de
  la feuille de style de `src/dock.html`. Couleur propre à l'app : rose
  `#ff5ca8`, sur le logo uniquement.
- Lancer `npm test` avant toute livraison.
