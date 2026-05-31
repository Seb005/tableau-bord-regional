# Guide d'installation

Ce guide vous accompagne du clone à la mise en production.

**Prérequis :**
- Node.js ≥ 22.12.0
- Un compte [Supabase](https://supabase.com) (gratuit)
- Un compte [Netlify](https://netlify.com) (gratuit)
- Un nom de domaine (optionnel mais recommandé)

---

## 1. Cloner et installer

```bash
git clone https://github.com/Seb005/tableau-bord-regional.git mon-tableau-bord
cd mon-tableau-bord
npm install
cp .env.example .env
```

---

## 2. Configurer Supabase

### 2.1 Créer le projet

1. Sur [supabase.com](https://supabase.com), cliquez **New Project**.
2. Choisissez une région proche (`Canada Central` recommandé pour le Québec).
3. Notez le **mot de passe Postgres** (vous n'en aurez pas besoin pour ce projet, mais utile à conserver).
4. Attendez ~2 min que le projet soit prêt.

### 2.2 Récupérer les clés

Dans **Project Settings → API** :

| Variable d'env | Source |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | `anon` `public` key |
| `SUPABASE_SERVICE_KEY` | `service_role` `secret` key — **NE JAMAIS exposer côté client** |

Copiez ces valeurs dans votre `.env`.

### 2.3 Appliquer les migrations

Dans **SQL Editor → New Query**, exécutez les fichiers dans l'ordre, **un par un** :

```
supabase/migrations/20260101_initial_schema.sql
supabase/migrations/20260102_alertes_urgences_emplois.sql
supabase/migrations/20260103_widgets_phase3.sql
supabase/migrations/20260527_push_subscriptions.sql
supabase/migrations/20260528_finances_eur_history.sql
supabase/migrations/20260528_verrouiller_rls_anon.sql
```

> **Note :** Les migrations sont idempotentes (`CREATE TABLE IF NOT EXISTS` + `IF NOT EXISTS` sur les policies), donc vous pouvez les rejouer sans risque.

### 2.4 Vérifier les RLS

Dans **Authentication → Policies**, vérifiez que :
- Toutes les tables `nouvelles_*` ont une policy `Allow public read` (SELECT) pour le rôle `anon`
- `push_subscriptions` et `nouvelles_commentaires` n'ont **PAS** de policy `anon` (verrouillage total — seul `service_role` y accède)

C'est ce que fait `20260528_verrouiller_rls_anon.sql`.

---

## 3. Générer les clés VAPID (notifications push)

```bash
npx web-push generate-vapid-keys
```

Copiez `Public Key` et `Private Key` dans votre `.env` :

```
VAPID_PUBLIC_KEY=B...
VAPID_PRIVATE_KEY=...
PUBLIC_VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_SUBJECT=mailto:contact@votre-domaine.com
```

Choisissez aussi un `PUSH_ADMIN_TOKEN` (n'importe quel secret aléatoire long — `openssl rand -hex 32` par ex.) pour autoriser l'envoi de notifications.

---

## 4. Tester en local

```bash
npm run dev
```

Ouvrez [localhost:4321/nouvelles](http://localhost:4321/nouvelles).

**À ce stade les widgets seront vides** — c'est normal, les crons Netlify ne tournent pas en local. Pour amorcer les données :

```bash
node scripts/seed-nouvelles.mjs
```

Ce script exécute manuellement chaque scraper et remplit Supabase. À refaire après chaque ajout d'un nouveau widget, ou utilisez `npx netlify dev` pour simuler les fonctions Netlify localement.

---

## 5. Déployer sur Netlify

### 5.1 Créer le site

1. Dans Netlify : **Add new site → Import an existing project**.
2. Connectez votre repo GitHub.
3. Build settings :
   - Build command : `npm run build`
   - Publish directory : `dist`
   - Functions directory : `netlify/functions`
4. Cliquez **Deploy**.

### 5.2 Variables d'environnement

Dans **Site settings → Build & deploy → Environment variables**, ajoutez toutes les variables de votre `.env` :

**Obligatoires :**
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`
- `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`
- `PUBLIC_SITE_URL` (URL Netlify ou votre domaine)
- `ALLOWED_ORIGINS` (CSV des origines autorisées au CORS)

**Push (recommandé) :**
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `PUSH_ADMIN_TOKEN`

**Optionnels :** voir `.env.example` pour la liste complète.

### 5.3 Vérifier les crons

Les fonctions Netlify ont leurs schedules définis dans le code (ex: `export const config = { schedule: '0 */6 * * *' }`). Après le premier déploiement réussi, vérifiez dans **Functions → Scheduled functions** que tous les crons sont listés.

Le premier remplissage des widgets peut prendre jusqu'à 24h (selon les schedules). Pour amorcer immédiatement, déclenchez manuellement chaque fonction via l'URL `/.netlify/functions/nouvelles-XXX`.

---

## 6. Configurer le domaine personnalisé (optionnel)

1. **Domains → Add custom domain** dans Netlify.
2. Mettez à jour vos enregistrements DNS selon les instructions Netlify.
3. Mettez à jour `PUBLIC_SITE_URL` et `ALLOWED_ORIGINS` dans les variables d'env.
4. Redéployez.

---

## 7. Widgets optionnels

### Widget Internet (M-Lab BigQuery)

Mesure les vitesses Internet de votre région via les données ouvertes M-Lab.

1. Créez un projet [Google Cloud](https://console.cloud.google.com).
2. Activez **BigQuery API**.
3. Créez un **compte de service** avec le rôle **BigQuery User**.
4. Téléchargez la clé JSON.
5. Copiez le contenu JSON (en une seule ligne) dans `GCP_CREDENTIALS_JSON`.
6. Adaptez la requête SQL dans `netlify/functions/nouvelles-internet.js` pour votre région (codes postaux / coordonnées).

### Widget Emplois

Définissez `JOBS_PORTAL_URL` pointant vers un portail [Jobstat](https://jobstat.ca/), ou adaptez `nouvelles-emplois.js` à votre source.

### Health-check + alertes courriel

Pour recevoir une alerte courriel quand un widget tombe en panne :
1. Créez un compte [Resend](https://resend.com).
2. Vérifiez votre domaine d'expédition.
3. Définissez `RESEND_API_KEY`, `FROM_EMAIL`, `ALERT_EMAIL` dans les variables d'env.

### Analytics

- **Plausible :** créez un site sur [plausible.io](https://plausible.io), copiez le script URL dans `PUBLIC_PLAUSIBLE_SCRIPT_URL`. Pour le compteur de visiteurs en direct, créez aussi une clé API et définissez `PLAUSIBLE_API_KEY` + `PLAUSIBLE_SITE_ID`.
- **GA4 / Meta Pixel :** définissez `PUBLIC_GA4_ID` et/ou `PUBLIC_FB_PIXEL_ID`. La bannière de consentement s'affichera automatiquement.

---

## Sécurité

Avant la mise en production publique, vérifiez :

- [ ] `.env` est bien dans `.gitignore` (jamais committé)
- [ ] `ALLOWED_ORIGINS` est défini (sinon CORS retourne `*` — dev seulement)
- [ ] La policy RLS `20260528_verrouiller_rls_anon.sql` est appliquée
- [ ] Les clés `service_role` Supabase ne sont **jamais** exposées au client (seulement dans Netlify env vars)
- [ ] `PUSH_ADMIN_TOKEN` est un secret long et aléatoire
- [ ] HTTPS est activé (automatique chez Netlify)
- [ ] Aucune URL `localhost` ou clé de test ne traîne dans le code

---

## Dépannage

**Les widgets restent vides après le déploiement**
→ Attendre 24h, ou déclencher manuellement chaque fonction `nouvelles-*` via l'URL Netlify.

**Erreur CORS dans la console du navigateur**
→ Ajoutez l'origine à `ALLOWED_ORIGINS` et redéployez.

**Le push ne fonctionne pas**
→ Vérifiez que `PUBLIC_VAPID_PUBLIC_KEY` correspond bien à `VAPID_PUBLIC_KEY`. Sur iOS, l'app doit être ajoutée à l'écran d'accueil avant que les notifications fonctionnent.

**Sentry ne remonte aucune erreur**
→ Vérifiez `PUBLIC_SENTRY_DSN` et que le projet Sentry est actif. Le DSN client est public par design.

---

## Mise à jour

```bash
git pull
npm install
# Vérifiez s'il y a de nouvelles migrations dans supabase/migrations/
# Les exécuter manuellement dans le SQL Editor
git push   # déclenche le redéploiement Netlify
```
