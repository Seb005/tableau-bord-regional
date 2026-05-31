import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 4 heures
 * Récupère les données de pannes d'électricité depuis Hydro-Québec Info-Pannes
 * pour la région Abitibi-Ouest (MRC 870) et met à jour la table `nouvelles_hydro`.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 *
 * API Hydro-Québec Info-Pannes (découvertes par exploration du site infopannes.solutions.hydroquebec.com) :
 *
 *   1. BIS (Bilan Interruptions Service) — agrégats par région
 *      GET https://services-bs.solutions.hydroquebec.com/pan/web/api/v1/bis
 *      → tableau de { id, nbClientRaccorde, nbClientInterrompu, nbPanne }
 *      → id "870" correspond à la MRC Abitibi-Ouest
 *      → accès public, pas d'authentification requise
 *
 *   2. ArcGIS FeatureServer — points de pannes géolocalisés
 *      GET https://services5.arcgis.com/0akaykIdiPuMhFIy/arcgis/rest/services/bs_infoPannes_prd_vue/FeatureServer/0/query
 *      → filtre spatial sur la bbox Abitibi-Ouest (coordonnées Web Mercator)
 *      → champs : idInterruption, panneMajeure, dateCreation
 *      → accès public (ArcGIS Feature Service)
 *
 *   Source de configuration régionale :
 *      GET https://infopannes.solutions.hydroquebec.com/assets/data/bilan-par-region.json
 *      → id "870" = Abitibi-Ouest, coords: s=48.43, o=-79.52, n=49.01, e=-78.64
 */

export const config = {
  schedule: '0 * * * *', // Toutes les heures (pannes = données qui bougent vite)
};

// ── Constantes ────────────────────────────────────────────────────────────────

const BIS_URL = 'https://services-bs.solutions.hydroquebec.com/pan/web/api/v1/bis';
const ARCGIS_BASE =
  'https://services5.arcgis.com/0akaykIdiPuMhFIy/arcgis/rest/services/bs_infoPannes_prd_vue/FeatureServer/0';

// MRC Abitibi-Ouest — id dans le BIS et le fichier bilan-par-region.json
const ABITIBI_OUEST_ID = '870';

// Bounding box Abitibi-Ouest en Web Mercator (EPSG:3857)
// Source : coords dans bilan-par-region.json pour id="870"
//   s=48.42999393, o=-79.5177707, n=49.00962457, e=-78.64305555
const BBOX_WKID = 102100;
const BBOX = {
  xmin: -8851878,
  ymin: 6178691,
  xmax: -8754505,
  ymax: 6276495,
};

// ── Fonctions utilitaires ─────────────────────────────────────────────────────

/**
 * Extrait un label de secteur lisible depuis l'idInterruption Hydro-Québec.
 * Format : "LAV-I-59623-1" → code territoire + numéro séquentiel
 * Le préfixe de 3 lettres identifie le secteur opérationnel HQ (ex. LAV = La Sarre).
 */
function secteurDepuisId(idInterruption) {
  if (!idInterruption) return null;
  // Format attendu : CODE-TYPE-NUMERO-SEQ
  const parts = idInterruption.split('-');
  return parts[0] || idInterruption;
}

// ── Handler principal ─────────────────────────────────────────────────────────

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(
      "Variables d'environnement manquantes : SUPABASE_URL ou SUPABASE_SERVICE_KEY"
    );
    return new Response('Erreur de configuration', { status: 500 });
  }

  let pannes_actives = 0;
  let clients_touches = 0;
  let details = [];

  // ─── 1. BIS — agrégats Abitibi-Ouest ──────────────────────────────────────
  try {
    const bisRes = await fetch(BIS_URL);

    if (!bisRes.ok) {
      console.warn(`BIS HTTP ${bisRes.status} — données non disponibles`);
    } else {
      const bisData = await bisRes.json();

      // Chercher l'entrée pour la MRC Abitibi-Ouest (id = "870")
      const abitibiEntry = Array.isArray(bisData)
        ? bisData.find((b) => b.id === ABITIBI_OUEST_ID)
        : null;

      if (abitibiEntry) {
        pannes_actives = abitibiEntry.nbPanne ?? 0;
        clients_touches = abitibiEntry.nbClientInterrompu ?? 0;
        console.log(
          `BIS Abitibi-Ouest : ${pannes_actives} pannes, ${clients_touches} clients touchés`
        );
      } else {
        console.warn(
          `Entrée Abitibi-Ouest (id=${ABITIBI_OUEST_ID}) introuvable dans le BIS`
        );
      }
    }
  } catch (err) {
    console.error('Exception BIS:', err.message);
    // Non bloquant — on continue avec pannes_actives = 0
  }

  // ─── 2. ArcGIS — détails des pannes géolocalisées ─────────────────────────
  if (pannes_actives > 0) {
    try {
      const geomParam = JSON.stringify({
        ...BBOX,
        spatialReference: { wkid: BBOX_WKID },
      });

      const params = new URLSearchParams({
        geometry: geomParam,
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'idInterruption,panneMajeure,dateCreation',
        returnGeometry: 'false',
        f: 'json',
        inSR: String(BBOX_WKID),
        outSR: '4326',
      });

      const arcgisUrl = `${ARCGIS_BASE}/query?${params.toString()}`;
      const arcgisRes = await fetch(arcgisUrl);

      if (!arcgisRes.ok) {
        console.warn(`ArcGIS HTTP ${arcgisRes.status} — détails non disponibles`);
      } else {
        const arcgisData = await arcgisRes.json();
        const features = arcgisData.features ?? [];

        details = features.map((f) => {
          const attrs = f.attributes ?? {};
          const debut = attrs.dateCreation
            ? new Date(attrs.dateCreation).toISOString()
            : null;

          return {
            secteur: secteurDepuisId(attrs.idInterruption),
            id_interruption: attrs.idInterruption ?? null,
            panne_majeure: attrs.panneMajeure === 1,
            debut,
          };
        });

        console.log(`ArcGIS : ${details.length} panne(s) géolocalisée(s) en Abitibi-Ouest`);
      }
    } catch (err) {
      console.error('Exception ArcGIS:', err.message);
      // Non bloquant — details reste []
    }
  }

  // ─── 3. Upsert dans Supabase ───────────────────────────────────────────────
  const payload = {
    id: 1,
    pannes_actives,
    clients_touches,
    details,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour nouvelles_hydro:', JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_hydro`, {
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
    const errText = await upsertRes.text();
    console.error('Erreur upsert Supabase:', errText);
    return new Response('Erreur upsert Supabase', { status: 500 });
  }

  console.log('Données Hydro-Québec mises à jour avec succès.');
  return new Response(
    JSON.stringify({
      ok: true,
      pannes_actives,
      clients_touches,
      details_count: details.length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
