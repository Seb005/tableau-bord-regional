import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 11h
 * Scrape les communiqués de presse d'Orezone Mining Corporation
 * et upsert dans la table `nouvelles_articles` dans Supabase.
 *
 * Source : https://orezone.com/press-releases/
 *
 * Note : Le contenu est en anglais — Orezone est une société minière internationale
 * dont la mine Bomboré est au Burkina Faso et la mine Casa Berardi est au Québec.
 * La présence de cette source dans le fil local se justifie par l'intérêt régional
 * pour l'industrie minière en Abitibi-Ouest.
 *
 * Structure DOM vérifiée (WordPress Block Editor) :
 *   ul.wp-block-post-template
 *     li.wp-block-post               → conteneur de chaque communiqué
 *       .wp-block-post-date time[datetime]  → date ISO (ex. "2026-05-19T04:50:03-07:00")
 *       .wp-block-post-title a[href]        → titre + lien absolu
 *
 * Pas de résumé sur la page de liste — on laisse `resume` à null.
 * Pas d'image dans la liste — on laisse `image_url` à null.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 11 * * *',
};

const SOURCE = 'orezone';
const PAGE_URL = 'https://orezone.com/press-releases/';
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
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[${SOURCE}] Erreur de téléchargement : ${err.message}`);
    return new Response('Erreur de téléchargement', { status: 502 });
  }

  const root = parse(html);

  // Sélectionner tous les communiqués (li.wp-block-post)
  const posts = root.querySelectorAll('li.wp-block-post');

  if (posts.length === 0) {
    console.warn(`[${SOURCE}] Aucun communiqué trouvé — la structure de la page a peut-être changé.`);
    return new Response('Aucun article', { status: 200 });
  }

  const now = new Date().toISOString();
  const articles = [];

  for (const post of posts) {
    // Titre et lien
    const titleEl = post.querySelector('.wp-block-post-title a');
    const titre = titleEl?.text?.trim() || null;
    const url = titleEl?.getAttribute('href') || null;
    if (!url || !titre) continue;

    // Date : attribut datetime de <time> dans .wp-block-post-date
    const datetime = post.querySelector('.wp-block-post-date time')?.getAttribute('datetime') || null;
    // Convertir en date ISO (YYYY-MM-DD) si disponible
    const date_publication = datetime ? datetime.substring(0, 10) : null;

    articles.push({
      source: SOURCE,
      titre,
      url,
      resume: null,      // pas de résumé dans la liste
      date_publication,
      image_url: null,   // pas d'image dans la liste
      mis_a_jour: now,
    });
  }

  for (const article of articles.slice(0, 10)) {
    if (!article.url) continue;
    await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
  }

  console.log(`[${SOURCE}] ${Math.min(articles.length, 10)} communiqué(s) traité(s) (${articles.length} trouvé(s)).`);
  return new Response(`OK: ${articles.length} articles`, { status: 200 });
};

export default withSentry(__sentryHandler);
