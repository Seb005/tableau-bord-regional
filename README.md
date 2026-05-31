# Tableau de bord régional

> Un tableau de bord open source qui compile en un coup d'œil **la météo, les urgences, les routes, les pannes Hydro, les alertes, le prix de l'essence, les emplois, l'agenda local et les nouvelles régionales** — agrégés depuis plus de 20 sources publiques.

Construit pour le [Carrefour jeunesse-emploi d'Abitibi-Ouest](https://www.cjeao.qc.ca/) (CJEAO), partagé sous licence MIT pour que d'autres régions puissent l'adapter et le déployer.

**👉 Voir l'instance de démonstration :** [cjeao.qc.ca/nouvelles](https://www.cjeao.qc.ca/nouvelles)

---

## Ce que vous obtenez

Un tableau de bord PWA installable, optimisé mobile, avec :

- **Météo + prévisions** (Open-Meteo)
- **Indice SOPFEU / risque d'incendies**
- **Pannes Hydro-Québec** en temps réel
- **État des routes provinciales** (Québec 511)
- **Alertes météo Environnement Canada**
- **Urgences hospitalières** (temps d'attente, occupation)
- **Qualité de l'air**
- **Aurores boréales** (probabilité, kp-index)
- **Niveau d'eau / hydrologie**
- **Prix de l'essence régional**
- **Cours de l'or + USD/CAD**
- **Offres d'emploi** (portails Jobstat)
- **Bornes de recharge VÉ** disponibles
- **Connectivité Internet** (M-Lab BigQuery)
- **Agenda local consolidé** (loisirs municipaux, chambre de commerce, événements régionaux)
- **Aggrégation de nouvelles** de plus de 13 sources (Radio-Canada, TVA, hebdos régionaux, CISSS, UQAT, etc.)
- **Notifications push** (Web Push API + VAPID)
- **Commentaires de la communauté**
- **Visiteurs en direct** (via Plausible)

Toutes les sources s'actualisent automatiquement via des **crons Netlify** et stockent leurs résultats dans Supabase. Le tableau de bord lit les données en une seule requête agrégée — pas de clés API exposées côté client.

---

## Stack

- **Frontend :** [Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com) (statique, hyperrapide)
- **Backend :** [Netlify Functions](https://docs.netlify.com/functions/overview/) (serverless Node 22)
- **BDD :** [Supabase](https://supabase.com) (Postgres + Row Level Security)
- **Push :** [Web Push API](https://web.dev/push-notifications-overview/) + VAPID
- **Monitoring :** [Sentry](https://sentry.io) (optionnel)
- **Analytics :** [Plausible](https://plausible.io) (optionnel, privacy-friendly)

**Coût d'opération :** essentiellement gratuit — l'instance CJEAO tourne sur les plans gratuits de Netlify + Supabase + Sentry pour environ 0 $/mois.

---

## Démarrage rapide

```bash
git clone https://github.com/Seb005/tableau-bord-regional.git
cd tableau-bord-regional
npm install
cp .env.example .env
# Éditez .env avec vos clés Supabase, VAPID, etc.
npm run dev
```

Ouvrez [localhost:4321/nouvelles](http://localhost:4321/nouvelles).

Pour déployer en production (Netlify + Supabase) : voir **[SETUP.md](SETUP.md)**.

Pour comprendre l'architecture, ajouter un widget ou personnaliser : voir **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Adapter à votre région

Le projet a été conçu et calibré pour l'**Abitibi-Ouest (Québec)**. Pour le déployer dans une autre région, vous devrez adapter principalement :

### 1. Sources de nouvelles (`netlify/functions/nouvelles-*.js`)
Les scrapers ciblent des sites québécois précis (Radio-Canada Abitibi, TVA Abitibi, hebdos locaux, MRC, CISSS-AT, UQAT, etc.). Remplacez-les par les équivalents de votre région :
- RSS d'un média national filtré sur votre région
- Site de votre municipalité, MRC, ou regroupement régional
- Centre intégré de santé local
- Établissement d'enseignement
- Chambre de commerce locale

Le pattern est partout le même : un fetch HTTP/RSS → parse → upsert dans Supabase.

### 2. Coordonnées géographiques
Plusieurs widgets utilisent les coordonnées de La Sarre (lat/long) :
- `nouvelles-meteo.js` (Open-Meteo)
- `nouvelles-aurores.js`
- `nouvelles-air.js`

Cherchez `48.8` (latitude) ou `-79.2` (longitude) dans `netlify/functions/` et remplacez par vos coordonnées.

### 3. Zones / régions administratives
- **SOPFEU :** `nouvelles-sopfeu.js` cible une zone précise — adaptez si votre région a des feux de forêt suivis différemment.
- **Routes :** `nouvelles-routes.js` interroge Québec 511 par région administrative — changez le code de région.
- **Hydro :** `nouvelles-hydro.js` filtre par région Hydro-Québec.
- **Urgences :** `nouvelles-urgences.js` filtre par CISSS / établissement — adaptez selon votre RSS.

### 4. Branding
- `src/data/site.json` — nom, région, organisation, contact
- `src/components/Header.astro`, `Footer.astro` — votre logo si applicable
- `public/manifest.webmanifest` — nom de l'app installée
- `public/icon-*.png`, `favicon.*` — vos icônes

### 5. Widget emplois
Définissez `JOBS_PORTAL_URL` dans vos variables d'env si vous utilisez un portail Jobstat, sinon adaptez `nouvelles-emplois.js` à votre source d'emplois.

### 6. Hors-Québec / hors-Canada
Plusieurs widgets sont spécifiques au Québec (SOPFEU, Hydro-Québec, urgences CISSS, routes 511 Québec). Pour une adaptation hors-Québec, ces widgets devront être réécrits pour des sources équivalentes (par ex. provincial fire authorities, BC Hydro, etc.).

---

## Sécurité

- **Aucun secret côté client.** Toutes les clés sont chargées via variables d'env, jamais hardcodées.
- **RLS Supabase verrouillé** : le rôle `anon` ne peut faire que des `SELECT` sur les tables publiques; aucun accès aux abonnements push ou commentaires en attente.
- **Service role** utilisé uniquement côté serveur (Netlify Functions).
- **CORS allowlist** configurable via `ALLOWED_ORIGINS`.
- **CSP stricte** dans `netlify.toml`.
- **Sentry** désactivé par défaut, activable via env var.
- Bannière de consentement cookies (Loi 25 Québec) seulement si analytics activés.

Voir [SETUP.md](SETUP.md#sécurité) pour les vérifications recommandées avant déploiement.

---

## Contribuer

Les contributions sont bienvenues, surtout :
- 🆕 **Nouveaux widgets** d'intérêt général (pollens, COVID, transport collectif, etc.)
- 🌍 **Scrapers d'autres régions** (Québec ou ailleurs) que d'autres pourront forker comme exemple
- 🐛 **Corrections de scrapers cassés** (la structure HTML/RSS des sites change)
- 📚 **Documentation** — surtout pour les régions hors-Abitibi

Voir [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licence

MIT — voir [LICENSE](LICENSE).

Fait avec ❤️ en Abitibi-Ouest. Si vous l'adaptez pour votre région, [écrivez-nous](mailto:webmestre@cjeao.qc.ca) — on serait curieux de voir!
