/**
 * Helper CORS partagé pour les fonctions Netlify.
 *
 * Liste des origines autorisées lue depuis ALLOWED_ORIGINS (CSV).
 * Exemple: ALLOWED_ORIGINS="https://exemple.qc.ca,https://exemple.netlify.app"
 *
 * Si la variable n'est pas définie, retourne `*` (utile en dev local seulement).
 * En production, définissez TOUJOURS ALLOWED_ORIGINS pour éviter qu'un site
 * tiers consomme vos fonctions.
 */

export function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function corsHeadersFor(req, methods = 'GET, OPTIONS') {
  const allowed = getAllowedOrigins();
  const origin = req.headers.get('origin');
  let corsOrigin = '*';
  if (allowed.length) {
    corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
