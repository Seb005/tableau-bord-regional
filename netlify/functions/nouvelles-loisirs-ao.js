import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — tous les jours à 8h
 * Récupère les activités loisirs à venir depuis le portail Espace Loisirs
 * d'Abitibi-Ouest (loisirs.ao.ca) et met à jour la table `nouvelles_activites_loisirs`.
 *
 * Source des données :
 *   https://loisirs.ao.ca/fr/activites/index.cfm?ModeAffichage=liste
 *
 * Le site est généré côté serveur (ColdFusion / Radium Inc.) — pas de SaaS JS-rendered.
 * Le HTML contient directement les blocs d'activités identifiés par `id="evenement_NNN"`.
 * Chaque bloc expose : date+heure (près de l'icône calendrier), titre, lieu, et URL de détail.
 * La catégorie n'est pas exposée dans la liste — seulement dans la page de détail.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 8 * * *', // tous les jours à 8h
};

const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';
const BASE_URL = 'https://loisirs.ao.ca';
const ACTIVITES_URL = `${BASE_URL}/fr/activites/index.cfm?ModeAffichage=liste`;
const MAX_ACTIVITES = 8;

/**
 * Correspondance des mois en français vers numéro ISO (01–12).
 */
const MOIS_FR = {
  janvier: '01', jan: '01',
  février: '02', fev: '02', 'fevrier': '02',
  mars: '03',
  avril: '04',
  mai: '05',
  juin: '06',
  juillet: '07',
  août: '08', aout: '08',
  septembre: '09', sep: '09',
  octobre: '10', oct: '10',
  novembre: '11', nov: '11',
  décembre: '12', dec: '12', 'decembre': '12',
};

/**
 * Convertit une chaîne "26 Mai 18:30" ou "26 Mai 00:00" en { date: "2026-05-26", heure: "18h30" | null }.
 * L'année est déduite comme étant l'année courante (ou N+1 si le mois est passé).
 */
function parseDateLoisirs(raw) {
  if (!raw) return { date: null, heure: null };

  // Format attendu : "DD MMM HH:MM"  ex. "26 Mai 18:30"
  const m = raw.trim().match(/^(\d{1,2})\s+(\S+)\s+(\d{2}:\d{2})$/i);
  if (!m) return { date: null, heure: null };

  const [, jour, moisStr, heureRaw] = m;
  const moisKey = moisStr.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const moisNum = MOIS_FR[moisKey] ?? MOIS_FR[moisStr.toLowerCase()];
  if (!moisNum) return { date: null, heure: null };

  const now = new Date();
  let annee = now.getFullYear();

  // Si le mois est déjà passé dans l'année courante, c'est l'année prochaine
  const moisIndex = parseInt(moisNum, 10) - 1;
  const jourNum = parseInt(jour, 10);
  const dateCandidate = new Date(annee, moisIndex, jourNum);
  if (dateCandidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    annee += 1;
  }

  const date = `${annee}-${moisNum}-${jour.padStart(2, '0')}`;

  // Heure 00:00 = non précisée (minuit = début de journée par défaut dans le CMS)
  const heure = heureRaw === '00:00' ? null : heureRaw.replace(':', 'h');

  return { date, heure };
}

/**
 * Extrait les blocs d'activités depuis le HTML de la page liste.
 * Chaque bloc est délimité par `id="evenement_NNN"`.
 */
function extraireActivites(html) {
  const activites = [];

  // Découper le HTML par blocs d'événements
  const blocs = html.split(/<div\s+id="evenement_\d+"/i);

  for (let i = 1; i < blocs.length; i++) {
    const bloc = blocs[i];

    // Date et heure — juste avant conteneurInfo, près de icoCalendrier
    const dateMatch = bloc.match(
      /icoCalendrier[^"]*"[^>]*>\s*([^\n<]+)/i
    );
    const dateRaw = dateMatch ? dateMatch[1].trim() : null;
    const { date, heure } = parseDateLoisirs(dateRaw);

    // Titre et URL — premier lien dans h3
    const lienMatch = bloc.match(
      /href="(details\.cfm\?[^"]+)"[^>]*>\s*([^<]+)/i
    );
    if (!lienMatch) continue;
    const urlRelative = lienMatch[1];
    const titre = lienMatch[2].trim();

    // Lieu — span.strong
    const lieuMatch = bloc.match(/<span class="strong">([^<]+)<\/span>/i);
    const lieu = lieuMatch ? lieuMatch[1].trim() : null;

    // Catégorie — non exposée dans la liste, on laisse null
    const categorie = null;

    const url = `${BASE_URL}/fr/activites/${urlRelative}`;

    activites.push({ titre, date, heure, lieu, categorie, url });

    if (activites.length >= MAX_ACTIVITES) break;
  }

  return activites;
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[loisirs-ao] Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
    return new Response('Erreur de configuration', { status: 500 });
  }

  // 1. Télécharger la page des activités
  let html;
  try {
    const res = await fetch(ACTIVITES_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-CA,fr;q=0.9',
      },
    });
    if (!res.ok) {
      console.warn(`[loisirs-ao] Réponse HTTP inattendue: ${res.status} ${res.statusText}`);
      // Upsert tableau vide pour signaler le problème
      html = '';
    } else {
      html = await res.text();
    }
  } catch (err) {
    console.warn('[loisirs-ao] Impossible de récupérer la page:', err.message);
    html = '';
  }

  // 2. Extraire les activités
  let activites = [];
  if (html) {
    activites = extraireActivites(html);
    console.log(`[loisirs-ao] ${activites.length} activité(s) extraite(s)`);
  } else {
    console.warn('[loisirs-ao] Page vide ou inaccessible — upsert tableau vide');
  }

  // 3. Construire le payload
  const payload = {
    id: 1,
    activites,
    mis_a_jour: new Date().toISOString(),
  };

  // 4. Upsert dans Supabase
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_activites_loisirs`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error('[loisirs-ao] Erreur upsert Supabase:', err);
    return new Response('Erreur upsert Supabase', { status: 500 });
  }

  console.log('[loisirs-ao] Activités loisirs mises à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, activites: activites.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
