import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 6 heures
 * Scrape les activités de la Chambre de commerce et d'industrie d'Abitibi-Ouest
 * depuis https://www.cciao.ca/fr/activites/ et met à jour Supabase.
 */

export const config = {
  schedule: '0 */6 * * *',
};

const CCIAO_URL = 'https://www.cciao.ca/fr/activites/';

function parseActivites(html) {
  const activites = [];
  const regex = /<div class="article">(.*?)<div class="clear">/gs;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const block = match[1];
    const date = block.match(/class="date-activite">\s*(.*?)\s*<\/div>/s)?.[1]?.trim();
    const titre = block.match(/<h5>(.*?)<\/h5>/s)?.[1]?.trim();
    const lien = block.match(/href="(details\.cfm\?[^"]+)"/)?.[1];
    const image = block.match(/src="(\/images\/[^"]+)"/)?.[1];
    const sommaire = block.match(/class="sommaire">(.*?)<\/p>/s)?.[1]
      ?.replace(/<[^>]+>/g, '').trim();

    if (titre && date) {
      activites.push({
        titre: titre.replace(/[\u{1D400}-\u{1D7FF}]/gu, c =>
          String.fromCharCode(c.codePointAt(0) - 0x1D400 + 65 + (c.codePointAt(0) >= 0x1D41A ? 6 : 0))
        ),
        date,
        url: lien ? `https://www.cciao.ca/fr/activites/${lien}` : CCIAO_URL,
        image: image ? `https://www.cciao.ca${image}` : null,
        sommaire: sommaire?.slice(0, 200) || null,
      });
    }
  }
  return activites;
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
    const res = await fetch(CCIAO_URL);
    if (!res.ok) {
      console.error(`CCIAO HTTP ${res.status}`);
      return new Response(`Erreur CCIAO HTTP ${res.status}`, { status: 502 });
    }
    const buf = await res.arrayBuffer();
    html = new TextDecoder('utf-8').decode(buf);
  } catch (err) {
    console.error('Erreur fetch CCIAO:', err.message);
    return new Response('Erreur réseau CCIAO', { status: 502 });
  }

  const activites = parseActivites(html);
  console.log(`CCIAO: ${activites.length} activités trouvées`);
  activites.forEach(a => console.log(`  ${a.date} — ${a.titre}`));

  const payload = {
    id: 1,
    activites,
    mis_a_jour: new Date().toISOString(),
  };

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_cciao`, {
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
    return new Response('Erreur upsert Supabase', { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, count: activites.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
