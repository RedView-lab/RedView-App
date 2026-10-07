// ---------------------------------------------------------------------------
// Nettoyage des événements GlitchTip du front (SDK Sentry), avant envoi.
//
// Une URL de l'app peut porter un secret ou une donnée personnelle dans sa
// query ou son fragment : lien de réinitialisation `?userId=…&secret=…&email=…`
// (retiré de la barre d'adresse au chargement, mais le SDK garde ce
// `replaceState` en breadcrumb de navigation pour toute la session), erreur
// OAuth, coordonnées des requêtes météo / POI / BRouter. Seuls l'origine et le
// chemin sont envoyés — comme côté serveur (server/lib/observability.mjs).
// ---------------------------------------------------------------------------

/** URL sans query ni fragment ; une valeur qui n'est pas une URL est rendue telle quelle. */
export function stripUrlSecrets(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

interface ScrubbableEvent {
  request?: {
    url?: string;
    query_string?: unknown;
    headers?: Record<string, string>;
    cookies?: unknown;
  };
  breadcrumbs?: ScrubbableBreadcrumb[];
}

export interface ScrubbableBreadcrumb {
  category?: string;
  data?: Record<string, unknown>;
}

const URL_FIELDS = ['url', 'from', 'to'] as const;

/** Breadcrumb de navigation / requête : URLs réduites à leur chemin. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  if (!breadcrumb.data) return breadcrumb;
  let data: Record<string, unknown> | null = null;
  for (const field of URL_FIELDS) {
    if (!(field in breadcrumb.data)) continue;
    const scrubbed = stripUrlSecrets(breadcrumb.data[field]);
    if (scrubbed === breadcrumb.data[field]) continue;
    data ??= { ...breadcrumb.data };
    data[field] = scrubbed;
  }
  return data ? { ...breadcrumb, data } : breadcrumb;
}

/** Événement prêt à partir : URL de la page sans query, ni en-têtes, ni cookies. */
export function scrubErrorEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const { url } = event.request;
    event.request = { url: stripUrlSecrets(url) as string | undefined };
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}
