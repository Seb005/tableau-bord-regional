import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — 8h et 17h tous les jours
 * Récupère les prix de l'essence à La Sarre depuis regieessencequebec.ca
 * et met à jour la table `nouvelles_essence` dans Supabase.
 *
 * Source des données : https://regieessencequebec.ca/stations.geojson.gz
 * Le fichier GeoJSON contient toutes les stations du Québec avec leurs prix.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 8,17 * * *', // 8h et 17h chaque jour
};

const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';
const GEOJSON_URL = 'https://regieessencequebec.ca/stations.geojson.gz';

// 23 municipalités de la MRC d'Abitibi-Ouest
const MRC_AO_MUNICIPALITES = [
  'La Sarre', 'Macamic', 'Palmarolle', 'Duparquet',
  'Authier-Nord', 'Authier', 'Chazel', 'Clerval', 'Clermont',
  'Dupuy', 'Gallichan', 'La Reine', 'Normétal', 'Poularies',
  'Rapide-Danseur', 'Roquemaure', 'Sainte-Germaine-Boulé',
  'Sainte-Hélène-de-Mancebourg', 'Saint-Lambert',
  'Taschereau', 'Val-Saint-Gilles', 'Saint-Vital-de-Clermont',
];

// Normalisation des noms de stations (mapping vers une bannière reconnaissable)
// On peut filtrer par nom ET (optionnellement) par adresse pour distinguer
// deux stations qui partagent un nom officiel (ex: les 2 Pro-Gaz à La Sarre).
const STATION_ALIAS = [
  { name: /9461-5622 Québec Inc/i,                                 alias: 'Harnois' },
  // Pro-Gaz : 2 stations à La Sarre, on distingue par l'adresse
  { name: /pro[-\s]?gaz/i,         address: /route 393/i,           alias: 'Sergaz' },
  { name: /pro[-\s]?gaz/i,         address: /(rue 2|rue\s+deuxi)/i, alias: 'Ultramar' },
  { name: /pro[-\s]?gaz/i,                                          alias: 'Pro-Gaz' }, // fallback
  { name: /Canadian Tire/i,                                         alias: 'Canadian Tire' },
  { name: /Garage Michel Genest/i,                                  alias: 'Garage Genest' },
  { name: /Garage Martin Macameau/i,                                alias: 'Garage Macameau' },
  { name: /SPRINT Relais/i,                                         alias: 'Petro-Canada' },
];

function nommerStation(nomOfficiel, adresse) {
  if (!nomOfficiel) return null;
  for (const { name, address, alias } of STATION_ALIAS) {
    if (!name.test(nomOfficiel)) continue;
    if (address && !address.test(adresse ?? '')) continue;
    return alias;
  }
  return nomOfficiel;
}

/**
 * Extraire le prix numérique d'une chaîne comme "196.4¢" ou "196.4"
 * Retourne null si le prix est indisponible ou invalide.
 */
