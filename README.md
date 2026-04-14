# instagram-lists-aggregator

Aspire les listes de bookmarks Instagram (collections "saved") vers un dossier local : un sous-dossier par post avec média(s) + `metadata.json`. Re-runs incrémentaux — médias déjà présents non retéléchargés, métadonnées rafraîchies, posts retirés marqués `removed_from_list`.

## Installation

```bash
pipx install instagrapi
npm install
cp config.example.json config.json
# Éditer config.json : username, output_root absolu
```

## Usage

```bash
# Toutes les listes
node src/index.js

# Une ou plusieurs listes ciblées
node src/index.js --list "Voyages"
node src/index.js --list "Voyages" --list "Recettes"

# Sans prompt interactif
IGA_PASSWORD='...' IGA_2FA_CODE='123456' node src/index.js
```

Au premier run, mot de passe demandé (masqué) et 2FA si activée. Session persistée dans `~/.cache/iga/`.

## Configuration

| Clé | Défaut | Rôle |
|---|---|---|
| `username` | — | Compte Instagram |
| `output_root` | — | Chemin absolu de la racine d'archive |
| `lists` | `null` | `null` = toutes, sinon tableau de noms |
| `max_posts_per_run` | `200` | Limite par run (0 = illimité) |
| `inter_list_pause_seconds` | `60` | Pause entre listes |
| `request_delay_range` | `[2, 6]` | Délai aléatoire (s) entre posts |

## Structure de sortie

```
<output_root>/
  Voyages/
    .state.json
    errors.log
    C_abc123/
      media_1.jpg
      media_2.mp4
      metadata.json
```

Note métadonnées : `location.lat`/`lng` peuvent être `null` si Instagram ne les expose pas.
