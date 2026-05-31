import { withSentry } from '../lib/sentry.js';
import { corsHeadersFor } from '../lib/cors.js';
/**
 * Réception et lecture des commentaires/suggestions du tableau de bord.
 *   GET  → liste les 20 derniers commentaires publiés
 *   POST → soumet un nouveau commentaire (nom, courriel optionnel, message)
 *
 * Anti-spam :
 *   - Honeypot "website" : si rempli, on rejette silencieusement
 *   - Longueur max sur chaque champ
 *   - Pas de HTML accepté (texte brut)
 */

const MAX_NOM = 80;
const MAX_COURRIEL = 200;
const MAX_MESSAGE = 1500;

function corsHeaders(req) {
  return corsHeadersFor(req, 'GET, POST, OPTIONS');
}

function nettoyer(texte, max) {
  if (typeof texte !== 'string') return '';
  return texte
    .replace(/[<>]/g, '') // pas de HTML brut
    .trim()
    .slice(0, max);
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const __sentryHandler = async (req) => {
  const headers = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return jsonResponse({ error: 'Configuration manquante' }, 500, headers);
  }

  // ─── GET : liste des commentaires publiés ─────────────────────────────────
  if (req.method === 'GET') {
    try {
      // Lecture via la service key : la table contient des courriels (PII) et n'est
      // plus lisible par le rôle anon. On ne renvoie que les colonnes publiques.
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/nouvelles_commentaires?select=nom,message,created_at&statut=eq.publie&order=created_at.desc&limit=20`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
        }
      );
      const commentaires = await res.json();
      return jsonResponse(
        { commentaires: Array.isArray(commentaires) ? commentaires : [] },
        200,
        { ...headers, 'Cache-Control': 'public, max-age=60' }
      );
    } catch (err) {
      console.error('Erreur GET commentaires:', err);
      return jsonResponse({ error: 'Erreur lecture' }, 500, headers);
    }
  }

  // ─── POST : soumission d'un commentaire ──────────────────────────────────
  if (req.method === 'POST') {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ error: 'JSON invalide' }, 400, headers);
    }

    // Honeypot : si "website" est rempli, c'est un bot
    if (payload.website && payload.website.length > 0) {
      // On répond OK pour ne pas révéler le piège
      return jsonResponse({ ok: true }, 200, headers);
    }

    const nom = nettoyer(payload.nom, MAX_NOM);
    const courriel = nettoyer(payload.courriel, MAX_COURRIEL);
    const message = nettoyer(payload.message, MAX_MESSAGE);

    if (!nom) return jsonResponse({ error: 'Le nom est requis.' }, 400, headers);
    if (!message) return jsonResponse({ error: 'Le message est requis.' }, 400, headers);
    if (message.length < 5) return jsonResponse({ error: 'Le message est trop court.' }, 400, headers);
    if (courriel && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(courriel)) {
      return jsonResponse({ error: 'Courriel invalide.' }, 400, headers);
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_commentaires`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          nom,
          courriel: courriel || null,
          message,
          statut: 'publie',
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error('Erreur insertion Supabase:', err);
        return jsonResponse({ error: 'Impossible d\'enregistrer le message.' }, 500, headers);
      }

      return jsonResponse({ ok: true }, 201, headers);
    } catch (err) {
      console.error('Exception POST commentaire:', err);
      return jsonResponse({ error: 'Erreur serveur.' }, 500, headers);
    }
  }

  return jsonResponse({ error: 'Méthode non autorisée' }, 405, headers);
};

export const config = {
  path: '/.netlify/functions/nouvelles-commentaire',
};

export default withSentry(__sentryHandler);