function parsePrice(priceStr) {
  if (!priceStr || typeof priceStr !== 'string') return null;
  const cleaned = priceStr.replace('¢', '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Devine la ville d'une station depuis son champ Address.
 */
function devinerVille(address) {
  if (!address) return null;
  // Match la première municipalité qui apparaît dans l'adresse
  for (const ville of MRC_AO_MUNICIPALITES) {
    const re = new RegExp(`\\b${ville.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(address)) return ville;
  }
  return null;
}

/**
 * Trouve la station offrant le prix le plus bas pour un type de carburant.
 * Retourne { prix, station, ville } ou null si aucun prix dispo.
 */
function stationMin(stations, gasType) {
  let min = null;
  for (const station of stations) {
    const prices = station.properties?.Prices ?? [];
    const entry = prices.find((p) => p.GasType === gasType && p.IsAvailable);
    if (!entry) continue;
    const val = parsePrice(entry.Price);
    if (val === null) continue;
    if (!min || val < min.prix) {
      min = {
        prix: val,
        station: nommerStation(station.properties?.Name, station.properties?.Address),
        ville: devinerVille(station.properties?.Address),
      };
    }
  }
  return min;
}

/**
 * Moyenne arrondie à 0.1 (utile pour comparer les régions).
 */
function moyennePrix(stations, gasType) {
  const prix = [];
  for (const station of stations) {
    const prices = station.properties?.Prices ?? [];
    const entry = prices.find((p) => p.GasType === gasType && p.IsAvailable);
    if (!entry) continue;
    const val = parsePrice(entry.Price);
    if (val !== null) prix.push(val);
  }
  if (prix.length === 0) return null;
  const somme = prix.reduce((acc, v) => acc + v, 0);
  return Math.round((somme / prix.length) * 10) / 10;
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[essence] Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
    return new Response('Erreur de configuration', { status: 500 });
  }

  // 1. Télécharger le GeoJSON compressé
  let geojson;
  try {
    const res = await fetch(GEOJSON_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip',
      },
    });
    if (!res.ok) {
      console.warn(`[essence] Réponse HTTP inattendue: ${res.status} ${res.statusText}`);
      return new Response('Erreur source données', { status: 502 });
    }
    // Le runtime Netlify (Node 18+) décompresse gzip automatiquement via fetch
    geojson = await res.json();
  } catch (err) {
    console.warn('[essence] Impossible de récupérer stations.geojson.gz:', err.message);
    return new Response('Erreur récupération données', { status: 502 });
  }

  // 2. Valider la structure GeoJSON
  if (!geojson?.features || !Array.isArray(geojson.features)) {
    console.warn('[essence] Structure GeoJSON inattendue — la page a peut-être changé');
    return new Response('Structure données invalide', { status: 502 });
  }

  // 3. Filtrer les stations de la MRC d'Abitibi-Ouest
  // On combine bounding box géographique ET match de municipalité dans l'adresse
  // pour éviter les faux positifs (ex: boulevard Taschereau à Brossard).
  const BBOX_AO = { latMin: 48.4, latMax: 49.4, lonMin: -80.0, lonMax: -78.7 };
  const reMrc = new RegExp(
    '\\b(' + MRC_AO_MUNICIPALITES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
  );
  const stationsMrc = geojson.features.filter((f) => {
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return false;
    const [lon, lat] = coords;
    const inBbox = lat >= BBOX_AO.latMin && lat <= BBOX_AO.latMax &&
                   lon >= BBOX_AO.lonMin && lon <= BBOX_AO.lonMax;
    if (!inBbox) return false;
    const address = f.properties?.Address ?? '';
    return reMrc.test(address);
  });

  if (stationsMrc.length === 0) {
    console.warn('[essence] Aucune station trouvée dans la MRC AO — structure peut-être changée');
    return new Response('Aucune station trouvée', { status: 502 });
  }

  console.log(`[essence] ${stationsMrc.length} station(s) trouvée(s) dans la MRC d'Abitibi-Ouest`);

  // 4. Trouver les minimums + calculer les moyennes
  const minReg = stationMin(stationsMrc, 'Régulier');
  const minDie = stationMin(stationsMrc, 'Diesel');
  const moyReg = moyennePrix(stationsMrc, 'Régulier');
  const moyDie = moyennePrix(stationsMrc, 'Diesel');

  // Construire la liste complète des stations pour le popup
  const toutesStations = stationsMrc.map((f) => {
    const p = f.properties ?? {};
    const reg = p.Prices?.find((x) => x.GasType === 'Régulier' && x.IsAvailable);
    const die = p.Prices?.find((x) => x.GasType === 'Diesel' && x.IsAvailable);
    return {
      nom: nommerStation(p.Name, p.Address),
      adresse: p.Address ?? null,
      ville: devinerVille(p.Address),
      prix_regulier: reg ? parsePrice(reg.Price) : null,
      prix_diesel: die ? parsePrice(die.Price) : null,
    };
  }).sort((a, b) => {
    // Trier par prix régulier ascendant (les nulls à la fin)
    const pa = a.prix_regulier ?? Infinity;
    const pb = b.prix_regulier ?? Infinity;
    return pa - pb;
  });

  if (!minReg && !minDie) {
    console.warn('[essence] Aucun prix disponible dans la MRC AO');
    return new Response('Aucun prix disponible', { status: 502 });
  }

  // On stocke le prix le plus bas comme valeur principale (le user veut "le plus bas dans la MRC")
  const payload = {
    id: 1,
    prix_regulier: minReg ? minReg.prix : null,
    prix_diesel: minDie ? minDie.prix : null,
    prix_regulier_moyen: moyReg,
    prix_diesel_moyen: moyDie,
    station: minReg?.station ?? minDie?.station ?? null,
    ville: minReg?.ville ?? minDie?.ville ?? null,
    nb_stations: stationsMrc.length,
    toutes_stations: toutesStations,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('[essence] Mise à jour:', JSON.stringify(payload));

  // 5. Upsert dans Supabase
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_essence`, {
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
    console.error('[essence] Erreur upsert Supabase:', err);
    return new Response('Erreur upsert Supabase', { status: 500 });
  }

  console.log('[essence] Prix essence mis à jour avec succès.');
  return new Response(
    JSON.stringify({
      ok: true,
      stations: stationsMrc.length,
      min_regulier: payload.prix_regulier,
      min_diesel: payload.prix_diesel,
      moy_regulier: payload.prix_regulier_moyen,
      moy_diesel: payload.prix_diesel_moyen,
      station: payload.station,
      ville: payload.ville,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
