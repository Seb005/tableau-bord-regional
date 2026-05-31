import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les heures (plus fréquent le matin)
 * Vérifie l'état du transport scolaire du CSS du Lac-Abitibi via
 * https://alertes.csdla.qc.ca/ et met à jour Supabase.
 *
 * Le widget ne s'affiche que lorsqu'une alerte est active (annulation,
 * retard, suspension). En temps normal, la table contient alerte: false.
 */

export const config = {
  schedule: '30 */1 * * *',
};

const ALERTES_URL = 'https://alertes.csdla.qc.ca/';

function parseAlerte(html) {
  const match = html.match(
    /<div[^>]*class="[^"]*page-content[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>/s
  );
  if (!match) return { alerte: false, message: null };

  const contenu = match[1];
  const texte = contenu
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normal = /aucune alerte en vigueur|se déroulent normalement/i.test(texte);
  if (normal) return { alerte: false, message: null };

  const alerteBlocks = contenu.match(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>(.*?)<\/div>/gs) || [];
  const alertes = alerteBlocks.map(b =>
    b.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  ).filter(Boolean);

  return {
    alerte: true,
    message: alertes.length > 0 ? alertes.join(' | ') : texte.slice(0, 500),
  };
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables Supabase manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  let html;
  try {
    const res = await fetch(ALERTES_URL);
    if (!res.ok) {
      console.error(`Alertes CSSLA HTTP ${res.status}`);
      return new Response(`Erreur HTTP ${res.status}`, { status: 502 });
    }
    html = await res.text();
  } catch (err) {
    console.error('Erreur fetch alertes CSSLA:', err.message);
    return new Response('Erreur réseau', { status: 502 });
  }

  const { alerte, message } = parseAlerte(html);
  console.log(`Transport scolaire: alerte=${alerte}${message ? ', message=' + message : ''}`);

  const payload = {
    id: 1,
    alerte,
    message,
    source_url: ALERTES_URL,
    mis_a_jour: new Date().toISOString(),
  };

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_transport`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error('Erreur upsert Supabase:', err);
    return new Response('Erreur upsert', { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, alerte, message }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
