import {
  SW_CONTROLLER_TIMEOUT,
} from './constants';
import { ensureMapCacheEpochReset, MAP_CACHE_EPOCH } from '../../lib/mapCacheEpoch';
import { logger, syncLogLevelToServiceWorker, getLogLevel } from '@/shared/lib/logger';

const MAP_CACHE_AUTO_RELOAD_SESSION_KEY = 'redview:map-cache-auto-reload';

function getServiceWorkerEpoch(serviceWorker: ServiceWorker | null | undefined): string | null {
  if (!serviceWorker?.scriptURL) return null;
  try {
    return new URL(serviceWorker.scriptURL).searchParams.get('rv-map-cache-epoch');
  } catch {
    return null;
  }
}

function hasReloadedForCurrentEpoch(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(MAP_CACHE_AUTO_RELOAD_SESSION_KEY) === MAP_CACHE_EPOCH;
  } catch {
    return false;
  }
}

function markReloadedForCurrentEpoch(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MAP_CACHE_AUTO_RELOAD_SESSION_KEY, MAP_CACHE_EPOCH);
  } catch {
    /* échecs de stockage ignorés */
  }
}

function registrationHasTargetEpoch(
  registration: ServiceWorkerRegistration | null | undefined,
): boolean {
  if (!registration) return false;
  return getServiceWorkerEpoch(registration.installing) === MAP_CACHE_EPOCH
    || getServiceWorkerEpoch(registration.waiting) === MAP_CACHE_EPOCH
    || getServiceWorkerEpoch(registration.active) === MAP_CACHE_EPOCH;
}

/**
 * Recharge la page une fois que le worker de l'époque courante la contrôle,
 * pour que rien de ce qui a été chargé via le worker précédent ne survive —
 * seulement quand un worker d'une autre époque a servi cette page au
 * chargement. Toute autre page n'a rien à abandonner : non contrôlée (première
 * visite, données du site effacées, Ctrl+Maj+R), le nouveau worker en prend le
 * contrôle et le bootstrap de la carte récupère le contrôleur (`swReady` /
 * `swLateReady`) ; déjà servie par le worker courant (chaque nouvel onglet d'un
 * utilisateur qui revient), elle est à jour. Les deux rechargeaient quand même
 * une fois, ce qui perdait les premières secondes du chargement de la carte
 * (`bench:dashboard -- --scenario sw`).
 */
function scheduleEpochTakeoverReload(
  registration: ServiceWorkerRegistration | null | undefined,
  epochReset: boolean,
  servedByOtherEpoch: boolean,
): void {
  if (typeof window === 'undefined' || !servedByOtherEpoch || hasReloadedForCurrentEpoch()) return;

  const hasTargetRegistration = registrationHasTargetEpoch(registration);
  if (!epochReset && !hasTargetRegistration) return;

  let reloaded = false;
  const reloadOnce = (reason: string) => {
    if (reloaded || hasReloadedForCurrentEpoch()) return;
    reloaded = true;
    markReloadedForCurrentEpoch();
    logger.sw.warn(`map cache epoch changed; reloading page once (${reason})`);
    window.location.reload();
  };

  const currentEpoch = getServiceWorkerEpoch(navigator.serviceWorker.controller);
  if (currentEpoch === MAP_CACHE_EPOCH) {
    reloadOnce('controller already updated');
    return;
  }

  const maybeReloadFromRegistration = (reason: string) => {
    if (!registrationHasTargetEpoch(registration)) return;
    if (getServiceWorkerEpoch(navigator.serviceWorker.controller) === MAP_CACHE_EPOCH) {
      reloadOnce(`${reason}: controller updated`);
      return;
    }
    const activeEpoch = getServiceWorkerEpoch(registration?.active);
    if (activeEpoch === MAP_CACHE_EPOCH) {
      reloadOnce(`${reason}: target registration active without takeover`);
    }
  };

  const trackedWorker = registration?.installing ?? registration?.waiting ?? null;

  const onControllerChange = () => {
    if (getServiceWorkerEpoch(navigator.serviceWorker.controller) !== MAP_CACHE_EPOCH) return;
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    trackedWorker?.removeEventListener('statechange', onTrackedWorkerStateChange);
    clearTimeout(fallbackTimer);
    reloadOnce('controllerchange');
  };

  const onTrackedWorkerStateChange = () => {
    maybeReloadFromRegistration(`registration state=${trackedWorker?.state ?? 'unknown'}`);
  };

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  trackedWorker?.addEventListener('statechange', onTrackedWorkerStateChange);
  const fallbackTimer = window.setTimeout(() => {
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    trackedWorker?.removeEventListener('statechange', onTrackedWorkerStateChange);
    if (registrationHasTargetEpoch(registration)) {
      reloadOnce('takeover timeout with target registration present');
      return;
    }
    if (epochReset) {
      reloadOnce('takeover timeout after epoch reset');
    }
  }, 2500);

  maybeReloadFromRegistration('post-register');
}

