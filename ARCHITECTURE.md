# Architecture

Un aperçu de comment les pièces s'imbriquent et comment ajouter ou modifier un widget.

---

## Vue d'ensemble

```
┌──────────────────┐
│  Sources         │  RSS, scraping HTML, APIs publiques (Open-Meteo, 511 Québec,
│  externes        │   Hydro-Québec, SOPFEU, Environnement Canada, etc.)
└────────┬─────────┘
         │ (fetch, parse)
         ▼
┌──────────────────┐
│  Netlify         │  Cron schedulé toutes les N heures.
│  Functions       │  Une fonction par source.
│  (scrapers)      │  Écrit avec service_role.
└────────┬─────────┘
         │ upsert
         ▼
┌──────────────────┐
│  Supabase        │  Une table par widget (single-row pour la plupart).
│  (Postgres)      │  RLS verrouillée : anon = SELECT only sur tables publiques.
└────────┬─────────┘
         │ SELECT (anon key)
         ▼
┌──────────────────┐
│  nouvelles-proxy │  Fonction Netlify qui agrège ~20 tables en une seule
│  (lecture)       │  réponse JSON. Évite d'exposer la clé Supabase au client.
└────────┬─────────┘
         │ fetch JSON
         ▼
┌──────────────────┐
│  /nouvelles      │  Page Astro statique. Le JS client appelle le proxy,
│  (page client)   │  rend les widgets, gère les push, les commentaires, etc.
└──────────────────┘
```

---

## Structure des dossiers

```
.
├── src/
│   ├── pages/
│   │   ├── nouvelles.astro              # Page principale du dashboard (2200+ lignes)
│   │   └── nouvelles/
│   │       ├── archives.astro           # Articles > 30 jours, paginés
│   │       ├── methodologie.astro       # Documentation de la collecte
│   │       └── wallpaper.astro          # Variante fond d'écran
│   ├── layouts/BaseLayout.astro         # HTML + SEO + Sentry init
│   ├── components/                      # Header, Footer, SEO, CookieBanner
│   ├── data/site.json                   # Branding (nom, région, contact)
│   └── styles/global.css                # Tailwind + custom (grain, theme)
├── netlify/
│   ├── functions/
│   │   ├── nouvelles-proxy.js           # ★ Lecture agrégée (anon)
│   │   ├── nouvelles-archives.js        # Pagination archives
│   │   ├── nouvelles-meteo.js           # ★ Cron - scrape météo
│   │   ├── nouvelles-essence.js         # ★ Cron - prix essence
│   │   ├── nouvelles-sopfeu.js          # ★ Cron - feux de forêt
│   │   ├── ... (≈30 scrapers)           # Un par source
│   │   ├── nouvelles-healthcheck.js     # Cron 30min - alerte si KO
│   │   ├── nouvelles-visiteurs.js       # Proxy Plausible
│   │   ├── nouvelles-commentaire.js     # GET liste / POST nouveau
│   │   ├── push-subscribe.js            # Enregistre subscription push
│   │   ├── push-unsubscribe.js          # Désenregistre
│   │   └── push-envoyer.js              # Envoie une notif à tous (admin)
│   └── lib/
│       ├── sentry.js                    # withSentry, withCron wrappers
│       └── cors.js                      # corsHeadersFor helper
├── supabase/migrations/                 # SQL versionné
├── scripts/
│   ├── seed-nouvelles.mjs               # Amorçage manuel (dev)
│   └── migrations/                      # SQL pour healthcheck
├── public/                              # favicon, manifest, sw.js
├── astro.config.mjs
├── netlify.toml                         # CSP, headers, redirects
└── package.json
```

★ = fonctions critiques.

---

## Tables Supabase

| Table | Pattern | Mise à jour |
|---|---|---|
| `nouvelles_meteo` | single-row (id=1) | toutes les 6h |
| `nouvelles_essence` | single-row | 2×/jour |
| `nouvelles_sopfeu` | single-row | 2×/jour |
| `nouvelles_finances` | single-row | 1×/jour |
| `nouvelles_finances_history` | append-only | 1×/jour |
| `nouvelles_hydro` | single-row | toutes les 4h |
| `nouvelles_routes` | single-row | toutes les 6h |
| `nouvelles_alertes` | single-row | toutes les 3h |
| `nouvelles_urgences` | single-row | toutes les 2h |
| `nouvelles_emplois` | single-row | toutes les 6h |
| `nouvelles_bornes_electriques` | single-row | toutes les 6h |
| `nouvelles_loisirs` (`nouvelles_activites_loisirs`) | single-row | 1×/jour |
| `nouvelles_air` | single-row | toutes les 3h |
| `nouvelles_aurores` | single-row | toutes les 6h |
| `nouvelles_eau` | single-row | 2×/jour |
| `nouvelles_internet` | single-row | 1×/semaine |
| `nouvelles_cciao` | single-row | toutes les 6h |
| `nouvelles_transport` | single-row | toutes les heures |
| `nouvelles_articles` | append-only (UNIQUE url) | continu |
| `nouvelles_commentaires` | append-only | sur soumission |
| `nouvelles_healthcheck` | single-row state machine | toutes les 30 min |
| `push_subscriptions` | append-only | sur opt-in |

