import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée — tous les jours à 9h
 * Récupère les nouvelles de l'UQAT via leur API JSON interne
 * et upsert dans la table `nouvelles_articles` dans Supabase.
 *
 * Source : https://www.uqat.ca/nouvelles-et-evenements/
 * API JSON : https://www.uqat.ca/webapi/api/news/search/?language=fr
 *
 * Structure de l'objet JSON :
 *   id              — identifiant numérique (ex. 3298)
 *   title           — titre de l'article
 *   summary         — résumé texte brut
 *   publishedDate   — ex. "2026-05-25T00:00:00"
 *   imageThumb      — nom de fichier relatif (ex. "photo-small.jpg")
 *                     URL complète : /resources/medias/nouvelles-evenements/{imageThumb}
 *   Article URL     : /nouvelles-et-evenements/nouvelle/?id={id}
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 9 * * *',
};

const SOURCE = 'uqat';
const API_URL = 'https://www.uqat.ca/webapi/api/news/search/?language=fr';
const BASE_URL = 'https://www.uqat.ca';
const ARTICLE_BASE = '/nouvelles-et-evenements/nouvelle/?id=';
const IMAGE_BASE = '/resources/medias/nouvelles-evenements/';
const MAX_ITEMS = 10;
const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(`[${SOURCE}] Variables d'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)`);
    return new Response('Erreur de configuration', { status: 500 });
  }

  // 1. Récupérer le JSON de l'API UQAT
  let items;
  try {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = await res.json();
  } catch (err) {
    console.error(`[${SOURCE}] Erreur de récupération API: ${err.message}`);
    return new Response('Erreur de récupération', { status: 502 });
  }

  if (!Array.isArray(items) || items.length === 0) {
    console.warn(`[${SOURCE}] Aucun article retourné par l'API`);
    return new Response('Aucun article', { status: 200 });
  }

  console.log(`[${SOURCE}] ${Math.min(items.length, MAX_ITEMS)} article(s) à traiter (sur ${items.length} total)`);

  const now = new Date().toISOString();
  let succes = 0;
  let erreurs = 0;

  // 2. Upsert chaque article dans Supabase
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (!item.id) continue;

    const url = `${BASE_URL}${ARTICLE_BASE}${item.id}`;

    const resume = (item.summary || '')
      .replace(/<[^>]*>/g, '')
      .trim()
      .slice(0, 300) || null;

    const image_url = item.imageThumb
      ? `${BASE_URL}${IMAGE_BASE}${item.imageThumb}`
      : null;

    // publishedDate est au format "2026-05-25T00:00:00" (sans timezone → UTC)
    const date_publication = item.publishedDate
      ? item.publishedDate.endsWith('Z')
        ? item.publishedDate
        : `${item.publishedDate}Z`
      : null;

    const article = {
      source: SOURCE,
      titre: item.title ?? null,
      url,
      resume,
      date_publication,
      image_url,
      mis_a_jour: now,
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
