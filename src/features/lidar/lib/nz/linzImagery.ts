/**
 * Orthophotos de Nouvelle-Zélande : imagerie aérienne de LINZ Basemaps
 * (Toitū Te Whenua Land Information New Zealand, CC BY 4.0 — attribution
 * dans Réglages → Sources de données). Remplace Esri World Imagery, dont les
 * conditions n'autorisent pas un usage commercial sans compte ArcGIS.
 *
 * Clé : `VITE_LINZ_BASEMAPS_API_KEY` (.env.example). Sans clé, aucune requête :
 * la colorisation ortho est sautée et les points gardent le gris par défaut,
 * comme quand le service est injoignable. Une clé « standard » est limitée à
 * 1 000 tuiles par minute — une dalle LiDAR de 1 km en demande ~400 au z19 ;
 * la production a besoin d'une clé développeur (illimitée, gratuite, sur
 * demande à LINZ).
 *
 * L'imagerie couvre tout le territoire jusqu'au z22 (sur-échantillonnée là où
 * la résolution native est moindre) : pas de repli sur un ancêtre comme pour
 * Esri. Hors couverture, LINZ renvoie une tuile transparente.
 */

const LINZ_AERIAL_TILES = 'https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad';
/** Essais sur un 429 (limite de débit) ou une erreur 5xx, après le premier. */
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;

/** Clé d'API LINZ Basemaps de la build, ou `null`. */
export function linzBasemapsApiKey(): string | null {
  const raw: unknown = import.meta.env?.VITE_LINZ_BASEMAPS_API_KEY;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : null;
}

export function linzImageryTileUrl(zoom: number, x: number, y: number, apiKey: string): string {
  return `${LINZ_AERIAL_TILES}/${zoom}/${x}/${y}.webp?api=${encodeURIComponent(apiKey)}`;
}

/** Délai avant un nouvel essai : `Retry-After` (secondes) s'il est donné, sinon exponentiel. */
export function linzRetryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1_000 * 2 ** attempt;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tuile `zoom/x/y` (grille Web-Mercator) de l'imagerie aérienne LINZ, ou
 * `null` (pas de clé, tuile absente ou illisible, service injoignable).
 */
export async function fetchLinzImageryTile(
  zoom: number,
  x: number,
  y: number,
  apiKey: string | null = linzBasemapsApiKey(),
): Promise<ImageBitmap | null> {
  if (!apiKey) return null;
  const url = linzImageryTileUrl(zoom, x, y, apiKey);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      return null;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(linzRetryDelayMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null;
    try {
      return await createImageBitmap(await response.blob());
    } catch {
      return null;
    }
  }
  return null;
}
