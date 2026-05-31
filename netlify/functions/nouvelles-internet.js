import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — une fois par semaine
 * Interroge les données M-Lab (Measurement Lab) sur Google BigQuery pour
 * obtenir les vitesses Internet réelles mesurées en Abitibi-Ouest.
 *
 * Source : M-Lab NDT Unified Views (measurement-lab.ndt.unified_downloads/uploads)
 *   - Données ouvertes, hébergées sur Google BigQuery
 *   - Tests effectués via le CIRA Internet Performance Test et autres clients NDT
 *
 * Bounding box Abitibi-Ouest (~80 km autour de La Sarre) :
 *   Lat  48.08 → 49.52
 *   Lon -80.12 → -78.28
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL          — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY  — clé service role Supabase
 *   GCP_CREDENTIALS_JSON  — clé de compte de service Google Cloud (JSON stringifié)
 */

import { BigQuery } from '@google-cloud/bigquery';

export const config = {
  schedule: '0 6 * * 1', // Chaque lundi à 6h UTC
};

const ASN_NAMES = {
  577:    'Bell (Télébec)',
  6327:   'Bell (Sympatico)',
  812:    'Rogers',
  5769:   'Vidéotron',
  11260:  'Cogeco',
  21949:  'Xplornet',
  36522:  'Xplore (ex-Xplornet)',
  14061:  'Starlink (SpaceX)',
  394272: 'Starlink',
  6939:   'Hurricane Electric',
  15290:  'Allstream',
  16696:  'Bell MTS',
  6453:   'TATA',
  174:    'Cogent',
  20057:  'AT&T',
  3356:   'Lumen',
  35911:  'Bell Canada',
  13335:  'Cloudflare',
  398041: 'Fibrenoire',
  376:    'RISQ',
  36183:  'TELUS',
  1403:   'EBOX',
  22995:  'Xplornet',
};

function asnName(asn) {
  return ASN_NAMES[asn] || `ASN ${asn}`;
}

const PERIODE_JOURS = 180;

function buildQuery(table, dateLimite) {
  return `
    SELECT
      client.Network.ASNumber AS asn,
      COUNT(*) AS nb_tests,
      ROUND(APPROX_QUANTILES(a.MeanThroughputMbps, 100)[SAFE_ORDINAL(50)], 2) AS mediane_mbps,
      ROUND(APPROX_QUANTILES(a.MinRTT, 100)[SAFE_ORDINAL(50)], 1) AS mediane_rtt_ms
    FROM \`measurement-lab.ndt.${table}\`
    WHERE
      date >= "${dateLimite}"
      AND client.Geo.CountryCode = "CA"
      AND client.Geo.latitude BETWEEN 48.08 AND 49.52
      AND client.Geo.longitude BETWEEN -80.12 AND -78.28
    GROUP BY asn
    HAVING nb_tests >= 5
    ORDER BY nb_tests DESC
    LIMIT 15
  `;
}

