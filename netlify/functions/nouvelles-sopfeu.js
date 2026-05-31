import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — 8h et 14h chaque jour
 * Récupère le danger d'incendie depuis l'API publique SOPFEU
 * pour la zone La Sarre-Amos (MRC Abitibi-Ouest, code 870)
 * et met à jour la table `nouvelles_sopfeu` dans Supabase.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 *
 * API SOPFEU explorée via swagger :
 *   https://geofeux.sopfeu.qc.ca/sopfeu-api/swagger/v1/swagger.json
 *
 * Endpoints utilisés :
 *   GET /public/danger-incendie?noMrc=870
 *     → zones de danger pour la MRC Abitibi-Ouest (retourne zone 2 La Sarre-Amos)
 *     → champs : NumeroZone, NomZone, DangerJour1.Id, DangerJour1.DescriptionFr
 *   GET /public/feux-etat-situation?noRegionAdm=8
 *     → statistiques de feux pour Abitibi-Témiscamingue (région 8)
 *     → champ : FeuxEtatSituationStats.NbFeuxActifs
 *
 * Note : L'API publique SOPFEU n'expose pas l'indice IFM (FWI).
 *        Le champ indice_ifm est laissé à null.
 */

export const config = {
  schedule: '0 8,14 * * *', // Deux fois par jour : 8h et 14h UTC
};

const SOPFEU_BASE = 'https://geofeux.sopfeu.qc.ca/sopfeu-api';

// MRC Abitibi-Ouest (code 870) — contient la zone 2 "La Sarre-Amos"
const MRC_ABITIBI_OUEST = '870';

// Région administrative Abitibi-Témiscamingue (code 8)
const REGION_ADM_ABITIBI = 8;

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes : SUPABASE_URL ou SUPABASE_SERVICE_KEY');
    return new Response('Erreur de configuration', { status: 500 });
  }

  let saison_active = false;
  let niveau_danger = null;
  let indice_ifm = null;
  let zone = null;
  let feux_actifs = 0;

  // ─── 1. Danger incendie pour la MRC Abitibi-Ouest ────────────────────────
  try {
    const dangerRes = await fetch(
      `${SOPFEU_BASE}/public/danger-incendie?noMrc=${MRC_ABITIBI_OUEST}`
    );

    if (!dangerRes.ok) {
      console.warn(`SOPFEU danger-incendie HTTP ${dangerRes.status} — hors saison probable`);
    } else {
      const dangerData = await dangerRes.json();

      // La réponse a la forme [[zones...], {metadata}].
      // On extrait le premier élément (tableau de zones) puis on filtre.
      const zonesRaw = Array.isArray(dangerData) && Array.isArray(dangerData[0])
        ? dangerData[0]
        : Array.isArray(dangerData) ? dangerData : [];
      const zones = zonesRaw.filter((z) => z && typeof z.NumeroZone === 'number');

      if (zones.length > 0) {
        saison_active = true;

        // Priorité : zone 2 "La Sarre-Amos" (siège de la MRC Abitibi-Ouest)
        // Fallback : première zone retournée
        const zoneData =
          zones.find((z) => z.NumeroZone === 2) || zones[0];

        const danger = zoneData.DangerJour1;

        if (danger && danger.Id > 0) {
          niveau_danger = danger.DescriptionFr || null;
          zone = zoneData.NomZone || null;
        } else {
          // Id = 0 signifie pas de données (hors saison ou données non disponibles)
          console.warn('Danger Id = 0 pour la zone — données non disponibles');
          saison_active = false;
        }
      } else {
        console.warn('Aucune zone retournée par SOPFEU — hors saison probable');
      }
    }
  } catch (err) {
    console.error('Exception danger-incendie SOPFEU:', err.message);
    // On continue avec saison_active = false
  }

  // ─── 2. Nombre de feux actifs pour Abitibi-Témiscamingue ─────────────────
  try {
    const feuxRes = await fetch(
      `${SOPFEU_BASE}/public/feux-etat-situation?noRegionAdm=${REGION_ADM_ABITIBI}`
    );

    if (feuxRes.ok) {
      const feuxData = await feuxRes.json();
      const stats = feuxData?.FeuxEtatSituationStats;
      if (stats && typeof stats.NbFeuxActifs === 'number') {
        feux_actifs = stats.NbFeuxActifs;
      }
    } else {
      console.warn(`SOPFEU feux-etat-situation HTTP ${feuxRes.status}`);
    }
  } catch (err) {
    console.error('Exception feux-etat-situation SOPFEU:', err.message);
    // Non bloquant — feux_actifs reste à 0
  }

  // ─── 3. Upsert dans Supabase ──────────────────────────────────────────────
  const payload = {
    id: 1,
    niveau_danger,
    indice_ifm,  // null : non exposé par l'API publique SOPFEU
    zone,
    feux_actifs,
    saison_active,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour SOPFEU:', JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_sopfeu`, {
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

  console.log('Données SOPFEU mises à jour avec succès.');
  return new Response(
    JSON.stringify({
      ok: true,
      saison_active,
      niveau_danger,
      zone,
      feux_actifs,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
