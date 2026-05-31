import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 6 heures
 * Récupère les bornes de recharge électrique dans un rayon de 80 km autour de La Sarre
 * depuis le fichier CSV officiel du Circuit Électrique (Hydro-Québec / données ouvertes).
 *
 * Source des données :
 *   https://data.lecircuitelectrique.com/stations/export_sites_fr.csv
 *   Publié via Données Québec : https://www.donneesquebec.ca/recherche/dataset/liste-des-bornes-de-recharge
 *
 * Le CSV est mis à jour plusieurs fois par jour. Il ne contient pas de disponibilité
 * en temps réel — seulement l'inventaire des bornes. Les champs `disponibles` et
 * `total_disponibles` sont donc null.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 */6 * * *', // toutes les 6 heures
};

const USER_AGENT = 'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';
const CSV_URL = 'https://data.lecircuitelectrique.com/stations/export_sites_fr.csv';

// Coordonnées du centre-ville de La Sarre, Abitibi-Ouest
const LA_SARRE_LAT = 48.7979;
const LA_SARRE_LON = -79.2091;
const RAYON_KM = 80;

/**
 * Distance haversine entre deux points géographiques, en kilomètres.
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dlat = ((lat2 - lat1) * Math.PI) / 180;
  const dlon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Normalise le niveau de recharge selon la nomenclature du Circuit Électrique.
 * Le CSV utilise : "Niveau 2" ou "BRCC" (Borne de recharge à courant continu = DC Fast).
 */
function normaliserNiveau(niveau) {
  if (!niveau) return null;
  const n = niveau.trim().toUpperCase();
  if (n === 'BRCC') return 'BRCC (DC rapide)';
  if (n.startsWith('NIVEAU 2')) return 'Niveau 2';
  return niveau.trim();
}

/**
 * Analyse un fichier CSV simple (première ligne = en-têtes, valeurs entre guillemets).
 * Retourne un tableau d'objets.
 */
function parseCSV(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Extraire les en-têtes
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Découpage simple : les valeurs peuvent contenir des virgules si entre guillemets
    const values = [];
    let inQuote = false;
    let current = '';
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[bornes] Variables d\'environnement manquantes (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
    return new Response('Erreur de configuration', { status: 500 });
  }

  // 1. Télécharger le CSV du Circuit Électrique
  let csvText;
  try {
    const res = await fetch(CSV_URL, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[bornes] Réponse HTTP inattendue: ${res.status} ${res.statusText}`);
      return new Response('Erreur source données', { status: 502 });
    }
    csvText = await res.text();
  } catch (err) {
    console.warn('[bornes] Impossible de récupérer le CSV:', err.message);
    return new Response('Erreur récupération données', { status: 502 });
  }

  // 2. Analyser le CSV
  const allStations = parseCSV(csvText);
  if (allStations.length === 0) {
    console.warn('[bornes] CSV vide ou structure inattendue');
    return new Response('Structure données invalide', { status: 502 });
  }

  console.log(`[bornes] ${allStations.length} bornes dans le CSV total`);

  // 3. Filtrer les stations dans un rayon de 80 km autour de La Sarre
  const stationsProches = [];
  for (const station of allStations) {
    const lat = parseFloat(station['Latitude']);
    const lon = parseFloat(station['Longitude']);
    if (isNaN(lat) || isNaN(lon)) continue;

    const dist = haversine(LA_SARRE_LAT, LA_SARRE_LON, lat, lon);
    if (dist <= RAYON_KM) {
      stationsProches.push({ dist, station });
    }
  }

  stationsProches.sort((a, b) => a.dist - b.dist);

  console.log(`[bornes] ${stationsProches.length} borne(s) dans un rayon de ${RAYON_KM} km`);

  // 4. Regrouper par adresse (une même adresse peut avoir plusieurs bornes = plusieurs prises)
  //    Le CSV a une ligne par prise, pas par station physique.
  const parAdresse = new Map();
  for (const { dist, station } of stationsProches) {
    const adresse = station['Adresse'] || station['Rue'] || '';
    const ville = station['Ville'] || '';
    const cle = `${adresse}__${ville}`;

    if (!parAdresse.has(cle)) {
      parAdresse.set(cle, {
        nom: station['Nom du parc'] || station['Nom de la borne de recharge'] || adresse,
        adresse: adresse,
        ville: ville,
        province: station['Province'] || 'QC',
        code_postal: station['Code Postal'] || '',
        niveau: normaliserNiveau(station['Niveau de recharge']),
        nb_bornes: 1,
        disponibles: null, // non disponible dans ce CSV statique
        latitude: parseFloat(station['Latitude']),
        longitude: parseFloat(station['Longitude']),
        distance_km: Math.round(dist * 10) / 10,
      });
    } else {
      parAdresse.get(cle).nb_bornes += 1;
    }
  }

  const bornes = Array.from(parAdresse.values());
  bornes.sort((a, b) => a.distance_km - b.distance_km);

  const total_bornes = stationsProches.length; // nombre total de prises
  const total_disponibles = null; // le CSV ne fournit pas la disponibilité en temps réel

  // 5. Construire le payload
  const payload = {
    id: 1,
    bornes,
    total_bornes,
    total_disponibles,
    mis_a_jour: new Date().toISOString(),
  };

  console.log(`[bornes] ${bornes.length} site(s), ${total_bornes} prise(s) au total`);

  // 6. Upsert dans Supabase
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_bornes_electriques`, {
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
    console.error('[bornes] Erreur upsert Supabase:', err);
    return new Response('Erreur upsert Supabase', { status: 500 });
  }

  console.log('[bornes] Bornes électriques mises à jour avec succès.');
  return new Response(
    JSON.stringify({
      ok: true,
      sites: bornes.length,
      total_bornes,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
