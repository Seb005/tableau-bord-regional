import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 6 heures
 * Récupère la météo depuis Open-Meteo pour La Sarre, QC
 * et met à jour la table `nouvelles_meteo` dans Supabase.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 * * * *', // Toutes les heures
};

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  // Requête Open-Meteo pour La Sarre, QC
  const meteoUrl =
    'https://api.open-meteo.com/v1/forecast' +
    '?latitude=48.8&longitude=-79.2' +
    '&current_weather=true' +
    '&current=relative_humidity_2m' +
    '&temperature_unit=celsius' +
    '&daily=weathercode,temperature_2m_max,temperature_2m_min' +
    '&timezone=America/Toronto' +
    '&forecast_days=6';

  let meteoData;
  try {
    const meteoRes = await fetch(meteoUrl);
    if (!meteoRes.ok) {
      const err = await meteoRes.text();
      console.error('Erreur Open-Meteo:', err);
      return new Response('Erreur Open-Meteo', { status: 500 });
    }
    meteoData = await meteoRes.json();
  } catch (err) {
    console.error('Exception Open-Meteo:', err.message);
    return new Response('Exception Open-Meteo', { status: 500 });
  }

  const { current_weather, current, daily } = meteoData;

  // Données actuelles
  const temperature = current_weather.temperature;
  const weathercode = current_weather.weathercode;
  const windspeed = current_weather.windspeed;
  const humidity = current?.relative_humidity_2m ?? null;

  // Prévisions sur 5 jours (on saute today = index 0)
  const previsions = [];
  for (let i = 1; i <= 5; i++) {
    if (daily.time[i]) {
      previsions.push({
        date: daily.time[i],
        weathercode: daily.weathercode[i],
        temp_max: daily.temperature_2m_max[i],
        temp_min: daily.temperature_2m_min[i],
      });
    }
  }

  const payload = {
    id: 1,
    temperature,
    code_meteo: weathercode,
    vent_kmh: windspeed,
    humidite: humidity,
    previsions,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour météo:', JSON.stringify(payload));

  // Upsert dans Supabase (toujours la même ligne id=1)
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_meteo`, {
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

  console.log('Météo mise à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, temperature, weathercode, previsions: previsions.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
