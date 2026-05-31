import { withSentry } from '../lib/sentry.js';
/**
 * Retire un endpoint de la table des abonnements push.
 * POST /.netlify/functions/push-unsubscribe
 * Body : { endpoint }
 */

const __sentryHandler = async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response('Configuration manquante', { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Body invalide' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { endpoint } = body || {};
  if (!endpoint) {
    return new Response(JSON.stringify({ ok: false, error: 'endpoint requis' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });

  return new Response(JSON.stringify({ ok: res.ok }), {
    status: res.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
};

export default withSentry(__sentryHandler);