function notifyMapCacheReset(serviceWorker: ServiceWorker | null | undefined): void {
  serviceWorker?.postMessage({
    type: 'PURGE_MAP_CACHES',
    epoch: MAP_CACHE_EPOCH,
  });
}

function notifyRegistrationMapCacheReset(
  registration: ServiceWorkerRegistration | null | undefined,
): void {
  if (!registration) return;
  notifyMapCacheReset(registration.installing);
  notifyMapCacheReset(registration.waiting);
  notifyMapCacheReset(registration.active);
}

/**
 * Une page rechargée de force (Ctrl+Maj+R) n'est jamais contrôlée, même si le
 * worker est déjà actif : son handler d'activation — le seul endroit qui appelle
 * `clients.claim()` — ne se relancera pas. On demande au worker actif de nous
 * prendre en charge, pour que `controllerchange` arrive en quelques
 * millisecondes au lieu de laisser la carte sur le repli AWS à 30 m jusqu'à une
 * réinstallation complète.
 */
function requestClaimFromActiveWorker(
  registration: ServiceWorkerRegistration | null | undefined,
): void {
  if (navigator.serviceWorker.controller) return;
  const active = registration?.active;
  if (!active) return;
  try {
    active.postMessage({ type: 'CLAIM_CLIENTS' });
  } catch {
    /* worker en train de disparaître — le chemin de récupération tardive prend le relais */
  }
}

