import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 10h
 * Scrape les événements de la page Nouvelles de l'École de musique d'Abitibi-Ouest
 * et upsert dans la table `nouvelles_articles` dans Supabase.
 *
 * Source : https://ecolemusiqueao.ca/nouvelles/
 *
 * Note : Ce site est un WordPress à page unique (pas de blog). La page Nouvelles
 * contient une liste d'événements/concerts en texte structuré (h2, h3, h5) dans
 * un builder Divi (.et_pb_text_inner). Chaque h3 représente un événement distinct.
 * On crée un article synthétique par événement, avec une URL construite avec un
 * fragment (#slug) pour la déduplication.
 *
 * Structure DOM vérifiée :
 *   .et_pb_text_inner
 *     h2                    → titre de section (ex. "Concerts 2024-2025")
 *     h3                    → titre d'événement (ex. "Spectacle de Noel")
 *     h5 (1..n)             → détails de l'événement (date/lieu)
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 10 * * *',
};

const SOURCE = 'ecole-musique-ao';
const PAGE_URL = 'https://ecolemusiqueao.ca/nouvelles/';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

/** Convertit un titre en slug URL-safe pour le fragment */
function toSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

  // La page Nouvelles utilise le builder Divi ; le contenu est dans .et_pb_text_inner
  // On cherche le premier bloc qui contient des h3 (les événements)
  const contentBlocks = root.querySelectorAll('.et_pb_text_inner');
  let mainBlock = null;
  for (const block of contentBlocks) {
    if (block.querySelectorAll('h3').length > 0) {
      mainBlock = block;
      break;
    }
  }

  if (!mainBlock) {
    console.warn(`[${SOURCE}] Aucun bloc de contenu trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun contenu', { status: 200 });
  }

  // Extraire le titre de section (h2) pour contexte
  const sectionTitle = mainBlock.querySelector('h2')?.text?.trim() || 'Nouvelles';

  // Extraire les événements : chaque h3 = un événement, suivi de h5 = détails
  const h3s = mainBlock.querySelectorAll('h3');
  if (h3s.length === 0) {
    console.warn(`[${SOURCE}] Aucun événement (h3) trouvé dans le bloc de contenu.`);
    return new Response('Aucun événement', { status: 200 });
  }

  const now = new Date().toISOString();
  const articles = [];

  for (const h3 of h3s) {
    const titre = h3.text?.trim();
    if (!titre) continue;

    // Collecter les h5 qui suivent ce h3 jusqu'au prochain h3 ou fin de bloc
    const details = [];
    let sibling = h3.nextElementSibling;
    while (sibling && sibling.tagName !== 'H3') {
      const text = sibling.text?.trim();
      if (text && text !== ' ') details.push(text);
      sibling = sibling.nextElementSibling;
    }

    const resume = details.length > 0 ? details.join(' · ') : null;

    // URL unique : page + fragment basé sur le slug du titre
    const slug = toSlug(titre);
    const url = `${PAGE_URL}#${slug}`;

    articles.push({
      source: SOURCE,
      titre: `${sectionTitle} — ${titre}`,
      url,
      resume,
      date_publication: null, // dates non structurées dans ce site
      image_url: null,
      mis_a_jour: now,
    });
  }

  for (const article of articles.slice(0, 10)) {
    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
  }

  console.log(`[${SOURCE}] ${articles.length} événement(s) traité(s).`);
  return new Response(`OK: ${articles.length} articles`, { status: 200 });
};

export default withSentry(__sentryHandler);
