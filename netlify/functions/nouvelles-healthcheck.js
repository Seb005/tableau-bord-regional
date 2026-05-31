import { withCron } from '../lib/sentry.js';
/**
 * Health-check du tableau de bord /nouvelles.
 * Schedulé toutes les 30 min. Vérifie le proxy, la présence des clés et
 * la fraîcheur des données. Alerte par courriel Resend selon une machine
 * d'état persistée dans la table Supabase `nouvelles_healthcheck`.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY  — pour lire/écrire nouvelles_healthcheck
 *   RESEND_API_KEY        — pour envoyer les alertes (resend.com)
 *   FROM_EMAIL            — adresse expéditrice, ex. "Carrefour <alerts@example.com>"
 *   ALERT_EMAIL           — destinataire des alertes
 *   SITE_URL              — URL publique du site, ex. https://example.com
 */

export const config = {
  schedule: '*/30 * * * *',
};

const ALERT_EMAIL = process.env.ALERT_EMAIL;
const SITE_URL = process.env.SITE_URL || '';
const REALERT_AFTER_HOURS = 6;

/**
 * Cartographie : clé du proxy → intervalle de cron en heures.
 * DOIT rester aligné avec les clés du payload de netlify/functions/nouvelles-proxy.js
 * et les schedules des fonctions correspondantes.
 */
const SOURCES = {
  meteo:    { intervalHours: 6,  cron: '0 */6 * * *' },
  essence:  { intervalHours: 9,  cron: '0 8,17 * * *' },
  sopfeu:   { intervalHours: 12, cron: '0 8,14 * * *' },
  finances: { intervalHours: 24, cron: '0 8 * * *' },
  hydro:    { intervalHours: 4,  cron: '0 */4 * * *' },
  routes:   { intervalHours: 6,  cron: '0 */6 * * *' },
  alertes:  { intervalHours: 3,  cron: '0 */3 * * *' },
  urgences: { intervalHours: 2,  cron: '0 */2 * * *' },
  emplois:  { intervalHours: 6,  cron: '0 */6 * * *' },
  bornes:   { intervalHours: 6,  cron: '0 */6 * * *' },
  loisirs:  { intervalHours: 24, cron: '0 8 * * *' },
  air:      { intervalHours: 3,  cron: '0 */3 * * *' },
  aurores:  { intervalHours: 6,  cron: '0 */6 * * *' },
  eau:      { intervalHours: 12, cron: '0 7,19 * * *' },
  internet: { intervalHours: 168, cron: '0 6 * * 1' },
  cciao:    { intervalHours: 6,  cron: '0 */6 * * *' },
  transport:{ intervalHours: 1,  cron: '30 */1 * * *' },
};

/**
 * Format HH:MM UTC pour un timestamp ISO.
 */
function formatTimeUTC(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * Format "Xh Ym" pour une durée en ms.
 */
function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Construit le HTML d'une alerte KO ou de ré-alerte.
 */
function buildAlertHtml({ failures, koDepuis, isReAlert }) {
  const duree = formatDuration(Date.now() - new Date(koDepuis).getTime());
  const lignes = failures.map(f => {
    const det = f.mis_a_jour ? ` (dernière maj : ${formatTimeUTC(f.mis_a_jour)})` : '';
    return `<li><strong>${f.source}</strong> — ${f.raison}${det}</li>`;
  }).join('');

  const intro = isReAlert
    ? `Le tableau de bord est <strong>toujours dégradé</strong> depuis ${duree} (début à ${formatTimeUTC(koDepuis)}).`
    : `Le tableau de bord <strong>présente ${failures.length} dégradation(s)</strong> depuis ${formatTimeUTC(koDepuis)}.`;

  return `<!DOCTYPE html><html lang="fr"><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:24px;">
    <p>${intro}</p>
    <ul>${lignes}</ul>
    <p>
      <a href="${SITE_URL}/nouvelles">Voir le tableau de bord</a><br>
      <a href="https://app.netlify.com/">Logs des fonctions Netlify</a>
    </p>
    <p style="color:#888;font-size:12px;">— Health-check automatique</p>
  </body></html>`;
}

/**
 * Construit le HTML du courriel de rétablissement.
 */
function buildRecoveryHtml({ koDepuis, previousFailures }) {
  const duree = formatDuration(Date.now() - new Date(koDepuis).getTime());
  const lignes = previousFailures.map(f => `<li>${f.source}</li>`).join('');

  return `<!DOCTYPE html><html lang="fr"><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:24px;">
    <p>Le tableau de bord est <strong>rétabli</strong> après une panne de ${duree}.</p>
    <p>Sources qui étaient affectées :</p>
    <ul>${lignes}</ul>
    <p><a href="${SITE_URL}/nouvelles">Voir le tableau de bord</a></p>
    <p style="color:#888;font-size:12px;">— Health-check automatique</p>
  </body></html>`;
}

/**
 * Envoie un courriel via Resend. Throw si l'API renvoie une erreur.
 */
async function sendEmail({ subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: ALERT_EMAIL,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Lit l'enregistrement singleton 'main' depuis nouvelles_healthcheck.
 * Retourne null si la table est vide, ou l'objet
 * { statut, ko_depuis, derniere_alerte, details }.
 */
async function loadState() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/nouvelles_healthcheck?id=eq.main&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`loadState HTTP ${res.status}: ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/**
 * Upsert l'état. `state` doit contenir { statut, ko_depuis, derniere_alerte, details }.
 */
async function saveState(state) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/nouvelles_healthcheck`;
  const body = {
    id: 'main',
    dernier_check: new Date().toISOString(),
    statut: state.statut,
    ko_depuis: state.ko_depuis,
    derniere_alerte: state.derniere_alerte,
    details: state.details,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`saveState HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Appelle le proxy et retourne soit { ok: true, payload } soit { ok: false, reason }.
 */
async function checkProxy() {
  const url = `${process.env.URL || SITE_URL}/.netlify/functions/nouvelles-proxy`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, reason: `proxy unreachable: ${err.message}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `proxy HTTP ${res.status}` };
  }
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, reason: `proxy JSON invalide: ${err.message}` };
  }
  if (payload && payload.error) {
    return { ok: false, reason: `proxy error: ${payload.error}` };
  }
  return { ok: true, payload };
}

