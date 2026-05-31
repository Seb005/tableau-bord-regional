import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 3 heures
 * Récupère la qualité de l'air depuis Open-Meteo Air Quality API pour La Sarre, QC
 * et met à jour la table `nouvelles_air` dans Supabase.
 *
 * Source : https://air-quality-api.open-meteo.com (gratuit, sans clé)
 * Champs confirmés : european_aqi, pm10, pm2_5, nitrogen_dioxide, ozone
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 */3 * * *', // Toutes les 3 heures
};

/**
 * Convertit l'indice européen de qualité de l'air (EAQI) en niveau français.
 * Échelle officielle : 0-20 Très bon, 21-40 Bon, 41-60 Modéré,
 *                      61-80 Mauvais, 81-100 Très mauvais, 101+ Extrêmement mauvais
 */
function niveauAir(aqi) {
  if (aqi <= 20) return 'Très bon';
  if (aqi <= 40) return 'Bon';
  if (aqi <= 60) return 'Modéré';
  if (aqi <= 80) return 'Mauvais';
  if (aqi <= 100) return 'Très mauvais';
  return 'Extrêmement mauvais';
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  // Open-Meteo Air Quality API — La Sarre, QC (48.8°N, -79.2°W)
  // Note : le champ API s'appelle "pm2_5" (avec underscore), pas "pm25"
  const airUrl =
    'https://air-quality-api.open-meteo.com/v1/air-quality' +
    '?latitude=48.8&longitude=-79.2' +
    '&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone' +
    '&timezone=America/Toronto';

  let airData;
  try {
    const airRes = await fetch(airUrl);
    if (!airRes.ok) {
      const err = await airRes.text();
      console.error('Erreur Open-Meteo Air Quality:', err);
      return new Response('Erreur Open-Meteo Air Quality', { status: 500 });
    }
    airData = await airRes.json();
  } catch (err) {
    console.error('Exception Open-Meteo Air Quality:', err.message);
    return new Response('Exception Open-Meteo Air Quality', { status: 500 });
  }

  const current = airData.current;
  const aqi = current.european_aqi ?? null;

  const payload = {
    id: 1,
    aqi,
    niveau: aqi !== null ? niveauAir(aqi) : null,
    pm25: current.pm2_5 ?? null,
    pm10: current.pm10 ?? null,
    o3: current.ozone ?? null,
    no2: current.nitrogen_dioxide ?? null,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour qualité de l\'air:', JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_air`, {
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

  console.log('Qualité de l\'air mise à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, aqi, niveau: payload.niveau }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
