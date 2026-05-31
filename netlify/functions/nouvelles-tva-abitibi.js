import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 4 heures
 * Récupère les nouvelles TVA Abitibi via RSS (WordPress)
 * et upsert dans la table `nouvelles_articles` dans Supabase.
 *
 * Source : https://tvaabitibi.ca/feed/
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import RSSParser from 'rss-parser';

export const config = {
  schedule: '0 */4 * * *',
};

const SOURCE = 'tva-abitibi';
const RSS_URL = 'https://tvaabitibi.ca/feed/';
const MAX_ITEMS = 10;

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(`[${SOURCE}] Variables d'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)`);
    return new Response('Erreur de configuration', { status: 500 });
  }

  // 1. Parser le flux RSS
  let feed;
  try {
    const parser = new RSSParser();
    feed = await parser.parseURL(RSS_URL);
  } catch (err) {
    console.error(`[${SOURCE}] Impossible de parser le flux RSS (${RSS_URL}):`, err.message);
    return new Response('Erreur récupération RSS', { status: 502 });
  }

  const items = (feed.items ?? []).slice(0, MAX_ITEMS);
  console.log(`[${SOURCE}] ${items.length} article(s) récupéré(s)`);

  // 2. Upsert chaque article dans Supabase
  let succes = 0;
  let erreurs = 0;

  for (const item of items) {
    const url = item.link ?? null;
    if (!url) {
      console.warn(`[${SOURCE}] Article sans URL ignoré: ${item.title}`);
      continue;
    }

    const resume = (item.contentSnippet || item.content || '')
      .replace(/<[^>]*>/g, '')
      .trim()
      .slice(0, 300) || null;

    const article = {
      source: SOURCE,
      titre: item.title ?? null,
      url,
      resume,
      date_publication: item.isoDate || item.pubDate || null,
      image_url: item.enclosure?.url ?? null,
      mis_a_jour: new Date().toISOString(),
    };

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_articles`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(article),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[${SOURCE}] Erreur upsert pour "${url}": ${res.status} ${errText}`);
        erreurs++;
      } else {
        succes++;
      }
    } catch (err) {
      console.error(`[${SOURCE}] Exception upsert pour "${url}":`, err.message);
      erreurs++;
    }
  }

  console.log(`[${SOURCE}] Terminé — ${succes} succès, ${erreurs} erreur(s)`);
  return new Response(
    JSON.stringify({ ok: true, source: SOURCE, succes, erreurs }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
