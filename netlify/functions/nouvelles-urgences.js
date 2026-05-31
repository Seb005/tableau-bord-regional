import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 2 heures
 * Récupère les temps d'attente à l'urgence depuis le fichier CSV ouvert du MSSS
 * pour les hôpitaux d'Abitibi-Témiscamingue et met à jour la table
 * `nouvelles_urgences` dans Supabase.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 *
 * Source :
 *   https://www.msss.gouv.qc.ca/professionnels/statistiques/documents/urgences/
 *   Releve_horaire_urgences_7jours_nbpers.csv
 *   (le datastore CKAN est vide depuis 2026, les données sont servies par CSV)
 *
 * Note : Le taux d'occupation est calculé
 *        à partir de civieres_occupees / civieres_fonctionnelles.
 */

export const config = {
  schedule: '0 * * * *', // Toutes les heures
};

const CSV_URL =
  'https://www.msss.gouv.qc.ca/professionnels/statistiques/documents/urgences/' +
  'Releve_horaire_urgences_7jours_nbpers.csv';

// Hôpitaux prioritaires d'Abitibi-Témiscamingue, ordre d'affichage.
// On matche par mot-clé sur Nom_installation (les noms officiels sont longs et changent).
// Le `nom_court` est utilisé pour l'affichage côté client.
const HOPITAUX_PRIORITAIRES = [
  { keyword: 'LA SARRE',         nom_court: 'La Sarre' },
  { keyword: 'AMOS',             nom_court: 'Amos' },
  { keyword: 'ROUYN-NORANDA',    nom_court: 'Rouyn-Noranda' },
  { keyword: "VAL-D'OR",         nom_court: "Val-d'Or" },
];

// Établissements à exclure (trop loin de l'Abitibi-Ouest)
const EXCLUS = ['VILLE-MARIE', 'TÉMISCAMING', 'KIPAWA'];

/**
 * Convertit une chaîne numérique (ou null/vide) en entier.
 * Retourne null si la valeur n'est pas un nombre valide.
 */
function toInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/**
 * Calcule le taux d'occupation en pourcentage (arrondi à l'entier).
 * Retourne null si les données sont insuffisantes ou civieres_fonctionnelles = 0.
 */
function calculerTaux(occupees, fonctionnelles) {
  if (occupees === null || fonctionnelles === null || fonctionnelles === 0) return null;
  return Math.round((occupees / fonctionnelles) * 100);
}

/**
 * Parse le CSV du MSSS (encodage latin-1, virgule comme séparateur).
 * Retourne un tableau d'objets {clé: valeur} par ligne.
 */
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim());
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = vals[j] || '';
    }
    records.push(obj);
  }
  return records;
}

function mapperEtablissement(record, nom_court) {
  const civieres_occupees = toInt(record.Nombre_de_civieres_occupees);
  const civieres_fonctionnelles = toInt(record.Nombre_de_civieres_fonctionnelles);

  return {
    nom: record.Nom_installation || record.Nom_etablissement || 'Inconnu',
    nom_court: nom_court || null,
    civieres_occupees,
    civieres_fonctionnelles,
    taux_occupation: calculerTaux(civieres_occupees, civieres_fonctionnelles),
    patients_en_attente: toInt(record.Nombre_total_de_patients_en_attente_de_PEC),
    patients_plus_24h: toInt(record.Nombre_de_patients_sur_civiere_plus_de_24_heures),
    patients_plus_48h: toInt(record.Nombre_de_patients_sur_civiere_plus_de_48_heures),
    total_patients_urgence: toInt(record.Nombre_total_de_patients_presents_a_lurgence),
    dms_civiere: record.DMS_sur_civiere_horaire || null,
    dms_ambulatoire: record.DMS_ambulatoire_horaire || null,
  };
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Variables d'environnement manquantes : SUPABASE_URL ou SUPABASE_SERVICE_KEY");
    return new Response('Erreur de configuration', { status: 500 });
  }

  // ─── 1. Récupérer le CSV du MSSS ──────────────────────────────────────────
  let records;
  try {
    const res = await fetch(CSV_URL);
    if (!res.ok) {
      console.error(`CSV MSSS HTTP ${res.status}`);
      return new Response(`Erreur CSV MSSS HTTP ${res.status}`, { status: 502 });
    }
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('latin1').decode(buf);
    records = parseCSV(text);
    if (records.length === 0) {
      console.error('CSV vide ou mal formé');
      return new Response('CSV MSSS vide', { status: 502 });
    }
  } catch (err) {
    console.error('Exception fetch CSV MSSS:', err.message);
    return new Response('Erreur réseau CSV MSSS', { status: 502 });
  }

  // ─── 2. Filtrer la région Abitibi-Témiscamingue ───────────────────────────
  const regionRecords = records.filter(
    (r) => r.Region && r.Region.includes('Abitibi-T')
      && r.Nom_installation && !r.Nom_installation.includes('Total')
  );

  console.log(`CSV MSSS : ${records.length} enregistrements total, ${regionRecords.length} en Abitibi-Témiscamingue`);

  // ─── 3. Classer les établissements (par mot-clé, dans l'ordre prioritaire) ──
  const etablissements = [];
  const recordsConsommes = new Set();

  for (const { keyword, nom_court } of HOPITAUX_PRIORITAIRES) {
    const record = regionRecords.find(
      (r) =>
        !recordsConsommes.has(r) &&
        (r.Nom_installation || '').toUpperCase().includes(keyword.toUpperCase())
    );
    if (record) {
      etablissements.push(mapperEtablissement(record, nom_court));
      recordsConsommes.add(record);
    } else {
      console.warn(`Aucun établissement trouvé pour le mot-clé : ${keyword}`);
    }
  }

  // Pas d'établissements supplémentaires : on garde seulement les prioritaires d'Abitibi-Ouest.
  // Les autres (Ville-Marie, Témiscaming-Kipawa…) sont trop éloignés pour notre public.

  console.log(`Établissements à upserter : ${etablissements.length}`);
  etablissements.forEach((e) =>
    console.log(`  ${e.nom} — occupées: ${e.civieres_occupees}, taux: ${e.taux_occupation}%, attente: ${e.patients_en_attente}, DMS: ${e.dms_civiere}`)
  );

  // ─── 4. Upsert dans Supabase ──────────────────────────────────────────────
  const payload = {
    id: 1,
    etablissements,
    mis_a_jour: new Date().toISOString(),
  };

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_urgences`, {
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

  console.log('Données urgences mises à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, count: etablissements.length, etablissements }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
