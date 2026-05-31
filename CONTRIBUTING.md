# Contribuer

Merci de l'intérêt! Ce projet est partagé pour servir d'autres régions; toute contribution qui le rend plus utile est bienvenue.

## Avant de commencer

- **Ouvrez une issue** pour les changements non-triviaux. Ça évite qu'on travaille en double et permet d'aligner l'approche tôt.
- **Petites corrections** (bugs, typos, scrapers cassés) : envoyez directement une PR.

## Types de contributions particulièrement utiles

- 🆕 **Nouveaux widgets** d'intérêt général : pollens, transport collectif, événements culturels, qualité de l'eau potable, etc.
- 🌍 **Scrapers d'autres régions/provinces** comme exemples documentés
- 🐛 **Réparations de scrapers** (la structure HTML/RSS des sites change régulièrement)
- ♿ **Améliorations d'accessibilité**
- 📚 **Documentation** — surtout pour les régions hors-Québec
- 🎨 **Variantes de design / themes**

## Workflow

1. Fork + branche depuis `main`
2. `npm install` + `cp .env.example .env`
3. Faites votre changement
4. Testez localement (`npm run dev` + `node scripts/seed-nouvelles.mjs`)
5. PR avec description claire de **ce que ça change et pourquoi**

## Style de commits

Préfixes utilisés :
- `feat(widget): ...` — nouveau widget ou fonctionnalité
- `fix(widget-xxx): ...` — réparation d'un scraper ou bug
- `perf: ...` — optimisation
- `docs: ...` — documentation
- `chore: ...` — config, dépendances

## Ajouter un widget

Voir [ARCHITECTURE.md](ARCHITECTURE.md#ajouter-un-nouveau-widget) pour la marche à suivre détaillée. Le résumé :

1. Migration SQL → 2. Fonction scraper → 3. Ajouter au proxy → 4. Rendre dans `nouvelles.astro` → 5. (Optionnel) Healthcheck

## Sécurité

- Ne committez **jamais** un `.env`, une clé API, ou des données personnelles.
- Pour signaler une vulnérabilité, contactez en privé l'auteur du repo plutôt que d'ouvrir une issue publique.

## Code de conduite

Soyez respectueux. Pas plus compliqué que ça.
