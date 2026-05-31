import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 10h
 * Scrape les communiqués de presse du CISSS de l'Abitibi-Témiscamingue
 * et upsert dans nouvelles_articles.
 *
 * Source : https://www.cisss-at.gouv.qc.ca/communiques-de-presse/
 * Structure DOM vérifiée (WordPress, rendu serveur) :
 *   section > div.col-xs-12
 *     Alternance de paragraphes :
 *       <p><strong>Le DD mois AAAA</strong></p>   ← date
 *       <p><a href="...">Titre du communiqué</a></p>  ← lien + titre
 *
 * Les liens pointent vers des PDF ou des pages HTML sous /partage/COMMUNIQUES_PRESSE/.
 * Aucune image ni résumé textuel disponible sur la page de liste.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 10 * * *',
};

const SOURCE = 'cisss-at';
const PAGE_URL = 'https://www.cisss-at.gouv.qc.ca/communiques-de-presse/';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

// Convertit "Le 12 mai 2026" → "2026-05-12"
function parseFrenchDate(text) {
  if (!text) return null;
  const match = text.trim().match(/^Le\s+(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
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

  // La zone de contenu est dans section > div.col-xs-12.col-sm-12.col-md-12.col-lg-12
  // Les communiqués sont dans des <p> alternant date (<strong>) et lien
  const contentDiv = root.querySelector('section > div.col-xs-12');
  if (!contentDiv) {
    console.warn(`[${SOURCE}] Zone de contenu introuvable — la structure de la page a peut-être changé.`);
    return new Response('Zone de contenu introuvable', { status: 200 });
  }

  const paragraphs = contentDiv.querySelectorAll('p');
  const articles = [];
  let currentDate = null;

  for (const p of paragraphs) {
    // Paragraphe de date : contient un <strong> avec "Le DD mois AAAA"
    const strong = p.querySelector('strong');
    if (strong) {
      const dateText = strong.text.trim();
      const parsed = parseFrenchDate(dateText);
      if (parsed) {
        currentDate = parsed;
        continue;
      }
    }

    // Paragraphe de lien : contient un <a> vers un communiqué
    const linkEl = p.querySelector('a');
    if (linkEl && currentDate) {
      const href = linkEl.getAttribute('href')?.trim();
      const titre = linkEl.text.trim();
      if (!href || !titre) continue;

      // Construire URL absolue si nécessaire
      const url = href.startsWith('http') ? href : `https://www.cisss-at.gouv.qc.ca${href}`;

      articles.push({
        source: SOURCE,
        titre,
        url,
        resume: null,
        date_publication: currentDate,
        image_url: null,
        mis_a_jour: new Date().toISOString(),
      });
    }
  }

  if (articles.length === 0) {
    console.warn(`[${SOURCE}] Aucun communiqué trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun communiqué', { status: 200 });
  }

  // Traiter les 10 plus récents (la page liste du plus récent au plus ancien)
  let count = 0;
  for (const article of articles.slice(0, 10)) {
    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
    count++;
  }

  console.log(`[${SOURCE}] ${count} communiqué(s) traité(s) sur ${articles.length} trouvé(s).`);
  return new Response(`OK: ${count} communiqués`, { status: 200 });
};

export default withSentry(__sentryHandler);
