// ---------------------------------------------------------------------------
// Nettoyage des événements GlitchTip du front (SDK Sentry), avant envoi.
//
// Une URL de l'app peut porter un secret ou une donnée personnelle dans sa
// query ou son fragment : lien de réinitialisation `?userId=…&secret=…&email=…`
// (retiré de la barre d'adresse au chargement, mais le SDK garde ce
// `replaceState` en breadcrumb de navigation pour toute la session), erreur
// OAuth, coordonnées des requêtes météo / POI / BRouter. Seuls l'origine et le
// chemin sont envoyés — comme côté serveur (server/lib/observability.mjs).
//
// Les noms choisis par l'utilisateur ne partent pas non plus (G1-1, audit du
// 2026-10-10) : les journaux de console citent des fichiers .fit (souvent la
// date et le titre d'une sortie : données de santé), .redview ou des projets,
// interpolés ou en arguments ; les sélecteurs des clics portent les
// `aria-label`/`title` des boutons ; le message d'une erreur JSON cite un
// extrait du document.
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
  exception?: { values?: Array<{ type?: string; value?: string }> };
  breadcrumbs?: ScrubbableBreadcrumb[];
}

export interface ScrubbableBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

const URL_FIELDS = ['url', 'from', 'to'] as const;

/** Étiquette de module en tête d'un journal (`[fitFiles] …`), seule partie sûre : le reste peut interpoler un nom. */
const CONSOLE_TAG = /^\[[\w .:/-]{1,48}\]/;
const UNTAGGED_CONSOLE = '[console]';

/**
 * Journal de console : seulement l'étiquette du module. Le texte peut
 * interpoler un nom de fichier ou de projet, et les arguments en portent.
 */
function scrubConsoleBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  const moduleTag = CONSOLE_TAG.exec(breadcrumb.message ?? '')?.[0] ?? UNTAGGED_CONSOLE;
  let data = breadcrumb.data;
  if (data && 'arguments' in data) {
    const { arguments: _arguments, ...rest } = data;
    data = rest;
  }
  return { ...breadcrumb, message: moduleTag, ...(data ? { data } : {}) };
}

/** Sélecteur d'un clic : `[aria-label="Ouvrir Sortie…"]` → `[aria-label]`. */
function scrubSelector(message: string): string {
  return message.replace(/\[([\w-]+)=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]]*)\]/g, '[$1]');
}

/** Breadcrumb de navigation / requête : URLs réduites à leur chemin ; console et clics sans texte de l'utilisateur. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  if (breadcrumb.category === 'console') return scrubConsoleBreadcrumb(breadcrumb);
  if (breadcrumb.category?.startsWith('ui.') && typeof breadcrumb.message === 'string') {
    const message = scrubSelector(breadcrumb.message);
    if (message !== breadcrumb.message) breadcrumb = { ...breadcrumb, message };
  }
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

/**
 * Message d'une erreur d'analyse JSON sans l'extrait du document qu'il cite
 * (V8 : `Unexpected token 'S', "Sortie Ven"... is not valid JSON` ; WebKit :
 * `Unexpected identifier "Julie"`). La position reste : c'est elle qui aide.
 */
function scrubJsonErrorMessage(value: string): string {
  if (!/JSON/.test(value)) return value;
  return value
    .replace(/^Unexpected token '(?:[^'\\]|\\.)*',/, 'Unexpected token,')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"');
}

/** Événement prêt à partir : URL de la page sans query, ni en-têtes, ni cookies, ni extrait de document. */
export function scrubErrorEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const { url } = event.request;
    event.request = { url: stripUrlSecrets(url) as string | undefined };
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.type === 'SyntaxError' && typeof exception.value === 'string') {
      exception.value = scrubJsonErrorMessage(exception.value);
    }
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}
