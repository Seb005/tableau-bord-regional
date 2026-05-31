import { withSentry } from '../lib/sentry.js';
import { corsHeadersFor } from '../lib/cors.js';
/**
 * Proxy pour la page Archives — articles de plus de 30 jours.
 * Pagination simple : ?page=1, ?page=2, etc. (50 articles par page).
 */

const PAGE_SIZE = 50;

const __sentryHandler = async (req) => {
  const corsHeaders = corsHeadersFor(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ error: 'Configuration manquante' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const offset = (page - 1) * PAGE_SIZE;

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const query =
    `/rest/v1/nouvelles_articles` +
    `?select=source,titre,url,resume,date_publication,image_url` +
    `&date_publication=lt.${cutoff}` +
    `&order=date_publication.desc` +
    `&limit=${PAGE_SIZE}` +
    `&offset=${offset}`;

  try {
    const res = await fetch(`${SUPABASE_URL}${query}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'count=exact',
      },
    });

    const contentRange = res.headers.get('content-range') || '';
    const total = parseInt(contentRange.split('/')[1] || '0', 10);
    const articles = await res.json();

    return new Response(
      JSON.stringify({
        articles: Array.isArray(articles) ? articles : [],
        page,
        page_size: PAGE_SIZE,
        total,
        total_pages: Math.ceil(total / PAGE_SIZE),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600',
          ...corsHeaders,
        },
      }
    );
  } catch (err) {
    console.error('Erreur archives:', err);
    return new Response(JSON.stringify({ error: 'Erreur lors de la récupération' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
};

export const config = {
  path: '/.netlify/functions/nouvelles-archives',
};

export default withSentry(__sentryHandler);