async function waitForServiceWorkerController(timeoutMs: number): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

  return await new Promise<ServiceWorker | null>((resolve) => {
    let settled = false;
    const finish = (controller: ServiceWorker | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(controller);
    };

    const onControllerChange = () => finish(navigator.serviceWorker.controller);
    const timer = setTimeout(() => finish(navigator.serviceWorker.controller), timeoutMs);

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}

// Référence au niveau du module vers l'enregistrement vivant, pour que le chemin
// de récupération tardive puisse y relancer `update()`. Affectée dans `swReady`.
let swRegistration: ServiceWorkerRegistration | null = null;

// Passe à true dès qu'un worker en installation qu'on a enregistré atteint
// `redundant` SANS nous avoir jamais donné de contrôleur. Cet état est la
// signature, visible depuis la page, d'un échec d'installation — le plus souvent
// une exception d'`importScripts()` dans sw-dem.js quand l'un de ses ~28 fetchs de
// sous-modules a eu un hoquet pendant un déploiement / sur un réseau instable. Le
// worker ne s'active jamais : `clients.claim()` ne tourne jamais et aucun
// `controllerchange` n'arrive.
let swInstallFailed = false;

function watchForRedundantInstall(registration: ServiceWorkerRegistration): void {
  const tracked = registration.installing ?? registration.waiting ?? null;
  if (!tracked) return;
  const onState = () => {
    if (tracked.state === 'redundant' && !navigator.serviceWorker.controller) {
      swInstallFailed = true;
    }
    if (tracked.state === 'redundant' || tracked.state === 'activated') {
      tracked.removeEventListener('statechange', onState);
    }
  };
  tracked.addEventListener('statechange', onState);
}

/**
 * Autorépare un enregistrement dont le worker n'a pas réussi à prendre le
 * contrôle. Relance `update()` (qui redemande sw-dem.js ET chaque sous-module à
 * époque invalidée, ce qui rattrape un échec passager d'`importScripts()`),
 * puis attend l'apparition du contrôleur, pendant quelques tentatives bornées.
 *
 * Renvoie `true` dès qu'un contrôleur est présent, `false` si toutes les
 * tentatives s'épuisent sans en obtenir.
 */
async function recoverServiceWorkerRegistration(maxAttempts: number): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (navigator.serviceWorker.controller) return true;

    let registration = swRegistration;
    try {
      // Réenregistrement défensif avec un nonce de récupération à usage unique.
      // Un simple réenregistrement / update() avec une URL de script IDENTIQUE
      // ne fait souvent rien : le navigateur ne relance install→activate que si
      // les octets du script récupéré diffèrent. Ajouter
      // `rv-sw-recovery=<attempt-ts>` fait voir au navigateur un « nouveau »
      // worker et force un cycle d'installation neuf, qui redemande chaque
      // sous-module à époque invalidée et rattrape un échec passager
      // d'importScripts(). Le SW ne lit que `rv-map-cache-epoch` : le paramètre
      // en plus ne touche jamais aux clés de cache.
      const recoveryUrl =
        `/sw-dem.js?rv-map-cache-epoch=${encodeURIComponent(MAP_CACHE_EPOCH)}`
        + `&rv-sw-recovery=${Date.now()}-${attempt}`;
      registration = await navigator.serviceWorker.register(recoveryUrl, { scope: '/' });
      swRegistration = registration;
      watchForRedundantInstall(registration);
      swInstallFailed = false;
      await registration.update();
    } catch (err) {
      logger.sw.warn(`recovery attempt ${attempt}/${maxAttempts} — register/update failed:`, err);
    }

    // Attend l'apparition du contrôleur après cette tentative. Les tentatives
    // suivantes ont une fenêtre plus longue — une installation à froid sur une
    // liaison lente peut mettre plusieurs secondes à récupérer tous les
    // sous-modules et à s'activer.
    const waitMs = Math.min(4000 + attempt * 2000, 10_000);
    const controller = await waitForServiceWorkerController(waitMs);
    if (controller) {
      logger.sw.debug(`recovery succeeded on attempt ${attempt} — controller claimed`);
      return true;
    }
  }

  return false;
}


/**
 * Promesse principale du bootstrap — se résout à `true` dans
 * SW_CONTROLLER_TIMEOUT si le contrôleur du SW est disponible, à `false` sinon.
 *
 * Le bootstrap côté page s'en sert pour choisir le chemin initial (SW rapide ou
 * repli Mapbox simple). Même quand elle se résout à `false`, le SW peut encore
 * prendre le contrôle un peu plus tard — voir `swLateReady` ci-dessous.
 */
export const swReady: Promise<boolean> = (async () => {
  if (!('serviceWorker' in navigator)) return false;
  // Avant que quiconque puisse prendre la page : a-t-elle été servie par un worker d'une autre époque ?
  const controllerAtLoad = navigator.serviceWorker.controller;
  const servedByOtherEpoch = controllerAtLoad !== null && getServiceWorkerEpoch(controllerAtLoad) !== MAP_CACHE_EPOCH;
  try {
    const epochReset = await ensureMapCacheEpochReset();
    const registration = await navigator.serviceWorker.register(
      `/sw-dem.js?rv-map-cache-epoch=${encodeURIComponent(MAP_CACHE_EPOCH)}`,
      { scope: '/' },
    );
    swRegistration = registration;
    watchForRedundantInstall(registration);

    if (epochReset) {
      notifyRegistrationMapCacheReset(registration);
      notifyMapCacheReset(navigator.serviceWorker.controller);
    }

    scheduleEpochTakeoverReload(registration, epochReset, servedByOtherEpoch);
    requestClaimFromActiveWorker(registration);

    const controller = await waitForServiceWorkerController(SW_CONTROLLER_TIMEOUT);
    if (!controller) {
      logger.sw.warn('No controller after registration timeout - proceeding without DEM enhancement');
      return false;
    }

    if (epochReset) {
      notifyMapCacheReset(controller);
    }

    syncLogLevelToServiceWorker(getLogLevel());
    return true;
  } catch (error) {
    logger.sw.error('Registration failed:', error);
    return false;
  }
})();

