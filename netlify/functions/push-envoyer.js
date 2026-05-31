import { withSentry } from '../lib/sentry.js';
/**
 * Diffuse une notification push à tous les abonnés actifs.
 * POST /.netlify/functions/push-envoyer
 * Auth : header `Authorization: Bearer <PUSH_ADMIN_TOKEN>`
 * Body : { title, body, url?, tag?, urgent? }
 *
 * Appelée par un système admin (intranet, CLI, etc.) avec le PUSH_ADMIN_TOKEN.
 *
 * Variables d'env requises :
 *   PUSH_ADMIN_TOKEN       secret partagé pour autoriser l'envoi
 *   VAPID_PUBLIC_KEY       clé publique VAPID (Base64URL)
 *   VAPID_PRIVATE_KEY      clé privée VAPID (Base64URL)
 *   VAPID_SUBJECT          mailto:contact@example.com (obligatoire)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   service_role pour lire/MAJ push_subscriptions
 */

import webpush from 'web-push';

const __sentryHandler = async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ADMIN_TOKEN = process.env.PUSH_ADMIN_TOKEN;
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
  if (!VAPID_SUBJECT) {
    return new Response('VAPID_SUBJECT env var requise (ex: mailto:contact@example.com)', { status: 500 });
  }
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!ADMIN_TOKEN || !VAPID_PUBLIC || !VAPID_PRIVATE || !SUPABASE_URL || !SUPABASE_KEY) {
    return jsonError('Configuration serveur incomplète', 500);
  }

  const auth = req.headers.get('authorization') || '';
  if (auth !== `Bearer ${ADMIN_TOKEN}`) {
    return jsonError('Unauthorized', 401);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonError('Body JSON invalide', 400);
  }

  const { title, body, url, tag, urgent } = payload || {};
  if (!title || !body) {
    return jsonError('title et body requis', 400);
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const subsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth&active=eq.true`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );

  if (!subsRes.ok) {
    console.error('Supabase fetch subs:', await subsRes.text());
    return jsonError('Erreur lecture abonnements', 500);
  }

  const subs = await subsRes.json();
  if (subs.length === 0) {
    return new Response(JSON.stringify({ ok: true, total: 0, succeeded: 0, failed: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const message = JSON.stringify({
    title,
    body,
    url: url || '/nouvelles',
    tag: tag || 'site-alerte',
    urgent: !!urgent,
  });

  const results = await Promise.allSettled(
    subs.map((s) => sendOne(s, message, SUPABASE_URL, SUPABASE_KEY))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
  const failed = results.length - succeeded;

  return new Response(JSON.stringify({ ok: true, total: subs.length, succeeded, failed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function sendOne(sub, message, SUPABASE_URL, SUPABASE_KEY) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      message
    );
    return { ok: true };
  } catch (err) {
    const status = err?.statusCode || 0;
    // 404/410 = endpoint mort (désabonné côté navigateur) → on désactive
    if (status === 404 || status === 410) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            active: false,
            last_error: `gone (${status})`,
            last_error_at: new Date().toISOString(),
          }),
        }
      );
    } else {
      console.error('Push send error', status, err?.message);
    }
    return { ok: false, status };
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default withSentry(__sentryHandler);