**Pattern single-row :** chaque widget a une table à une seule ligne (`id=1`) que le scraper réécrit (`upsert`). Simple, atomique, pas de gestion d'historique côté lecture. L'historique est gardé séparément (ex: `nouvelles_finances_history`) quand pertinent.

**RLS :** verrouillé strictement par `20260528_verrouiller_rls_anon.sql` — voir [SETUP.md §2.4](SETUP.md#24-vérifier-les-rls).

---

## Cycle de vie d'une donnée

Prenons l'exemple de la météo :

1. **Cron** : `nouvelles-meteo.js` est planifiée `0 */6 * * *` (toutes les 6h).
2. **Fetch** : appelle l'API Open-Meteo avec lat/long de La Sarre.
3. **Parse** : extrait température, vent, humidité, prévisions 5 jours.
4. **Upsert** : `supabase.from('nouvelles_meteo').upsert({ id: 1, ...data })` avec `service_role`.
5. **Lecture** : le navigateur d'un visiteur appelle `/.netlify/functions/nouvelles-proxy`.
6. **Agrégation** : `nouvelles-proxy.js` fait `SELECT * FROM nouvelles_meteo` (et toutes les autres) en parallèle avec `anon_key`.
7. **Réponse** : JSON unique de toutes les tables.
8. **Rendu** : `nouvelles.astro` rend les widgets dans le DOM.

**Auto-refresh côté client :** la page rafraîchit certains widgets temps-sensibles (météo, urgences, alertes) chaque ~5 min via `setInterval`.

---

## Ajouter un nouveau widget

1. **Créer la table Supabase**
   Ajoutez une migration `supabase/migrations/YYYYMMDD_widget_X.sql` :
   ```sql
   CREATE TABLE IF NOT EXISTS nouvelles_mon_widget (
     id int PRIMARY KEY DEFAULT 1,
     donnee text,
     mis_a_jour timestamptz DEFAULT now(),
     CONSTRAINT single_row_mon_widget CHECK (id = 1)
   );
   ALTER TABLE nouvelles_mon_widget ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "Allow public read" ON nouvelles_mon_widget FOR SELECT USING (true);
   ```
   Exécutez dans Supabase SQL Editor.

2. **Créer la fonction scraper**
   Copiez une fonction existante simple comme `nouvelles-aurores.js` comme template :
   ```js
   import { withSentry } from '../lib/sentry.js';

   export const config = { schedule: '0 */6 * * *' };

   const __sentryHandler = async () => {
     const SUPABASE_URL = process.env.SUPABASE_URL;
     const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
     // ...fetch + parse...
     const res = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_mon_widget`, {
       method: 'POST',
       headers: {
         apikey: SUPABASE_SERVICE_KEY,
         Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
         'Content-Type': 'application/json',
         Prefer: 'resolution=merge-duplicates',
       },
       body: JSON.stringify({ id: 1, donnee: '...', mis_a_jour: new Date().toISOString() }),
     });
     return new Response('OK');
   };

   export default withSentry(__sentryHandler);
   ```

3. **Ajouter au proxy**
   Dans `nouvelles-proxy.js`, ajoutez votre table à la liste des `SELECT` parallèles.

4. **Rendre le widget**
   Dans `src/pages/nouvelles.astro`, ajoutez le HTML du widget et le JS qui lit `data.mon_widget` depuis la réponse du proxy.

5. **Healthcheck** (optionnel)
   Dans `nouvelles-healthcheck.js`, ajoutez votre widget à `SOURCES` avec `intervalHours` correspondant.

---

## Conventions

- **Pas de secrets côté client.** Tout ce qui commence par `PUBLIC_` est exposé au navigateur — n'y mettez que des valeurs publiques par design (DSN Sentry, clé anon Supabase, clé publique VAPID).
- **Service role** côté serveur seulement (Netlify Functions).
- **Crons** : préférez espacer (toutes les 6h plutôt que 1h) pour économiser le quota Netlify et être doux avec les sources.
- **Idempotence** : un upsert doit être rejouable sans dommage.
- **Erreurs** : encapsulez avec `withSentry()` / `withCron(handler, slug, schedule)` — silencieux si pas de DSN, traceable si configuré.
- **Resilience** : si une source est down, l'erreur reste dans cette fonction; les autres widgets continuent de fonctionner.

---

## Performance

- Page statique pré-rendue par Astro → CDN edge → TTFB ~50ms.
- Proxy unique → 1 seul round-trip pour 20+ tables.
- Auto-refresh ciblé : seuls les widgets temps-sensibles se rafraîchissent.
- Service worker met en cache `/nouvelles` pour fonctionnement offline minimal.

L'instance CJEAO sert ~500 visiteurs/jour sans dépasser les plans gratuits Netlify (125k requêtes Functions/mois) et Supabase (500MB DB).

---

## Monitoring

- **Sentry** : erreurs des Functions (cold start, fetch fail, parse error) + erreurs JS client.
- **Healthcheck** : `nouvelles-healthcheck.js` vérifie toutes les 30 min que chaque widget a été mis à jour dans son intervalle attendu. Alerte par courriel via Resend si dégradation, et nouveau courriel quand rétabli.
- **Plausible** : trafic + entonnoirs.
