import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 10h
 * Scrape les avis municipaux du portail citoyen de La Sarre et upsert dans nouvelles_articles.
 *
 * Source : https://citoyen.lasarre.ca/avis
 * Structure DOM vérifiée (rendu serveur, pas de JS requis) :
 *   ul.notices-list__list
 *     li.notices-list__list-item
 *       a.notice-card[href]                      → lien absolu
 *       span.notice-card__surtitle               → catégorie + plage de dates (ex: "Urgences et sécurité publique / Du 22 mai 2026 ...")
 *       h2.notice-card__title                    → titre de l'avis
 *
 * Note : La page affiche uniquement les avis EN COURS. Aucune image ni description longue.
 * La date est extraite du surtitle ("Du DD mois AAAA à HH h ...").
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 10 * * *',
};

const SOURCE = 'avis-lasarre';
const PAGE_URL = 'https://citoyen.lasarre.ca/avis';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

// Convertit "Du 22 mai 2026 à 10 h 30 au 12 juin 2026 à 16 h" → "2026-05-22"
function parseSurtitleDate(surtitle) {
  if (!surtitle) return null;
  // Cherche la première date "Du DD mois AAAA"
  const match = surtitle.match(/Du\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (!match) return null;
  const [, day, monthFr, year] = match;
  const months = {
    janvier: '01', février: '02', mars: '03', avril: '04',
    mai: '05', juin: '06', juillet: '07', août: '08',
    septembre: '09', octobre: '10', novembre: '11', décembre: '12',
  };
  const month = months[monthFr.toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
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
  const items = root.querySelectorAll('li.notices-list__list-item');

  if (items.length === 0) {
    console.warn(`[${SOURCE}] Aucun avis trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun avis', { status: 200 });
  }

  const now = new Date().toISOString();
  let count = 0;

  for (const el of items.slice(0, 10)) {
    const linkEl = el.querySelector('a.notice-card');
    const url = linkEl?.getAttribute('href')?.trim();
    if (!url) continue;

    const titre = el.querySelector('h2.notice-card__title')?.text?.trim() || null;
    if (!titre) continue;

    // Le surtitle contient la catégorie et la plage de dates
    const surtitle = el.querySelector('span.notice-card__surtitle')?.text?.trim() || null;
    const date_publication = parseSurtitleDate(surtitle);

    // Le surtitle sert aussi de résumé contextuel (catégorie + période)
    const resume = surtitle || null;

    const article = {
      source: SOURCE,
      titre,
      url,
      resume,
      date_publication,
      image_url: null,
      mis_a_jour: now,
    };

    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
    count++;
  }

  console.log(`[${SOURCE}] ${count} avis traité(s).`);
  return new Response(`OK: ${count} avis`, { status: 200 });
};

export default withSentry(__sentryHandler);
