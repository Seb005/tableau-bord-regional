import { withSentry } from '../lib/sentry.js';
import { corsHeadersFor } from '../lib/cors.js';
/**
 * Netlify Function — Proxy de lecture des nouvelles Supabase
 * Agrège 7 tables en une seule réponse JSON pour éviter d'exposer la clé Supabase au client.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   ALLOWED_ORIGINS — CSV des origines autorisées (CORS)
 */

const __sentryHandler = async (req) => {
  const corsHeaders = corsHeadersFor(req, 'GET, OPTIONS');

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ error: 'Configuration manquante' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const supabaseHeaders = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  const fetchTable = (table, query = '?select=*') =>
    fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: supabaseHeaders });

  try {
    const [
      resMeteo,
      resEssence,
      resSopfeu,
      resFinances,
      resHydro,
      resRoutes,
      resAlertes,
      resUrgences,
      resEmplois,
      resBornes,
      resLoisirs,
      resAir,
      resAurores,
      resEau,
      resInternet,
      resCciao,
      resTransport,
      resArticles,
    ] = await Promise.all([
      fetchTable('nouvelles_meteo'),
      fetchTable('nouvelles_essence'),
      fetchTable('nouvelles_sopfeu'),
      fetchTable('nouvelles_finances'),
      fetchTable('nouvelles_hydro'),
      fetchTable('nouvelles_routes'),
      fetchTable('nouvelles_alertes'),
      fetchTable('nouvelles_urgences'),
      fetchTable('nouvelles_emplois'),
      fetchTable('nouvelles_bornes_electriques'),
      fetchTable('nouvelles_activites_loisirs'),
      fetchTable('nouvelles_air'),
      fetchTable('nouvelles_aurores'),
      fetchTable('nouvelles_eau'),
      fetchTable('nouvelles_internet'),
      fetchTable('nouvelles_cciao'),
      fetchTable('nouvelles_transport'),
      fetchTable(
        'nouvelles_articles',
        `?select=*&date_publication=gte.${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}&order=date_publication.desc&limit=40`
      ),
    ]);

    const [
      dataMeteo,
      dataEssence,
      dataSopfeu,
      dataFinances,
      dataHydro,
      dataRoutes,
      dataAlertes,
      dataUrgences,
      dataEmplois,
      dataBornes,
      dataLoisirs,
      dataAir,
      dataAurores,
      dataEau,
      dataInternet,
      dataCciao,
      dataTransport,
      dataArticles,
    ] = await Promise.all([
      resMeteo.json(),
      resEssence.json(),
      resSopfeu.json(),
      resFinances.json(),
      resHydro.json(),
      resRoutes.json(),
      resAlertes.json(),
      resUrgences.json(),
      resEmplois.json(),
      resBornes.json(),
      resLoisirs.json(),
      resAir.json(),
      resAurores.json(),
      resEau.json(),
      resInternet.json(),
      resCciao.json(),
      resTransport.json(),
      resArticles.json(),
    ]);

    const payload = {
      meteo: Array.isArray(dataMeteo) ? (dataMeteo[0] ?? null) : null,
      essence: Array.isArray(dataEssence) ? (dataEssence[0] ?? null) : null,
      sopfeu: Array.isArray(dataSopfeu) ? (dataSopfeu[0] ?? null) : null,
      finances: Array.isArray(dataFinances) ? (dataFinances[0] ?? null) : null,
      hydro: Array.isArray(dataHydro) ? (dataHydro[0] ?? null) : null,
      routes: Array.isArray(dataRoutes) ? (dataRoutes[0] ?? null) : null,
      alertes: Array.isArray(dataAlertes) ? (dataAlertes[0] ?? null) : null,
      urgences: Array.isArray(dataUrgences) ? (dataUrgences[0] ?? null) : null,
      emplois: Array.isArray(dataEmplois) ? (dataEmplois[0] ?? null) : null,
      bornes: Array.isArray(dataBornes) ? (dataBornes[0] ?? null) : null,
      loisirs: Array.isArray(dataLoisirs) ? (dataLoisirs[0] ?? null) : null,
      air: Array.isArray(dataAir) ? (dataAir[0] ?? null) : null,
      aurores: Array.isArray(dataAurores) ? (dataAurores[0] ?? null) : null,
      eau: Array.isArray(dataEau) ? (dataEau[0] ?? null) : null,
      internet: Array.isArray(dataInternet) ? (dataInternet[0] ?? null) : null,
      cciao: Array.isArray(dataCciao) ? (dataCciao[0] ?? null) : null,
      transport: Array.isArray(dataTransport) ? (dataTransport[0] ?? null) : null,
      articles: Array.isArray(dataArticles) ? dataArticles : [],
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error('Erreur nouvelles-proxy:', err);
    return new Response(JSON.stringify({ error: 'Erreur lors de la récupération des données' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
};

export const config = {
  path: '/.netlify/functions/nouvelles-proxy',
};

export default withSentry(__sentryHandler);
