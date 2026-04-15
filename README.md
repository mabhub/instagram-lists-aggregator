# instagram-lists-aggregator

Aspire les listes de bookmarks Instagram (collections "saved") vers un dossier local : un sous-dossier par post avec média(s) + `metadata.json`. Re-runs incrémentaux — les posts déjà entièrement archivés sont sautés sans appel API, les posts sans média sont retentés, et les posts retirés d'une liste sont marqués `removed_from_list` (sans être supprimés).

## Prérequis

- Node.js ≥ 20
- `pipx` (pour installer instagrapi dans un environnement isolé)
- Un compte Instagram avec des collections "saved"

Note : la pseudo-collection « All posts » (qui regroupe l'ensemble des posts sauvegardés, indépendamment des collections nommées) est automatiquement ignorée — seules les collections nommées sont traitées.

## Installation

```bash
pipx install instagrapi
cp config.example.json config.json
# Éditer config.json : username, output_root absolu
```

Aucune dépendance Node runtime — pas besoin de `npm install`.

## Usage

```bash
# Toutes les listes
node src/index.js

# Une ou plusieurs listes ciblées
node src/index.js --list "Voyages"
node src/index.js --list "Voyages" --list "Recettes"

# Config personnalisé (défaut : ./config.json)
node src/index.js --config /chemin/vers/autre-config.json

# Rafraîchir les stats (likes/vues/commentaires) des posts déjà archivés
node src/index.js --refresh-metadata

# Sans prompt interactif
IGA_PASSWORD='...' IGA_2FA_CODE='123456' node src/index.js
```

Par défaut, un post dont le média et `metadata.json` sont déjà présents est sauté sans appel API — les re-runs sur une archive complète sont donc quasi-instantanés. Utiliser `--refresh-metadata` pour forcer un rafraîchissement des `stats` (snapshot de l'instant du dernier refresh).

Au premier run, mot de passe demandé (saisie masquée) et code 2FA si activée (prompt sur stderr, compatible pipe). Session persistée dans `~/.cache/iga/` et réutilisée ensuite.

## Configuration

| Clé | Défaut | Rôle |
|---|---|---|
| `username` | — | Compte Instagram |
| `output_root` | — | Chemin absolu de la racine d'archive |
| `lists` | `null` | `null` = toutes, sinon tableau de noms |
| `max_posts_per_run` | `200` | Limite par run (0 = illimité) |
| `inter_list_pause_seconds` | `60` | Pause entre listes |
| `request_delay_range` | `[2, 6]` | Délai aléatoire (s) entre posts qui touchent le réseau |

## Structure de sortie

```
<output_root>/
  Voyages/
    .state.json           # diff état précédent vs courant
    errors.log            # erreurs non-fatales par post
    C_abc123/
      media_1.jpg
      media_2.mp4
      metadata.json
```

Note métadonnées : `location.lat`/`lng` peuvent être `null` si Instagram ne les expose pas.
