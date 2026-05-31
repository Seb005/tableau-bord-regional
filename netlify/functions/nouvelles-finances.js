import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — tous les jours à 8h UTC
 * Récupère le prix de l'or (USD/oz) et les taux USD/CAD + EUR/CAD,
 * insère un snapshot quotidien dans nouvelles_finances_history,
 * calcule les variations vs il y a 7 jours,
 * et met à jour la table `nouvelles_finances` dans Supabase.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 *
 * APIs utilisées (sans clé, gratuites) :
 *   - https://api.gold-api.com/price/XAU                        → or USD/oz
 *   - https://api.frankfurter.dev/v1/latest?from=USD&to=CAD,EUR → taux de change
 */

export const config = {
  schedule: '0 8 * * *', // Tous les jours à 8h UTC
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function sevenDaysAgoIso() {
  return new Date(Date.now() - SEVEN_DAYS_MS).toISOString().split('T')[0];
}

function pctChange(current, previous) {
  if (!previous || previous <= 0 || current == null) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100; // 2 décimales
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  const supabaseHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  // ── 1. Lire la ligne actuelle pour la variation 1-jour (rétrocompatibilité)
  let prevOrUsd = null;
  let prevTauxUsdCad = null;
  try {
    const prevRes = await fetch(
      `${SUPABASE_URL}/rest/v1/nouvelles_finances?select=or_usd_oz,taux_usd_cad&id=eq.1`,
      { headers: supabaseHeaders }
    );
    if (prevRes.ok) {
      const prevData = await prevRes.json();
      if (prevData.length > 0) {
        prevOrUsd = prevData[0].or_usd_oz;
        prevTauxUsdCad = prevData[0].taux_usd_cad;
      }
    }
  } catch (err) {
    console.warn('Impossible de lire les valeurs précédentes:', err.message);
  }

  // ── 2. Or USD/oz (gold-api.com)
  let orUsdOz;
  try {
    const goldRes = await fetch('https://api.gold-api.com/price/XAU');
    if (!goldRes.ok) {
      console.error('Erreur gold-api.com:', await goldRes.text());
      return new Response('Erreur API or', { status: 500 });
    }
    const goldData = await goldRes.json();
    orUsdOz = goldData.price;
    if (!orUsdOz || typeof orUsdOz !== 'number') {
      console.error('Prix or invalide:', goldData);
      return new Response('Prix or invalide', { status: 500 });
    }
  } catch (err) {
    console.error('Exception gold-api.com:', err.message);
    return new Response('Exception API or', { status: 500 });
  }

  // ── 3. Taux USD/CAD et EUR/CAD (frankfurter.dev, un seul appel pour les 2)
  let tauxUsdCad;
  let tauxEurCad;
  try {
    const fxRes = await fetch('https://api.frankfurter.dev/v1/latest?from=CAD&to=USD,EUR');
    if (!fxRes.ok) {
      console.error('Erreur frankfurter.dev:', await fxRes.text());
      return new Response('Erreur API taux de change', { status: 500 });
    }
    const fxData = await fxRes.json();
    // L'API retourne CAD → USD et CAD → EUR. On convertit pour obtenir USD/CAD et EUR/CAD.
    const cadToUsd = fxData?.rates?.USD;
    const cadToEur = fxData?.rates?.EUR;
    if (!cadToUsd || typeof cadToUsd !== 'number' || !cadToEur || typeof cadToEur !== 'number') {
      console.error('Taux invalides:', fxData);
      return new Response('Taux invalides', { status: 500 });
    }
    // 1 USD = (1 / cadToUsd) CAD ;  1 EUR = (1 / cadToEur) CAD
    tauxUsdCad = 1 / cadToUsd;
    tauxEurCad = 1 / cadToEur;
  } catch (err) {
    console.error('Exception frankfurter.dev:', err.message);
    return new Response('Exception API taux de change', { status: 500 });
  }

  const orCadOz = orUsdOz * tauxUsdCad;
  const today = todayIso();

  // ── 4. Insérer le snapshot du jour dans l'historique (idempotent sur date)
  try {
    const histInsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/nouvelles_finances_history`,
      {
        method: 'POST',
        headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          date: today,
          or_usd_oz: orUsdOz,
          taux_usd_cad: tauxUsdCad,
          taux_eur_cad: tauxEurCad,
        }),
      }
    );
    if (!histInsertRes.ok) {
      console.warn('Insert history échoué:', await histInsertRes.text());
    }
  } catch (err) {
    console.warn('Exception insert history:', err.message);
  }

  // ── 5. Lire le snapshot d'il y a ~7 jours (ou le plus proche disponible)
  let or7dAgo = null;
  let usd7dAgo = null;
  let eur7dAgo = null;
  try {
    const cutoff = sevenDaysAgoIso();
    const histRes = await fetch(
      `${SUPABASE_URL}/rest/v1/nouvelles_finances_history?date=lte.${cutoff}&order=date.desc&limit=1&select=or_usd_oz,taux_usd_cad,taux_eur_cad`,
      { headers: supabaseHeaders }
    );
    if (histRes.ok) {
      const histData = await histRes.json();
      if (histData.length > 0) {
        or7dAgo = histData[0].or_usd_oz;
        usd7dAgo = histData[0].taux_usd_cad;
        eur7dAgo = histData[0].taux_eur_cad;
      }
    }
  } catch (err) {
    console.warn('Exception lecture history 7j:', err.message);
  }

  // ── 6. Calculs de variations
  const orVariationPct = pctChange(orUsdOz, prevOrUsd);            // 1 jour (legacy)
  const tauxVariationPct = pctChange(tauxUsdCad, prevTauxUsdCad);  // 1 jour (legacy)
  const orVariationPct7d = pctChange(orUsdOz, or7dAgo);
  const tauxUsdVariationPct7d = pctChange(tauxUsdCad, usd7dAgo);
  const tauxEurVariationPct7d = pctChange(tauxEurCad, eur7dAgo);

  const payload = {
    id: 1,
    or_usd_oz: Math.round(orUsdOz * 100) / 100,
    or_cad_oz: Math.round(orCadOz * 100) / 100,
    or_variation_pct: orVariationPct,
    taux_usd_cad: Math.round(tauxUsdCad * 10000) / 10000,
    taux_eur_cad: Math.round(tauxEurCad * 10000) / 10000,
    taux_variation_pct: tauxVariationPct,
    or_variation_pct_7d: orVariationPct7d,
    taux_usd_variation_pct_7d: tauxUsdVariationPct7d,
    taux_eur_variation_pct_7d: tauxEurVariationPct7d,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour finances:', JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_finances`, {
    method: 'POST',
    headers: { ...supabaseHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error('Erreur upsert Supabase:', err);
    return new Response('Erreur upsert Supabase', { status: 500 });
  }

  console.log('Finances mises à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, ...payload }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
