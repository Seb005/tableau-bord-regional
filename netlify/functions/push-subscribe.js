import { withSentry } from '../lib/sentry.js';
/**
 * Reçoit une PushSubscription du navigateur et la stocke dans Supabase.
 * POST /.netlify/functions/push-subscribe
 * Body : { endpoint, keys: { p256dh, auth }, userAgent? }
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
    return jsonError('Body JSON invalide', 400);
  }

  const { endpoint, keys, userAgent } = body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return jsonError('Subscription invalide (endpoint, keys.p256dh, keys.auth requis)', 400);
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: userAgent || req.headers.get('user-agent') || null,
      active: true,
      last_seen: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase push-subscribe error:', err);
    return jsonError('Erreur enregistrement', 500);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default withSentry(__sentryHandler);
