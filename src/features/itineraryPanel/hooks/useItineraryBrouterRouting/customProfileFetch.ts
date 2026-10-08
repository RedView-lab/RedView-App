import {
  brouterProxyAppliesBudget,
  fetchBrouterRoute,
  isBrouterQueueBusy,
  requestBeelineKm,
  type BrouterRequest,
  type BrouterRoute,
} from '../../lib/brouter';

export type RouteRequestBase = Omit<BrouterRequest, 'profile' | 'alternativeIdx'>;

const CUSTOM_PROFILE_TIMEOUT_MS = 14_000;
/** Plafond : reste sous le délai de 55 s du proxy /api/brouter. */
const CUSTOM_PROFILE_TIMEOUT_MAX_MS = 45_000;

/**
 * Délai accordé à une recherche avant de passer à la méthode suivante (tracé
 * grossier puis ancres, cf. resolveRouteRequest) : un tracé de 1 000 km
 * demande légitimement plus qu'un tracé de 100 km.
 */
function customProfileTimeoutMs(beelineKm: number): number {
  const extra = Math.max(0, beelineKm - 150) * 40;
  return Math.round(Math.min(CUSTOM_PROFILE_TIMEOUT_MAX_MS, CUSTOM_PROFILE_TIMEOUT_MS + extra));
}

/**
 * Proxy qui applique `budgetMs` : il répond 504 au bout du délai de CALCUL,
 * compté après l'attente dans sa file. Le minuteur du client n'est plus
 * qu'un filet (file pleine, réseau) : sous charge, une attente dans la file
 * ne fait plus abandonner une recherche pour en lancer deux ou trois autres
 * (tracé grossier, ancres) derrière elle dans la même file.
 */
const QUEUE_ALLOWANCE_MS = 45_000;

/** Recherche restée sans réponse dans le délai accordé. */
class BrouterSearchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`BRouter: search timed out after ${timeoutMs} ms`);
    this.name = 'BrouterSearchTimeoutError';
  }
}

/**
 * Requête de secours : au départ d'un réseau très dense (Paris…), une
 * recherche fine peut explorer longtemps. Passé ce délai, une recherche plus
 * gloutonne — même profil — part en parallèle et la première réponse
 * l'emporte. Pas de secours quand la file du proxy est chargée
 * (`isBrouterQueueBusy`) : la lenteur vient alors de l'attente, et un second
 * calcul ne ferait qu'attendre derrière les autres.
 */
const HEDGE_SEARCH_WEIGHT = 1.7;

function hedgeDelayMs(beelineKm: number): number {
  return Math.round(Math.min(8_000, 3_000 + beelineKm * 8));
}

function abortError(): Error {
  return new DOMException('aborted', 'AbortError');
}

/**
 * Première réponse réussie ; l'échec de la fine avant le départ du secours est
 * renvoyé tel quel. Les délais portent sur le calcul : dès que BRouter a
 * répondu (`onComputed`), plus de secours — une connexion lente ne doit pas
 * doubler la charge du serveur pendant le téléchargement.
 */
function fetchWithHedge(
  request: BrouterRequest,
  beelineKm: number,
  signal: AbortSignal,
  onComputed: () => void,
): Promise<BrouterRoute> {
  if (request.searchWeight != null) {
    return fetchBrouterRoute({ ...request, signal, onResponseHeaders: onComputed });
  }
  return new Promise<BrouterRoute>((resolve, reject) => {
    const fineCtrl = new AbortController();
    const hedgeCtrl = new AbortController();
    let settled = false;
    let hedgeStarted = false;
    let pending = 1;
    let firstError: unknown = null;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fineCtrl.abort();
      hedgeCtrl.abort();
      run();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? abortError()));
    const onError = (error: unknown) => {
      firstError ??= error;
      pending -= 1;
      if (!hedgeStarted || pending === 0) finish(() => reject(firstError));
    };
    if (signal.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const computed = () => {
      clearTimeout(timer);
      onComputed();
    };
    fetchBrouterRoute({ ...request, signal: fineCtrl.signal, onResponseHeaders: computed })
      .then((route) => finish(() => resolve(route)), onError);
    const timer = setTimeout(() => {
      if (settled || isBrouterQueueBusy()) return;
      hedgeStarted = true;
      pending += 1;
      fetchBrouterRoute({
        ...request,
        searchWeight: HEDGE_SEARCH_WEIGHT,
        // Jamais en file : sans place libre, le proxy le refuse aussitôt (la fine continue).
        hedge: true,
        signal: hedgeCtrl.signal,
        onResponseHeaders: onComputed,
      }).then((route) => finish(() => resolve(route)), onError);
    }, hedgeDelayMs(beelineKm));
  });
}

/**
 * Tracé avec le profil personnalisé, en temps borné : passé le délai, rejette
 * avec `BrouterSearchTimeoutError` (jamais de repli sur un profil stock —
 * resolveRouteRequest passe alors au tracé grossier et aux ancres).
 */
export async function fetchCustomProfileRoute(
  reqBase: RouteRequestBase,
  profile: string,
): Promise<BrouterRoute> {
  const searchCtrl = new AbortController();
  const onUserAbort = () => searchCtrl.abort(reqBase.signal?.reason);
  reqBase.signal?.addEventListener('abort', onUserAbort, { once: true });
  const beelineKm = requestBeelineKm([reqBase.start, ...(reqBase.via ?? []), reqBase.end]);
  const timeoutMs = customProfileTimeoutMs(beelineKm);
  // Proxy qui compte le délai sur le calcul seul (`budgetMs`) : minuteur local en filet.
  const budget = brouterProxyAppliesBudget();
  const localTimeoutMs = budget ? timeoutMs + QUEUE_ALLOWANCE_MS : timeoutMs;
  const timer = setTimeout(() => searchCtrl.abort(new BrouterSearchTimeoutError(localTimeoutMs)), localTimeoutMs);

  try {
    // Le délai borne le calcul, pas le téléchargement de la réponse.
    return await fetchWithHedge(
      { ...reqBase, profile, ...(budget ? { budgetMs: timeoutMs } : {}) },
      beelineKm,
      searchCtrl.signal,
      () => clearTimeout(timer),
    );
  } finally {
    clearTimeout(timer);
    reqBase.signal?.removeEventListener('abort', onUserAbort);
  }
}
