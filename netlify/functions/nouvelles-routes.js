import { withSentry } from '../lib/sentry.js';
/**
 * Fonction Netlify planifiée (cron) — toutes les 6 heures
 * Récupère l'état des routes depuis Québec 511 pour les routes
 * de l'Abitibi-Ouest : 117, 111, 393, 101.
 *
 * Source : https://www.quebec511.info/fr/Diffusion/EtatReseau/Route.aspx?id=NNN
 * Données : HTML parsé — tables etat_reseau avec entraves, avertissements.
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL         — ex. https://spkckgednirvphyjtkns.supabase.co
 *   SUPABASE_SERVICE_KEY — clé service role Supabase
 */

export const config = {
  schedule: '0 */3 * * *', // Toutes les 3 heures
};

const USER_AGENT =
  'Mozilla/5.0 (compatible; RegionalDashboardBot/1.0)';

const ROUTES = [
  { numero: '117', label: 'Route 117' },
  { numero: '111', label: 'Route 111' },
  { numero: '393', label: 'Route 393' },
  { numero: '101', label: 'Route 101' },
];

const BASE_URL =
  'https://www.quebec511.info/fr/Diffusion/EtatReseau/Route.aspx?id=';

/**
 * Extrait l'état et les détails d'une route à partir du HTML de sa page Quebec 511.
 *
 * Logique :
 * - Si la page contient la section "État du réseau" (table_etatreseau avec titreRegion)
 *   avec des incidents (entrave / avertissement), l'état est "Entraves" et les détails
 *   listent les incidents trouvés.
 * - Si aucun incident n'est trouvé après le bloc Dégel, l'état est "Dégagée".
 * - Les informations de dégel sont signalées séparément dans les détails.
 */
function parseRouteConditions(html, numero) {
  // Normalise les espaces non-sécables et les entités HTML courantes
  const normalized = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#233;/g, 'é')
    .replace(/&#234;/g, 'ê')
    .replace(/&#232;/g, 'è')
    .replace(/&#224;/g, 'à')
    .replace(/&#238;/g, 'î')
    .replace(/&#244;/g, 'ô')
    .replace(/&#251;/g, 'û')
    .replace(/&#249;/g, 'ù')
    .replace(/&#226;/g, 'â');

  const incidents = [];
  let hasDegel = false;

  // Détection de la période de dégel
  if (/Période de dégel/i.test(normalized)) {
    hasDegel = true;
  }

  // Détection des entraves : tables etat_reseau avec classe entrave e_min ou e_maj
  // Structure : <div Class="ico_route-g">ROUTE<span class="gauche entrave e_min|e_maj"/>
  const entravePattern =
    /<div[^>]*Class="ico_route-g"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/td>\s*<td[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>\s*(Entrave[\s\S]*?)<\/td>\s*<td[^>]*>\s*Direction[\s\S]*?<strong>([\s\S]*?)<\/strong>\s*<\/td>/gi;

  let match;
  while ((match = entravePattern.exec(normalized)) !== null) {
    const localisation = match[1].replace(/<[^>]+>/g, '').trim();
    const typeEntrave = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const direction = match[3].replace(/<[^>]+>/g, '').trim();
    if (localisation) {
      incidents.push(`${typeEntrave} — ${localisation} (dir. ${direction})`);
    }
  }

  // Détection des avertissements (tableAvertissement)
  // Structure : table id="..._tableAvertissement" avec tdContenu
  const avertPattern =
    /<table[^>]*tableAvertissement[^>]*>[\s\S]*?<td[^>]*tdContenu[^>]*>([\s\S]*?)<\/td>/gi;

  while ((match = avertPattern.exec(normalized)) !== null) {
    const contenu = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (contenu && contenu.length > 5) {
      incidents.push(`Avertissement — ${contenu.substring(0, 200)}`);
    }
  }

  // Vérification que la page contient bien la section État du réseau (pas juste Dégel)
  const hasEtatSection = /titreRegion[^>]*>(?!Dégel)[^<]+</.test(normalized);

  let etat;
  let details;

  if (incidents.length > 0) {
    // Détermine si c'est surtout des entraves majeures
    const hasMajeure = /Majeure/i.test(incidents.join(' '));
    etat = hasMajeure ? 'Entraves majeures' : 'Entraves mineures';
    details = incidents.join(' | ');
  } else if (hasDegel && !hasEtatSection) {
    // Seulement la section Dégel — route dégagée mais en période de dégel
    etat = 'Dégagée';
    details = 'Période de dégel en cours — restrictions de charge possibles';
  } else if (!hasEtatSection && !hasDegel) {
    // Page vide ou erreur
    etat = 'Inconnu';
    details = 'Données non disponibles';
  } else {
    etat = 'Dégagée';
    details = hasDegel ? 'Période de dégel en cours — restrictions de charge possibles' : 'Aucune entrave signalée';
  }

  return { etat, details };
}

const __sentryHandler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Variables d\'environnement manquantes');
    return new Response('Erreur de configuration', { status: 500 });
  }

  const routes = [];

  for (const route of ROUTES) {
    const url = `${BASE_URL}${route.numero}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });

      if (!res.ok) {
        console.warn(`Erreur HTTP ${res.status} pour route ${route.numero}`);
        routes.push({
          numero: route.numero,
          etat: 'Inconnu',
          details: `Erreur HTTP ${res.status}`,
        });
        continue;
      }

      const html = await res.text();
      const { etat, details } = parseRouteConditions(html, route.numero);

      console.log(`Route ${route.numero}: ${etat} — ${details.substring(0, 80)}`);
      routes.push({ numero: route.numero, etat, details });
    } catch (err) {
      console.error(`Exception pour route ${route.numero}:`, err.message);
      routes.push({
        numero: route.numero,
        etat: 'Inconnu',
        details: 'Erreur lors de la récupération des données',
      });
    }
  }

  const payload = {
    id: 1,
    routes,
    mis_a_jour: new Date().toISOString(),
  };

  console.log('Mise à jour routes:', JSON.stringify(payload));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/nouvelles_routes`, {
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

  console.log('Routes mises à jour avec succès.');
  return new Response(
    JSON.stringify({ ok: true, routes }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export default withSentry(__sentryHandler);
