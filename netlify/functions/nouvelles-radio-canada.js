import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 4 heures
 * Récupère les nouvelles Radio-Canada Abitibi-Témiscamingue via RSS
 * et upsert dans la table `nouvelles_articles` dans Supabase.
 *
 * Source : https://ici.radio-canada.ca/info/rss/abitibi-temiscamingue/en-continu
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import RSSParser from 'rss-parser';

export const config = {
  schedule: '0 */4 * * *',
};

const SOURCE = 'radio-canada';
const RSS_URL = 'https://ici.radio-canada.ca/info/rss/abitibi-temiscamingue/en-continu';
const MAX_ITEMS = 10;

const MOTS_REGION = [
  'abitibi', 'témiscamingue', 'temiscamingue',
  'la sarre', 'lasarre', 'amos', 'rouyn', 'noranda', "val-d'or", 'val d\'or', 'valdor',
  'malartic', 'senneterre', 'barraute', 'macamic', 'palmarolle', 'poularies',
  'duparquet', 'gallichan', 'authier', 'clerval', 'dupuy', 'taschereau',
  'launay', 'berry', 'la reine', 'rapide-danseur', 'pikogan', 'lac-simon',
  'kitcisakik', 'winneway', 'kebaowek', 'timiskaming', 'kipawa',
  'ville-marie', 'témiscaming', 'lorrainville', 'angliers', 'nédélec',
  'chibougamau', 'chapais', 'lebel-sur-quévillon', 'matagami',
  'harricana', 'obedjiwan', 'lac abitibi',
  'onimiki', 'long point first nation', 'wahgoshig',
  'saint-marc-de-figuery', 'st-marc-de-figuery', 'preissac', 'rivière-héva',
  'cisss', 'cjeao', 'mrcao', 'uqat', 'fgmat',
];

function estPertinent(item) {
  const texte = [item.title, item.contentSnippet, item.content, item.link]
    .filter(Boolean).join(' ').toLowerCase();
  return MOTS_REGION.some(mot => texte.includes(mot));
}

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

  const allItems = feed.items ?? [];
  const items = allItems.filter(estPertinent).slice(0, MAX_ITEMS);
  const exclus = allItems.length - items.length;
  console.log(`[${SOURCE}] ${allItems.length} article(s) dans le flux, ${items.length} pertinent(s), ${exclus} exclu(s)`);

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
