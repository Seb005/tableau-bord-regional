import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 9h
 * Scrape les actualités du CSSLA et upsert dans nouvelles_articles.
 *
 * Source : https://cssla.gouv.qc.ca/ (page d'accueil — seule page avec liens permanents)
 * Structure DOM vérifiée sur la page d'accueil :
 *   span.dateendroit
 *     span.date                                 → date texte ex. "18 février 2026"
 *   a.blog-post-list-title[href]               → lien absolu + titre
 *
 * Note : la page /actualites/ liste les articles sans liens permanents (juste des PDF).
 *        La page d'accueil expose 3 articles récents avec leurs liens.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 9 * * *',
};

const SOURCE = 'cssla';
const PAGE_URL = 'https://cssla.gouv.qc.ca/';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

// Mois français → numéro (pour parser "18 février 2026")
const MOIS_FR = {
  janvier: '01', février: '02', mars: '03', avril: '04',
  mai: '05', juin: '06', juillet: '07', août: '08',
  septembre: '09', octobre: '10', novembre: '11', décembre: '12',
};

function parseDateFr(texte) {
  // Format : "18 février 2026"
  const m = texte.trim().match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (!m) return null;
  const jour = m[1].padStart(2, '0');
  const mois = MOIS_FR[m[2].toLowerCase()];
  const annee = m[3];
  if (!mois) return null;
  return `${annee}-${mois}-${jour}`;
}

async function upsertArticle(supabaseUrl, serviceKey, article) {
  const res = await fetch(`${supabaseUrl}/rest/v1/nouvelles_articles`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(article),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[${SOURCE}] Upsert failed for ${article.url}: ${res.status} ${body}`);
  }
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(`[${SOURCE}] Variables d'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)`);
    return new Response('Erreur de configuration', { status: 500 });
  }

  let html;
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[${SOURCE}] Erreur de téléchargement : ${err.message}`);
    return new Response('Erreur de téléchargement', { status: 502 });
  }

  const root = parse(html);

  // Trouver tous les liens d'articles (a.blog-post-list-title)
  const linkEls = root.querySelectorAll('a.blog-post-list-title');

  if (linkEls.length === 0) {
    console.warn(`[${SOURCE}] Aucun article trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun article', { status: 200 });
  }

  // Récupérer les blocs dateendroit pour associer dates aux articles
  // Structure : span.dateendroit > (texte "Publiée le") > span.date
  // Suivi directement d'un a.blog-post-list-title dans le même col-12
  const dateEls = root.querySelectorAll('span.date');

  const now = new Date().toISOString();
  let count = 0;

  for (let i = 0; i < Math.min(linkEls.length, 10); i++) {
    const linkEl = linkEls[i];
    const url = linkEl.getAttribute('href')?.trim();
    if (!url || !url.startsWith('http')) continue;

    const titre = linkEl.text?.trim() || null;
    const dateTexte = dateEls[i]?.text?.trim() || null;
    const date_publication = dateTexte ? parseDateFr(dateTexte) : null;

    const article = {
      source: SOURCE,
      titre,
      url,
      resume: null,
      date_publication,
      image_url: null,
      mis_a_jour: now,
    };

    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
    count++;
  }

  console.log(`[${SOURCE}] ${count} article(s) traité(s).`);
  return new Response(`OK: ${count} articles`, { status: 200 });
};

export default withSentry(__sentryHandler);