/**
 * Promesse de récupération d'un SW tardif. Quand `swReady` se résout à `false`
 * (contrôleur indisponible dans les 2,5 s), cette promesse continue de sonder
 * pendant jusqu'à 20 s. Si le contrôleur apparaît plus tard, le bootstrap peut
 * relancer tout le pipeline DEM au lieu de rester plat pour toujours.
 *
 * Se résout à `true` si le contrôleur a fini par apparaître, `false` sinon.
 */
export const swLateReady: Promise<boolean> = (async () => {
  const fast = await swReady;
  if (fast) return true; // déjà prêt, pas besoin du chemin tardif

  if (!('serviceWorker' in navigator)) return false;

  // L'enregistrement du SW a réussi (swReady n'a pas levé d'exception) mais le
  // contrôleur n'a pas pris la main à temps. On sonde jusqu'à 20 s avec un délai
  // croissant. Le handler d'activation du SW appelle `self.clients.claim()`, qui
  // déclenche `controllerchange`.
  const MAX_LATE_WAIT_MS = 20_000;
  const start = Date.now();
  let interval = 200;

  while (Date.now() - start < MAX_LATE_WAIT_MS) {
    await new Promise<void>((r) => setTimeout(r, interval));
    // Une installation terminée pendant l'attente laisse un worker actif que la
    // page peut faire prendre directement (même cas de rechargement forcé que
    // dans swReady).
    requestClaimFromActiveWorker(swRegistration);
    if (navigator.serviceWorker.controller) {
      logger.sw.debug('Late controller claim detected — DEM pipeline can recover');
      return true;
    }
    // Si le worker en installation est devenu redondant, le SW ne prendra JAMAIS
    // le contrôle de lui-même (importScripts / install a levé une exception). On
    // arrête de sonder un worker mort et on s'autorépare tout de suite par
    // réenregistrement + update().
    if (swInstallFailed) {
      logger.sw.warn('install failed (worker redundant) — attempting registration self-heal');
      const recovered = await recoverServiceWorkerRegistration(3);
      if (recovered) return true;
      break;
    }
    interval = Math.min(interval * 1.5, 2000);
  }

  // Autoréparation de dernier recours même quand on n'a jamais observé de
  // passage explicite à redundant (p. ex. le statechange est arrivé avant
  // l'attachement de notre écouteur, ou la phase d'activation s'est bloquée). Un
  // update() neuf coûte peu et c'est la récupération la plus efficace face à un
  // échec passager de fetch d'un sous-module.
  if (!navigator.serviceWorker.controller) {
    const recovered = await recoverServiceWorkerRegistration(2);
    if (recovered) return true;
  }

  logger.sw.warn('Controller never appeared within late-recovery window');
  return false;
})();

/**
 * Attente du contrôleur pilotée par les événements. Si le contrôleur du SW est
 * déjà présent, se résout tout de suite à `true`. Sinon, écoute
 * `controllerchange` pendant jusqu'à `timeoutMs` ms et se résout à `true` dès que
 * le contrôleur apparaît, `false` si le délai expire d'abord.
 *
 * À utiliser au bootstrap pour couvrir la fenêtre install / activate : la
 * promesse en cache `swReady` a un budget de 2,5 s au chargement du module, trop
 * court pour les installations à froid sur réseau lent. Revérifier ici évite
 * l'avertissement « SW indisponible → repli AWS Terrarium » quand le contrôleur
 * est en réalité sur le point de prendre la main.
 */
export function awaitController(timeoutMs: number): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(false);
  }
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      clearTimeout(timer);
      resolve(ok);
    };
    const onChange = () => {
      if (navigator.serviceWorker.controller) finish(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    const timer = setTimeout(() => finish(!!navigator.serviceWorker.controller), timeoutMs);
  });
}