/**
 * À partir du payload du proxy, retourne un tableau de défaillances.
 * Chaque entrée : { source, raison, mis_a_jour? }
 */
function checkFreshness(payload) {
  const failures = [];
  const now = Date.now();

  for (const [key, { intervalHours }] of Object.entries(SOURCES)) {
    const data = payload[key];

    if (data == null) {
      failures.push({ source: key, raison: 'clé absente ou null dans le proxy' });
      continue;
    }
    if (data.error) {
      failures.push({ source: key, raison: `proxy renvoie error: ${data.error}` });
      continue;
    }
    if (!data.mis_a_jour) {
      failures.push({ source: key, raison: 'pas de mis_a_jour' });
      continue;
    }

    const ageMs = now - new Date(data.mis_a_jour).getTime();
    const ageHours = ageMs / 3_600_000;
    const seuilHours = 2 * intervalHours;

    if (ageHours > seuilHours) {
      failures.push({
        source: key,
        raison: `stale depuis ${ageHours.toFixed(1)}h (seuil ${seuilHours}h)`,
        mis_a_jour: data.mis_a_jour,
      });
    }
  }

  return failures;
}

const __handler = async () => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, FROM_EMAIL } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[healthcheck] SUPABASE_URL ou SUPABASE_SERVICE_KEY manquant');
    return new Response('Erreur de configuration', { status: 500 });
  }

  if (!RESEND_API_KEY || !FROM_EMAIL || !ALERT_EMAIL) {
    console.warn('[healthcheck] Alertes désactivées (RESEND_API_KEY, FROM_EMAIL ou ALERT_EMAIL manquant)');
    return new Response('Health-check alertes désactivées', { status: 200 });
  }

  try {
    const proxy = await checkProxy();
    let failures;
    if (!proxy.ok) {
      console.error(`[healthcheck] Proxy KO : ${proxy.reason}`);
      // Proxy KO : on traite ça comme une défaillance globale et on laisse
      // la machine d'état décider de l'alerte.
      failures = [{ source: 'proxy', raison: proxy.reason }];
    } else {
      failures = checkFreshness(proxy.payload);
    }
    const currentStatus = failures.length === 0 ? 'ok' : 'ko';
    const prev = await loadState();
    const prevStatus = prev?.statut || 'ok';
    const now = new Date();
    const nowIso = now.toISOString();

    console.log(`[healthcheck] prev=${prevStatus} current=${currentStatus} failures=${failures.length}`);

    let alertSent = false;
    const nextState = {
      statut: currentStatus,
      ko_depuis: prev?.ko_depuis || null,
      derniere_alerte: prev?.derniere_alerte || null,
      details: failures,
    };

    if (prevStatus === 'ok' && currentStatus === 'ko') {
      // Transition OK → KO : alerte initiale
      nextState.ko_depuis = nowIso;
      nextState.derniere_alerte = nowIso;
      await sendEmail({
        subject: `🔴 Carrefour — Tableau de bord dégradé (${failures.length} source${failures.length > 1 ? 's' : ''})`,
        html: buildAlertHtml({ failures, koDepuis: nowIso, isReAlert: false }),
      });
      alertSent = true;
    } else if (prevStatus === 'ko' && currentStatus === 'ko') {
      // Toujours KO : ré-alerte si dépassement du seuil
      const lastAlertMs = prev.derniere_alerte ? new Date(prev.derniere_alerte).getTime() : 0;
      const sinceLastAlertH = (now.getTime() - lastAlertMs) / 3_600_000;
      if (sinceLastAlertH >= REALERT_AFTER_HOURS) {
        nextState.derniere_alerte = nowIso;
        const koDepuis = prev.ko_depuis || nowIso;
        const duree = formatDuration(now.getTime() - new Date(koDepuis).getTime());
        await sendEmail({
          subject: `🔴 Carrefour — Toujours dégradé depuis ${duree}`,
          html: buildAlertHtml({ failures, koDepuis, isReAlert: true }),
        });
        alertSent = true;
      }
    } else if (prevStatus === 'ko' && currentStatus === 'ok') {
      // Transition KO → OK : courriel de rétablissement
      const koDepuis = prev.ko_depuis || nowIso;
      await sendEmail({
        subject: `🟢 Carrefour — Tableau de bord rétabli (panne de ${formatDuration(now.getTime() - new Date(koDepuis).getTime())})`,
        html: buildRecoveryHtml({ koDepuis, previousFailures: prev.details || [] }),
      });
      nextState.ko_depuis = null;
      nextState.derniere_alerte = null;
      alertSent = true;
    }
    // OK → OK : rien à faire

    await saveState(nextState);

    return new Response(JSON.stringify({
      ok: currentStatus === 'ok',
      failures: failures.length,
      alert_sent: alertSent,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[healthcheck] Erreur interne :', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export default withCron(__handler, 'nouvelles-healthcheck', '*/30 * * * *');
