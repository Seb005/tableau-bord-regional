import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — deux fois par jour (7h et 19h)
 * Récupère les niveaux d'eau et débits pour l'Abitibi-Ouest
 * et met à jour la table `nouvelles_eau` dans Supabase.
 *
 * SOURCES DE DONNÉES :
 *
 * 1. CEHQ — Prévisions hydrologiques (CSV public, gratuit, sans clé)
 *    URL : https://www.donneesquebec.ca/.../previsions_deh_public.csv
 *    Champs : site, date, Q_25e_mcs, Q_mcs, Q_75e_mcs
 *    Mis à jour aux 3 heures. Couvre les rivières :
 *      - Site 043012 ≈ Rivière Kinojevis (48.37°N, -78.85°W) — la plus proche de La Sarre
 *      - Site 080101 ≈ Rivière Harricana à Amos (48.60°N, -78.11°W)
 *    Note : Q_mcs = débit médian prévu en m³/s. Pas de niveau en mètres disponible.
 *
 * 2. Environnement Canada — Moyennes journalières hydrométriques (API OGC, gratuit, sans clé)
 *    URL : https://api.weather.gc.ca/collections/hydrometric-daily-mean/items
 *    Stations confirmées actives dans la région :
 *      - 04MA001 : Lac Macamic à Macamic (niveau en m masl, pas de débit)
 *      - 04MA004 : Lac Abitibi à Mancebourg (niveau en m masl, pas de débit)
 *    Note : Ces données sont des moyennes journalières avec un délai de publication
 *    de plusieurs semaines. Pour des lacs, les niveaux varient peu au quotidien.
 *    Les données d'EC temps-réel (collection hydrometric-realtime) ne couvrent pas
 *    ces stations provinciales malgré le flag REAL_TIME=1 dans le catalogue.
 *
 * STATIONS DISPONIBLES MAIS ABANDONNÉES :
 *   - 04MA003 : Rivière La Sarre près de La Sarre — FERMÉE (STATUS: Discontinued)
 *   - La station CEHQ de la Rivière Duparquet et Rivière Macamic n'ont pas de
 *     données temps-réel dans les sources publiques inventoriées.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 7,19 * * *', // Deux fois par jour : 7h et 19h UTC
};

const EC_DAILY_MEAN_URL = 'https://api.weather.gc.ca/collections/hydrometric-daily-mean/items';
const CEHQ_FORECAST_CSV_URL =
  'https://www.donneesquebec.ca/recherche/dataset/39d94a43-4b6c-4423-930b-4bfdfd1e6b63/resource/ca1eddfb-4db0-430a-8bd2-f73fa072af47/download/previsions_deh_public.csv';

/**
 * Calcule une tendance simplifiée à partir de deux valeurs successives.
 * Retourne "hausse", "baisse" ou "stable".
 */
function tendance(valeurRecente, valeurPrecedente, seuil = 0.05) {
  if (valeurRecente === null || valeurPrecedente === null) return 'stable';
  const diff = valeurRecente - valeurPrecedente;
  if (diff > seuil) return 'hausse';
  if (diff < -seuil) return 'baisse';
  return 'stable';
}

/**
 * Récupère le niveau d'une station EC (moyennes journalières).
 * Retourne { niveau_m, debit_m3s, tendance, date } ou null en cas d'erreur.
 */
async function fetchEcStation(stationNumber, nomAffiche) {
  try {
    const url =
      `${EC_DAILY_MEAN_URL}?STATION_NUMBER=${stationNumber}&f=json&limit=3&sortby=-DATE`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const features = data.features ?? [];
    if (features.length === 0) return null;

    const latest = features[0].properties;
    const previous = features[1]?.properties ?? null;

    return {
      nom: nomAffiche,
      niveau_m: latest.LEVEL ?? null,
      debit_m3s: latest.DISCHARGE ?? null,
      tendance: tendance(latest.LEVEL, previous?.LEVEL),
      mis_a_jour_station: latest.DATE ?? null, // Date de la moyenne journalière (YYYY-MM-DD)
    };
  } catch (err) {
    console.error(`Erreur station EC ${stationNumber}:`, err.message);
    return null;
  }
}

/**
 * Parse le CSV CEHQ et retourne la valeur Q_mcs la plus récente pour un site donné.
 * Format CSV : site,date,Q_25e_mcs,Q_mcs,Q_75e_mcs,N_m
 */
function parseCehqCsv(csvText, siteId) {
  const lines = csvText.split('\n').filter(Boolean);
  // Filtrer les lignes du site, trier par date décroissante
  const siteLines = lines
    .slice(1) // skip header
    .filter((l) => l.startsWith(siteId + ','))
    .sort((a, b) => {
      const dateA = a.split(',')[1] ?? '';
      const dateB = b.split(',')[1] ?? '';
      return dateB.localeCompare(dateA);
    });

  if (siteLines.length === 0) return null;

  const [, date, , q_mcs] = siteLines[0].split(',');
  const [, , , q_mcs_prev] = (siteLines[1]?.split(',') ?? []);

  const debit = parseFloat(q_mcs) || null;
  const debitPrev = parseFloat(q_mcs_prev) || null;

  return {
    debit,
    debitPrev,
    date: date?.trim() ?? null,
  };
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  const stations = [];

  // --- 1. Lac Macamic (EC daily mean) ---
  const macamic = await fetchEcStation('04MA001', 'Lac Macamic');
  if (macamic) {
    stations.push({ riviere: 'Lac Macamic', ...macamic });
  }

  // --- 2. Lac Abitibi (EC daily mean) ---
  const abitibi = await fetchEcStation('04MA004', 'Lac Abitibi');
  if (abitibi) {
    stations.push({ riviere: 'Lac Abitibi', ...abitibi });
  }

  // --- 3. Rivières via CEHQ (prévisions hydrologiques) ---
  let csvText = null;
  try {
    const csvRes = await fetch(CEHQ_FORECAST_CSV_URL);
    if (csvRes.ok) {
      csvText = await csvRes.text();
    } else {
      console.error('Erreur CEHQ CSV:', csvRes.status);
    }
  } catch (err) {
    console.error('Exception CEHQ CSV:', err.message);
  }

  if (csvText) {
    // Site 043012 — Rivière Kinojevis (la plus proche de La Sarre, ~30 km au SE)
    const kinojevis = parseCehqCsv(csvText, '043012_000');
    if (kinojevis) {
      stations.push({
        nom: 'Rivière Kinojevis',
        riviere: 'Rivière Kinojevis',
        niveau_m: null, // Seul le débit est disponible
        debit_m3s: kinojevis.debit,
        tendance: tendance(kinojevis.debit, kinojevis.debitPrev, 2),
        mis_a_jour_station: kinojevis.date,
      });
    }

    // Site 080101 — Rivière Harricana à Amos (~70 km à l'est de La Sarre)
    const harricana = parseCehqCsv(csvText, '080101_000');
    if (harricana) {
      stations.push({
        nom: 'Rivière Harricana (Amos)',
        riviere: 'Rivière Harricana',
        niveau_m: null, // Seul le débit est disponible
        debit_m3s: harricana.debit,
        tendance: tendance(harricana.debit, harricana.debitPrev, 5),
        mis_a_jour_station: harricana.date,
      });
    }
  }

  const payload = {
    id: 1,
    stations,
    mis_a_jour: new Date().toISOString(),
  };

  console.log(`Mise à jour niveaux d'eau: ${stations.length} station(s)`);
  console.log(JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_eau`, {
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

  console.log('Niveaux d\'eau mis à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, stations: stations.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
