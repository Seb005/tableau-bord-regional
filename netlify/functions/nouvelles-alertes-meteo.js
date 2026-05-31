import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 3 heures
 * Récupère les alertes météo actives pour La Sarre et la région
 * Abitibi-Ouest depuis l'API GeoMet d'Environnement Canada (OGC API)
 * et met à jour la table `nouvelles_alertes` dans Supabase.
 *
 * Source : https://api.weather.gc.ca/collections/weather-alerts/items
 * Filtrage spatial par bbox (boîte englobante) autour de La Sarre :
 *   minLon=-80.5, minLat=48.4, maxLon=-78.8, maxLat=49.3
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 */3 * * *', // Toutes les 3 heures
};

// Boîte englobante centrée sur La Sarre et couvrant la région Abitibi-Ouest
// La Sarre : 48.80°N, 79.20°O — marge d'environ 80 km autour
const BBOX = '-80.5,48.4,-78.8,49.3';

// URL de l'API OGC d'Environnement Canada (alertes météo actives)
const EC_ALERTS_URL =
  'https://api.weather.gc.ca/collections/weather-alerts/items' +
  `?f=json&limit=500&bbox=${BBOX}`;

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Variables d'environnement manquantes : SUPABASE_URL ou SUPABASE_SERVICE_KEY");
    return new Response('Erreur de configuration', { status: 500 });
  }

  // ─── 1. Récupération des alertes depuis Environnement Canada ─────────────
  let alertes = [];

  try {
    const res = await fetch(EC_ALERTS_URL, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Erreur API EC (HTTP ${res.status}):`, errBody);
      return new Response(`Erreur API Environnement Canada: ${res.status}`, { status: 502 });
    }

    const data = await res.json();
    const features = Array.isArray(data.features) ? data.features : [];

    console.log(`Alertes reçues de l'API EC : ${features.length}`);

    // ─── 2. Déduplication par zone ──────────────────────────────────────────
    // L'API retourne une entrée par zone géographique affectée.
    // On regroupe par identifiant d'alerte de base (sans le suffixe de zone).
    const seen = new Map();

    for (const feature of features) {
      const p = feature.properties || {};

      // Clé de déduplication : alert_code + publication_datetime
      const dedupeKey = `${p.alert_code || ''}_${p.publication_datetime || ''}`;

      if (!seen.has(dedupeKey)) {
        seen.set(dedupeKey, {
          titre: p.alert_name_fr || p.alert_name_en || 'Alerte météo',
          description: p.alert_text_fr || p.alert_text_en || '',
          type: p.alert_type || 'alert',
          debut: p.validity_datetime || p.publication_datetime || new Date().toISOString(),
          zone: p.feature_name_fr || p.feature_name_en || '',
          couleur: p.risk_colour_fr || p.risk_colour_en || null,
          expiration: p.expiration_datetime || null,
        });
      }
    }

    alertes = Array.from(seen.values());
    console.log(`Alertes uniques après déduplication : ${alertes.length}`);
  } catch (err) {
    console.error("Exception lors de la récupération des alertes EC:", err.message);
    return new Response('Exception réseau', { status: 500 });
  }

  // ─── 3. Upsert dans Supabase ──────────────────────────────────────────────
  const payload = {
    id: 1,
    alertes,
    nb_alertes: alertes.length,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour alertes météo:', JSON.stringify({
    nb_alertes: alertes.length,
    mis_a_jour: payload.mis_a_jour,
    alertes: alertes.map((a) => ({ titre: a.titre, type: a.type, zone: a.zone })),
  }));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_alertes`, {
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

  console.log('Alertes météo mises à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, nb_alertes: alertes.length, mis_a_jour: payload.mis_a_jour }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
