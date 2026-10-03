/**
 * Tuiles ortho Esri World Imagery (Nouvelle-Zélande) sans dalles « Map data
 * not yet available ».
 *
 * Là où Esri n'a pas d'image au niveau demandé (beaucoup de zones rurales
 * néo-zélandaises s'arrêtent à z17–z18), `tile/{z}/{y}/{x}` répond 200 avec
 * une image grise de remplacement : les points LiDAR prenaient alors ce gris
 * et son texte. `?blankTile=false` transforme ce cas en 404, mais ce 404 n'a
 * pas d'en-tête CORS (erreur réseau bruyante dans la console). On lit donc
 * d'abord la disponibilité dans `tilemap` (JSON, CORS, un paquet de 128 × 128
 * tuiles alignées sur les bundles du cache serveur, jamais « adjusted »), puis
 * on prend la tuile la plus profonde qui existe vraiment : la tuile elle-même,
 * sinon le recadrage agrandi d'un ancêtre. `blankTile=false` reste en garde
 * si `tilemap` se trompe ou n'a pas répondu.
 */

const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const BUNDLE_SIZE = 128;
/** Niveaux remontés au plus : à 7, un ancêtre couvre encore 2 px de la tuile. */
const MAX_FALLBACK_LEVELS = 7;
const CACHE_LIMIT = 256;

const availabilityCache = new Map<string, Promise<Uint8Array | null>>();
const ancestorCache = new Map<string, Promise<Blob | null>>();

/** Promesse mise en cache (LRU borné) ; un échec (`null`) n'est pas retenu. */
function cached<T>(cache: Map<string, Promise<T | null>>, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = load();
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  void pending.then((value) => {
    if (value === null && cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

interface TileMapResponse {
  data?: unknown;
  location?: { left?: number; top?: number; width?: number; height?: number };
}

/** Disponibilité (1 = image réelle) du bundle 128 × 128, ligne par ligne. */
async function loadBundle(zoom: number, bundleRow: number, bundleCol: number): Promise<Uint8Array | null> {
  const top = bundleRow * BUNDLE_SIZE;
  const left = bundleCol * BUNDLE_SIZE;
  try {
    const response = await fetch(`${ESRI_IMAGERY}/tilemap/${zoom}/${top}/${left}/${BUNDLE_SIZE}/${BUNDLE_SIZE}`);
    if (!response.ok) return null;
    const { data, location } = (await response.json()) as TileMapResponse;
    if (
      !Array.isArray(data) || !location
      || location.left !== left || location.top !== top || location.width !== BUNDLE_SIZE
      || data.length !== BUNDLE_SIZE * (location.height ?? 0)
    ) return null;
    return Uint8Array.from(data, (value) => (value === 1 ? 1 : 0));
  } catch {
    return null;
  }
}

/** `true`/`false` d'après `tilemap`, `null` quand on ne sait pas. */
async function isTileAvailable(zoom: number, x: number, y: number): Promise<boolean | null> {
  const bundleRow = Math.floor(y / BUNDLE_SIZE);
  const bundleCol = Math.floor(x / BUNDLE_SIZE);
  const bundle = await cached(availabilityCache, `${zoom}/${bundleRow}/${bundleCol}`, () =>
    loadBundle(zoom, bundleRow, bundleCol));
  if (!bundle) return null;
  const index = (y - bundleRow * BUNDLE_SIZE) * BUNDLE_SIZE + (x - bundleCol * BUNDLE_SIZE);
  return index < bundle.length ? bundle[index] === 1 : null;
}

async function fetchTileBlob(zoom: number, x: number, y: number): Promise<Blob | null> {
  try {
    const response = await fetch(`${ESRI_IMAGERY}/tile/${zoom}/${y}/${x}?blankTile=false`);
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/**
 * Tuile `zoom/x/y` (grille Web-Mercator) : l'image réelle à ce niveau, sinon
 * la portion de l'ancêtre disponible le plus proche (à agrandir par
 * l'appelant, qui dessine le bitmap dans une case de tuile entière), ou `null`.
 */
export async function fetchEsriImageryTile(zoom: number, x: number, y: number): Promise<ImageBitmap | null> {
  const minZoom = Math.max(0, zoom - MAX_FALLBACK_LEVELS);
  for (let z = zoom; z >= minZoom; z--) {
    const shift = zoom - z;
    const ax = x >> shift;
    const ay = y >> shift;
    if ((await isTileAvailable(z, ax, ay)) === false) continue;

    const blob = shift === 0
      ? await fetchTileBlob(z, ax, ay)
      : await cached(ancestorCache, `${z}/${ax}/${ay}`, () => fetchTileBlob(z, ax, ay));
    if (!blob) continue;

    // Image illisible : on tente l'ancêtre suivant.
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) continue;
    if (shift === 0) return bitmap;
    try {
      const subW = bitmap.width >> shift;
      const subH = bitmap.height >> shift;
      const mask = (1 << shift) - 1;
      return await createImageBitmap(bitmap, (x & mask) * subW, (y & mask) * subH, subW, subH);
    } catch {
      continue;
    } finally {
      bitmap.close();
    }
  }
  return null;
}
