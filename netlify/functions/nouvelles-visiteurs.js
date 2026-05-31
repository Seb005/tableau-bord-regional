import { withSentry } from '../lib/sentry.js';
import { corsHeadersFor } from '../lib/cors.js';
/**
 * Proxy vers l'API Plausible pour récupérer le nombre de visiteurs en temps réel.
 * On expose seulement le compteur (pas de données personnelles).
 *
 * Variables d'environnement requises :
 *   PLAUSIBLE_API_KEY  — clé API Plausible (Settings → API Keys)
 *   PLAUSIBLE_SITE_ID  — domaine enregistré dans Plausible
 */

const __sentryHandler = async (req) => {
  const headers = {
    ...corsHeadersFor(req, 'GET, OPTIONS'),
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=30',
  };

  const API_KEY = process.env.PLAUSIBLE_API_KEY;
  const SITE_ID = process.env.PLAUSIBLE_SITE_ID;

  if (!API_KEY || !SITE_ID) {
    return new Response(JSON.stringify({ error: 'PLAUSIBLE non configuré', visiteurs: null }), {
      status: 200,
      headers,
    });
  }

  try {
    const url = `https://plausible.io/api/v1/stats/realtime/visitors?site_id=${encodeURIComponent(SITE_ID)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Plausible API error:', res.status, text);
      return new Response(JSON.stringify({ error: `Plausible ${res.status}`, visiteurs: null }), { status: 200, headers });
    }

    // Plausible retourne juste un nombre (entier en plain text)
    const body = await res.text();
    const visiteurs = parseInt(body.trim(), 10);

    return new Response(JSON.stringify({
      visiteurs: isNaN(visiteurs) ? null : visiteurs,
      site: SITE_ID,
    }), { status: 200, headers });
  } catch (err) {
    console.error('Plausible fetch exception:', err);
    return new Response(JSON.stringify({ error: 'Erreur réseau', visiteurs: null }), { status: 200, headers });
  }
};

export const config = {
  path: '/.netlify/functions/nouvelles-visiteurs',
};

export default withSentry(__sentryHandler);
