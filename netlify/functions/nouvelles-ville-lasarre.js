import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 9h
 * Scrape les actualités de la Ville de La Sarre et upsert dans nouvelles_articles.
 *
 * Source : https://www.lasarre.ca/actualites/
 * Structure DOM vérifiée :
 *   article.post-item
 *     a.post-item__inner[href]               → lien absolu
 *     [data-background-image-url]            → image (sur article ou div.post-item__thumbnail)
 *     time.post-metas__date[datetime]        → date ISO
 *     h2.post-item__title                    → titre
 *     div.post-item__excerpt                 → résumé (peut être vide)
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 9 * * *',
};

const SOURCE = 'ville-lasarre';
const PAGE_URL = 'https://www.lasarre.ca/actualites/';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

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
  const articles = root.querySelectorAll('article.post-item');

  if (articles.length === 0) {
    console.warn(`[${SOURCE}] Aucun article trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun article', { status: 200 });
  }

  const now = new Date().toISOString();
  let count = 0;

  for (const el of articles.slice(0, 10)) {
    const linkEl = el.querySelector('a.post-item__inner');
    const url = linkEl?.getAttribute('href')?.trim();
    if (!url) continue;

    const titre = el.querySelector('h2.post-item__title')?.text?.trim() || null;
    const resume = el.querySelector('div.post-item__excerpt')?.text?.trim() || null;

    // La date est dans <time datetime="2026-05-25T15:15:39+00:00">
    const timeEl = el.querySelector('time.post-metas__date');
    const datetimeAttr = timeEl?.getAttribute('datetime');
    let date_publication = null;
    if (datetimeAttr) {
      const d = new Date(datetimeAttr);
      if (!isNaN(d)) date_publication = d.toISOString().split('T')[0];
    }

    // L'image est dans data-background-image-url sur l'article ou sur la div thumbnail
    const imageUrl =
      el.getAttribute('data-background-image-url') ||
      el.querySelector('[data-background-image-url]')?.getAttribute('data-background-image-url') ||
      null;

    const article = {
      source: SOURCE,
      titre,
      url,
      resume: resume || null,
      date_publication,
      image_url: imageUrl || null,
      mis_a_jour: now,
    };

    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
    count++;
  }

  console.log(`[${SOURCE}] ${count} article(s) traité(s).`);
  return new Response(`OK: ${count} articles`, { status: 200 });
};

export default withSentry(__sentryHandler);
