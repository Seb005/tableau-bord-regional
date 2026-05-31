/**
 * Helper Sentry partagé pour les fonctions Netlify.
 *
 * - initSentry()        : initialise @sentry/node une seule fois par cold start.
 *                         Erreurs seulement (pas de tracing perf) pour limiter le quota.
 * - withSentry(handler) : wrappe un handler de fonction ; capture toute exception,
 *                         flush avant le gel du conteneur, puis relance/retourne 500.
 * - withCron(handler, slug) : withSentry + check-in Sentry Crons (alerte si le cron
 *                         échoue ou ne tourne pas).
 *
 * DSN lu depuis PUBLIC_SENTRY_DSN (le DSN client Sentry est public par design).
 * Sans DSN, tout est no-op : le code marche en local sans configuration.
 */

import * as Sentry from '@sentry/node';

const DSN = process.env.PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN || '';
let initialised = false;

function initSentry() {
  if (initialised || !DSN) return DSN ? true : false;
  Sentry.init({
    dsn: DSN,
    environment: process.env.CONTEXT || process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // erreurs seulement, pas de tracing perf
    release: process.env.COMMIT_REF || undefined,
  });
  initialised = true;
  return true;
}

/**
 * Wrappe un handler de fonction Netlify (req => Response | () => Response).
 * @param {Function} handler
 * @param {string} [name] nom logique pour le tag Sentry (optionnel)
 */
export function withSentry(handler, name) {
  return async (...args) => {
    const active = initSentry();
    try {
      return await handler(...args);
    } catch (err) {
      if (active) {
        Sentry.withScope((scope) => {
          if (name) scope.setTag('function', name);
          scope.setTag('runtime', 'netlify-function');
          Sentry.captureException(err);
        });
        await Sentry.flush(2000);
      }
      throw err;
    }
  };
}

/**
 * Comme withSentry, mais ajoute un check-in Sentry Crons.
 * @param {Function} handler
 * @param {string} monitorSlug identifiant du moniteur (ex. 'envoyer-rappels')
 * @param {string} [schedule] expression cron pour auto-créer le moniteur côté Sentry
 */
export function withCron(handler, monitorSlug, schedule) {
  return async (...args) => {
    const active = initSentry();
    if (!active) return handler(...args);

    const monitorConfig = schedule
      ? { schedule: { type: 'crontab', value: schedule }, checkinMargin: 5, maxRuntime: 10 }
      : undefined;
    const checkInId = Sentry.captureCheckIn(
      { monitorSlug, status: 'in_progress' },
      monitorConfig
    );

    try {
      const result = await handler(...args);
      Sentry.captureCheckIn({ checkInId, monitorSlug, status: 'ok' });
      return result;
    } catch (err) {
      Sentry.captureCheckIn({ checkInId, monitorSlug, status: 'error' });
      Sentry.withScope((scope) => {
        scope.setTag('function', monitorSlug);
        scope.setTag('runtime', 'netlify-cron');
        Sentry.captureException(err);
      });
      await Sentry.flush(2000);
      throw err;
    }
  };
}
