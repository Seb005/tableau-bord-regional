import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — toutes les 6 heures
 * Scrape les offres d'emploi actives d'un portail Jobstat
 * et upsert dans nouvelles_emplois (ligne unique id=1).
 *
 * Conçu pour les portails Jobstat (ex: jobstat.ca). Adapter si besoin pour un autre fournisseur.
 * Structure DOM Jobstat :
 *   p.h5.card-title          → "Emploi(s) trouvé(s) : 63"
 *   table tbody tr           → colonnes : id | titre | employeur | ville | date | lien
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   JOBS_PORTAL_URL      — URL complète du portail Jobstat à scraper
 *   JOBS_USER_AGENT      — (optionnel) User-Agent à utiliser, sinon générique
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 */6 * * *',
};

const SOURCE = 'jobs-portal';
const PAGE_URL = process.env.JOBS_PORTAL_URL;
const USER_AGENT = process.env.JOBS_USER_AGENT
  || 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

// Cookie de tri : offres par ID décroissant (les plus récentes en premier)
const SORT_COOKIE = 'offers_sortfield=id; offers_sortside=desc';

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(`[${SOURCE}] Variables d'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)`);
    return new Response('Erreur de configuration', { status: 500 });
  }

  if (!PAGE_URL) {
    console.error(`[${SOURCE}] JOBS_PORTAL_URL non défini — widget emplois désactivé`);
    return new Response('JOBS_PORTAL_URL non configuré', { status: 200 });
  }

  // --- Téléchargement de la page ---
  let html;
  try {
    const res = await fetch(PAGE_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: SORT_COOKIE,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[${SOURCE}] Erreur de téléchargement : ${err.message}`);
    return new Response('Erreur de téléchargement', { status: 502 });
  }

  const root = parse(html);

  // --- Extraction du total d'offres ---
  // Texte attendu : "Emploi(s) trouvé(s) : 63"
  const countEl = root.querySelector('p.h5.card-title, .h5.card-title, p.card-title');
  let nb_offres = 0;
  if (countEl) {
    const m = countEl.text.match(/:\s*(\d+)/);
    if (m) nb_offres = parseInt(m[1], 10);
  }

  if (nb_offres === 0) {
    console.warn(`[${SOURCE}] Impossible d'extraire le nombre d'offres — la structure a peut-être changé.`);
  }

  // --- Extraction des offres ---
  const rows = root.querySelectorAll('table tbody tr');
  const top_emplois = [];

  for (const row of rows) {
    if (top_emplois.length >= 5) break;

    const cells = row.querySelectorAll('td');
    if (cells.length < 5) continue;

    const titre = cells[1]?.text?.trim() || null;
    const employeur = cells[2]?.text?.trim() || null;
    const ville = cells[3]?.text?.trim() || null;
    const url = cells[cells.length - 1]?.querySelector('a')?.getAttribute('href')?.trim() || null;

    if (!titre) continue;

    top_emplois.push({ titre, employeur, ville, url });
  }

  if (top_emplois.length === 0) {
    console.warn(`[${SOURCE}] Aucune offre trouvée dans le tableau — la structure a peut-être changé.`);
  }

  console.log(`[${SOURCE}] ${nb_offres} offre(s) active(s), ${top_emplois.length} extraite(s).`);

  // --- Upsert dans Supabase ---
  const res = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_emplois`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      id: 1,
      nb_offres,
      top_emplois,
      mis_a_jour: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[${SOURCE}] Upsert Supabase échoué : ${res.status} ${body}`);
    return new Response('Erreur Supabase', { status: 502 });
  }

  return new Response(`OK: ${nb_offres} offres, ${top_emplois.length} en vedette`, { status: 200 });
};

export default withSentry(__sentryHandler);
