import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 9h
 * Scrape les actualités de la MRC d'Abitibi-Ouest et upsert dans nouvelles_articles.
 *
 * Source : https://www.mrcao.qc.ca/fr/actualites/
 * Structure DOM vérifiée :
 *   div.fiche
 *     h3 > a[href]                             → lien relatif (ex. "3537") + titre
 *     img[src]                                 → image relative (../../images/...)
 *     p.date                                   → date texte ex. "Publié le Lundi, 25 Mai 2026"
 *
 * Les liens sont des IDs numériques relatifs à /fr/actualites/
 * ex. href="3537" → https://www.mrcao.qc.ca/fr/actualites/3537
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 9 * * *',
};

const SOURCE = 'mrcao';
const PAGE_URL = 'https://www.mrcao.qc.ca/fr/actualites/';
const BASE_URL = 'https://www.mrcao.qc.ca';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

// Mois français → numéro (pour parser "Publié le Lundi, 25 Mai 2026")
const MOIS_FR = {
  janvier: '01', février: '02', mars: '03', avril: '04',
  mai: '05', juin: '06', juillet: '07', août: '08',
  septembre: '09', octobre: '10', novembre: '11', décembre: '12',
};

function parseDateMrcao(texte) {
  // Format : "Publié le Lundi, 25 Mai 2026"
  const m = texte.trim().match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const jour = m[1].padStart(2, '0');
  const mois = MOIS_FR[m[2].toLowerCase()];
  const annee = m[3];
  if (!mois) return null;
  return `${annee}-${mois}-${jour}`;
}

function buildUrl(href) {
  if (!href || href === '#') return null;
  // Numeric ID → absolute URL
  if (/^\d+$/.test(href)) return `${PAGE_URL}${href}`;
  // Relative path
  if (href.startsWith('/')) return `${BASE_URL}${href}`;
  // Already absolute
  if (href.startsWith('http')) return href;
  return `${PAGE_URL}${href}`;
}

function buildImageUrl(src) {
  if (!src) return null;
  // src like "../../images/actualites/images/petites/foo.png"
  // Resolve relative to page URL
  if (src.startsWith('http')) return src;
  // Normalize: remove ../../ prefix relative to /fr/actualites/
  // /fr/actualites/ → go up 2 = / → then images/...
  const cleaned = src.replace(/^\.\.\/\.\.\//, '/');
  return `${BASE_URL}${cleaned}`;
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
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[${SOURCE}] Erreur de téléchargement : ${err.message}`);
    return new Response('Erreur de téléchargement', { status: 502 });
  }

  const root = parse(html);
  const fiches = root.querySelectorAll('div.fiche');

  if (fiches.length === 0) {
    console.warn(`[${SOURCE}] Aucun article trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun article', { status: 200 });
  }

  const now = new Date().toISOString();
  let count = 0;

  for (const fiche of fiches.slice(0, 10)) {
    const linkEl = fiche.querySelector('h3 > a');
    const href = linkEl?.getAttribute('href')?.trim();
    const url = buildUrl(href);
    if (!url) continue;

    const titre = linkEl?.text?.trim() || null;

    const dateTexte = fiche.querySelector('p.date')?.text?.trim() || null;
    const date_publication = dateTexte ? parseDateMrcao(dateTexte) : null;

    const imgSrc = fiche.querySelector('img')?.getAttribute('src') || null;
    const image_url = buildImageUrl(imgSrc);

    const article = {
      source: SOURCE,
      titre,
      url,
      resume: null,
      date_publication,
      image_url,
      mis_a_jour: now,
    };

    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
    count++;
  }

  console.log(`[${SOURCE}] ${count} article(s) traité(s).`);
  return new Response(`OK: ${count} articles`, { status: 200 });
};

export default withSentry(__sentryHandler);