function buildGlobalQuery(table, dateLimite) {
  return `
    SELECT
      ROUND(APPROX_QUANTILES(a.MeanThroughputMbps, 100)[SAFE_ORDINAL(50)], 2) AS mediane_mbps,
      COUNT(*) AS nb_tests
    FROM \`measurement-lab.ndt.${table}\`
    WHERE
      date >= "${dateLimite}"
      AND client.Geo.CountryCode = "CA"
      AND client.Geo.region = "QC"
  `;
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GCP_CREDS = process.env.GCP_CREDENTIALS_JSON;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables Supabase manquantes');
    return new Response('Erreur de configuration Supabase', { status: 500 });
  }

  if (!GCP_CREDS) {
    console.error('GCP_CREDENTIALS_JSON manquant — la fonction internet nécessite un compte de service Google Cloud');
    return new Response('GCP_CREDENTIALS_JSON manquant', { status: 500 });
  }

  let credentials;
  try {
    credentials = JSON.parse(GCP_CREDS);
  } catch (e) {
    console.error('GCP_CREDENTIALS_JSON invalide:', e.message);
    return new Response('GCP_CREDENTIALS_JSON invalide', { status: 500 });
  }

  const bq = new BigQuery({
    projectId: credentials.quota_project_id || credentials.project_id || 'cjeao-mlab',
    credentials,
  });

  const dateLimite = new Date(Date.now() - PERIODE_JOURS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  try {
    // Requêtes en parallèle : downloads + uploads locaux, downloads + uploads QC
    const [dlRows, ulRows, dlQcRows, ulQcRows] = await Promise.all([
      bq.query({ query: buildQuery('unified_downloads', dateLimite) }).then(r => r[0]),
      bq.query({ query: buildQuery('unified_uploads', dateLimite) }).then(r => r[0]),
      bq.query({ query: buildGlobalQuery('unified_downloads', dateLimite) }).then(r => r[0]),
      bq.query({ query: buildGlobalQuery('unified_uploads', dateLimite) }).then(r => r[0]),
    ]);

    // Fusionner downloads + uploads par ASN
    const parASN = {};
    for (const row of dlRows) {
      parASN[row.asn] = {
        asn: row.asn,
        nom: asnName(row.asn),
        download_mbps: row.mediane_mbps,
        latence_ms: row.mediane_rtt_ms,
        nb_tests_dl: row.nb_tests,
      };
    }
    for (const row of ulRows) {
      if (parASN[row.asn]) {
        parASN[row.asn].upload_mbps = row.mediane_mbps;
        parASN[row.asn].nb_tests_ul = row.nb_tests;
      } else {
        parASN[row.asn] = {
          asn: row.asn,
          nom: asnName(row.asn),
          upload_mbps: row.mediane_mbps,
          nb_tests_ul: row.nb_tests,
        };
      }
    }

    const fournisseurs = Object.values(parASN)
      .sort((a, b) => (b.nb_tests_dl || 0) - (a.nb_tests_dl || 0));

    // Médianes globales locales (tous fournisseurs confondus)
    const totalTests = fournisseurs.reduce((s, f) => s + (f.nb_tests_dl || 0), 0);
    const allDownloads = fournisseurs
      .filter(f => f.download_mbps != null)
      .map(f => f.download_mbps)
      .sort((a, b) => a - b);
    const allUploads = fournisseurs
      .filter(f => f.upload_mbps != null)
      .map(f => f.upload_mbps)
      .sort((a, b) => a - b);

    const median = arr => arr.length ? arr[Math.floor(arr.length / 2)] : null;

    const comparaisonQc = {
      download_qc_mbps: dlQcRows[0]?.mediane_mbps ?? null,
      upload_qc_mbps: ulQcRows[0]?.mediane_mbps ?? null,
      nb_tests_qc: dlQcRows[0]?.nb_tests ?? null,
    };

    const payload = {
      id: 1,
      fournisseurs: JSON.stringify(fournisseurs),
      mediane_download_mbps: median(allDownloads),
      mediane_upload_mbps: median(allUploads),
      mediane_latence_ms: fournisseurs[0]?.latence_ms ?? null,
      nb_tests: totalTests,
      periode_jours: PERIODE_JOURS,
      comparaison_qc: JSON.stringify(comparaisonQc),
      mis_a_jour: new Date().toISOString(),
    };

    console.log('Internet Abitibi-Ouest:', JSON.stringify(payload));

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_internet`, {
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

    console.log(`Internet mis à jour: ${fournisseurs.length} FAI, ${totalTests} tests`);
    return new Response(
      JSON.stringify({ ok: true, fournisseurs: fournisseurs.length, tests: totalTests }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Erreur BigQuery:', err.message);
    return new Response(`Erreur BigQuery: ${err.message}`, { status: 500 });
  }
};

export default withSentry(__sentryHandler);
