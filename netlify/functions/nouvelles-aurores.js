import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 6 heures
 * Récupère l'indice Kp géomagnétique depuis NOAA SWPC, calcule la phase
 * lunaire et identifie les pluies de météores actives pour fournir un
 * tableau "Ciel nocturne" complet pour Abitibi-Ouest (La Sarre, QC).
 *
 * Sources :
 *   - Aurores : https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
 *   - Lune   : algorithme de calcul (pas d'API externe)
 *   - Météores : calendrier IMO (International Meteor Organization) intégré
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 */6 * * *', // Toutes les 6 heures
};

// ─── Aurores ──────────────────────────────────────────────────────────

function niveauKp(kp) {
  if (kp < 3) return 'Calme';
  if (kp < 4) return 'Modéré';
  if (kp < 5) return 'Actif';
  if (kp < 6) return 'Tempête mineure';
  if (kp < 7) return 'Tempête modérée';
  return 'Tempête majeure';
}

function probabiliteAurore(kp) {
  if (kp < 3) return 5;
  if (kp < 4) return 15;
  if (kp < 5) return 30;
  if (kp < 6) return 60;
  if (kp < 7) return 80;
  return 95;
}

// ─── Phase lunaire (algorithme de Conway simplifié) ───────────────────

function phaseLunaire(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // Calcul de l'âge lunaire approximatif (jours depuis la dernière nouvelle lune)
  // Basé sur le cycle synodique moyen de 29.53059 jours
  const lp = 2551443; // durée du cycle lunaire en secondes
  const newMoon = new Date(1970, 0, 7, 20, 35, 0).getTime() / 1000; // nouvelle lune connue
  const now = date.getTime() / 1000;
  const phase = ((now - newMoon) % lp) / lp;

  const ageLunaire = phase * 29.53;
  const illumination = Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);

  let nom, emoji;
  if (ageLunaire < 1.85) {
    nom = 'Nouvelle lune'; emoji = '🌑';
  } else if (ageLunaire < 5.53) {
    nom = 'Premier croissant'; emoji = '🌒';
  } else if (ageLunaire < 9.22) {
    nom = 'Premier quartier'; emoji = '🌓';
  } else if (ageLunaire < 12.91) {
    nom = 'Gibbeuse croissante'; emoji = '🌔';
  } else if (ageLunaire < 16.61) {
    nom = 'Pleine lune'; emoji = '🌕';
  } else if (ageLunaire < 20.30) {
    nom = 'Gibbeuse décroissante'; emoji = '🌖';
  } else if (ageLunaire < 23.99) {
    nom = 'Dernier quartier'; emoji = '🌗';
  } else if (ageLunaire < 27.68) {
    nom = 'Dernier croissant'; emoji = '🌘';
  } else {
    nom = 'Nouvelle lune'; emoji = '🌑';
  }

  return { nom, emoji, illumination };
}

// ─── Pluies de météores (calendrier annuel IMO) ──────────────────────
// Dates typiques récurrentes, le pic peut varier de ±1 jour selon l'année

const ESSAIMS_METEORES = [
  { nom: 'Quadrantides',           debut: '01-01', fin: '01-10', pic_debut: '01-03', pic_fin: '01-04', taux: 110 },
  { nom: 'Lyrides',                debut: '04-14', fin: '04-30', pic_debut: '04-22', pic_fin: '04-23', taux: 18 },
  { nom: 'Êta Aquarides',          debut: '04-19', fin: '05-28', pic_debut: '05-05', pic_fin: '05-06', taux: 50 },
  { nom: 'Delta Aquarides Sud',    debut: '07-12', fin: '08-23', pic_debut: '07-30', pic_fin: '07-31', taux: 25 },
  { nom: 'Perséides',              debut: '07-17', fin: '08-24', pic_debut: '08-12', pic_fin: '08-13', taux: 100 },
  { nom: 'Draconides',             debut: '10-06', fin: '10-10', pic_debut: '10-08', pic_fin: '10-09', taux: 10 },
  { nom: 'Orionides',              debut: '10-02', fin: '11-07', pic_debut: '10-21', pic_fin: '10-22', taux: 20 },
  { nom: 'Léonides',               debut: '11-06', fin: '11-30', pic_debut: '11-17', pic_fin: '11-18', taux: 15 },
  { nom: 'Géminides',              debut: '12-04', fin: '12-20', pic_debut: '12-14', pic_fin: '12-15', taux: 150 },
  { nom: 'Ursides',                debut: '12-17', fin: '12-26', pic_debut: '12-22', pic_fin: '12-23', taux: 10 },
];

function essaimActif(date) {
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  // Trouver l'essaim actif le plus intéressant (priorité au taux horaire)
  let meilleur = null;
  for (const e of ESSAIMS_METEORES) {
    const actif = mmdd >= e.debut && mmdd <= e.fin;
    if (actif && (!meilleur || e.taux > meilleur.taux)) {
      meilleur = e;
    }
  }

  if (!meilleur) return null;

  const estPic = mmdd >= meilleur.pic_debut && mmdd <= meilleur.pic_fin;
  return {
    nom: meilleur.nom,
    taux_horaire: meilleur.taux,
    pic_debut: meilleur.pic_debut,
    pic_fin: meilleur.pic_fin,
    est_pic: estPic,
  };
}

// ─── Handler principal ───────────────────────────────────────────────

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  // ── Aurores (NOAA SWPC) ──
  const kpUrl = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

  let kpData;
  try {
    const kpRes = await fetch(kpUrl);
    if (!kpRes.ok) {
      const err = await kpRes.text();
      console.error('Erreur NOAA SWPC:', err);
      return new Response('Erreur NOAA SWPC', { status: 500 });
    }
    kpData = await kpRes.json();
  } catch (err) {
    console.error('Exception NOAA SWPC:', err.message);
    return new Response('Exception NOAA SWPC', { status: 500 });
  }

  if (!Array.isArray(kpData) || kpData.length === 0) {
    console.error('Données NOAA SWPC vides ou format inattendu');
    return new Response('Données NOAA SWPC invalides', { status: 500 });
  }

  const latest = kpData[kpData.length - 1];
  const kp = latest.estimated_kp ?? latest.kp_index ?? 0;

  // ── Lune ──
  const now = new Date();
  const lune = phaseLunaire(now);

  // ── Météores ──
  const meteore = essaimActif(now);

  const payload = {
    id: 1,
    kp_index: kp,
    probabilite_pct: probabiliteAurore(kp),
    niveau: niveauKp(kp),
    visible_quebec: kp >= 5,
    lune_phase: lune.nom,
    lune_illumination: lune.illumination,
    lune_emoji: lune.emoji,
    meteore_nom: meteore?.nom ?? null,
    meteore_taux_horaire: meteore?.taux_horaire ?? null,
    meteore_pic_debut: meteore?.pic_debut ?? null,
    meteore_pic_fin: meteore?.pic_fin ?? null,
    mis_a_jour: now.toISOString(),
  };

  console.log('Mise à jour ciel nocturne:', JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_aurores`, {
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

  console.log('Ciel nocturne mis à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, kp, niveau: payload.niveau, lune: lune.nom, meteore: meteore?.nom ?? null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
