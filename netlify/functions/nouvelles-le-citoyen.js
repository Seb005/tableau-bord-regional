import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 9h
 * Scrape les articles du Journal Le Citoyen et upsert dans nouvelles_articles.
 *
 * Source : https://journallecitoyen.com/ (plateforme Django/Wagtail)
 *
 * Structure DOM vérifiée :
 *   <article>                               — conteneur (peut contenir plusieurs cartes)
 *     <div class="groupe imageArticle"
 *          style="background-image: url(/media/images/...);">
 *       <a href="/articles/article_XXXX/">
 *         <div class="titreDecoration">
 *           <h1>Titre de l'article</h1>
 *           <p class="credit">
 *             <span class="datepublication">26 mai 2026</span>
 *           </p>
 *         </div>
 *       </a>
 *     </div>
 *   </article>
 *
 * Les URLs d'articles sont relatives → préfixées avec https://journallecitoyen.com
 * Les images sont également relatives → préfixées avec https://journallecitoyen.com
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

import { parse } from 'node-html-parser';

export const config = {
  schedule: '0 9 * * *',
};

const SOURCE = 'le-citoyen';
const PAGE_URL = 'https://journallecitoyen.com/';
const BASE_URL = 'https://journallecitoyen.com';
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';
const MAX_ITEMS = 10;

// Mois français → numéro (pour parser "26 mai 2026")
const MOIS_FR = {
  janvier: '01', février: '02', mars: '03', avril: '04',
  mai: '05', juin: '06', juillet: '07', août: '08',
  septembre: '09', octobre: '10', novembre: '11', décembre: '12',
};

function parseDateCitoyen(texte) {
  // Format : "26 mai 2026"
  const m = texte.trim().match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const jour = m[1].padStart(2, '0');
  const mois = MOIS_FR[m[2].toLowerCase()];
  const annee = m[3];
  if (!mois) return null;
  return `${annee}-${mois}-${jour}T00:00:00Z`;
}

function extractImageFromStyle(styleAttr) {
  if (!styleAttr) return null;
  // style="background-image: url(/media/images/...);"
  const m = styleAttr.match(/url\(([^)]+)\)/);
  if (!m) return null;
  const path = m[1].trim().replace(/['"]/g, '');
  if (path.startsWith('http')) return path;
  if (path.startsWith('/')) return `${BASE_URL}${path}`;
  return null;
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
    return false;
  }
  return true;
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(`[${SOURCE}] Variables d'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)`);
    return new Response('Erreur de configuration', { status: 500 });
  }

  // 1. Télécharger la page d'accueil
  let html;
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[${SOURCE}] Erreur de téléchargement: ${err.message}`);
    return new Response('Erreur de téléchargement', { status: 502 });
  }

  // 2. Parser le HTML et extraire les cartes d'articles
  const root = parse(html);

  // Chaque <article> peut contenir plusieurs cartes .groupe.imageArticle
  const cartes = root.querySelectorAll('div.groupe.imageArticle');

  if (cartes.length === 0) {
    console.warn(`[${SOURCE}] Aucune carte d'article trouvée — la structure de la page a peut-être changé.`);
    return new Response('Aucun article', { status: 200 });
  }

  // Déduplication par URL (plusieurs sections peuvent répéter les mêmes articles)
  const seen = new Set();
  const articles = [];

  for (const carte of cartes) {
    const linkEl = carte.querySelector('a[href]');
    const href = linkEl?.getAttribute('href')?.trim();
    if (!href || !href.startsWith('/articles/')) continue;

    const url = `${BASE_URL}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const titre = carte.querySelector('h1')?.text?.trim() || null;
    if (!titre) continue;

    const dateTexte = carte.querySelector('span.datepublication')?.text?.trim() || null;
    const date_publication = dateTexte ? parseDateCitoyen(dateTexte) : null;

    const styleAttr = carte.getAttribute('style') || '';
    const image_url = extractImageFromStyle(styleAttr);

    articles.push({
      source: SOURCE,
      titre,
      url,
      resume: null,
      date_publication,
      image_url,
      mis_a_jour: new Date().toISOString(),
    });

    if (articles.length >= MAX_ITEMS) break;
  }

  console.log(`[${SOURCE}] ${articles.length} article(s) à upsert`);

  // 3. Upsert dans Supabase
  let succes = 0;
  let erreurs = 0;

  for (const article of articles) {
    const ok = await upsertArticle(SUPABASE_URL, SUPABASE_SERVICE_KEY, article);
    if (ok) succes++; else erreurs++;
  }

  console.log(`[${SOURCE}] Terminé — ${succes} succès, ${erreurs} erreur(s)`);
  return new Response(
    JSON.stringify({ ok: true, source: SOURCE, succes, erreurs }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
