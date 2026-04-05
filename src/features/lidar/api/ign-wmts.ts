const WMTS_BASE = 'https://data.geopf.fr/wmts';

export function buildWmtsUrl(zoom: number, row: number, col: number): string {
  return (
    `${WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg` +
    `&TILEMATRIXSET=PM&TILEMATRIX=${zoom}&TILEROW=${row}&TILECOL=${col}`
  );
}

export async function fetchWmtsTile(
  zoom: number,
  row: number,
  col: number,
): Promise<ImageBitmap | null> {
  try {
    const url = buildWmtsUrl(zoom, row, col);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export async function fetchWmtsTileBatch(
  tiles: Array<{ zoom: number; row: number; col: number }>,
  batchSize = 48,
): Promise<Map<string, ImageBitmap>> {
  const results = new Map<string, ImageBitmap>();

  for (let i = 0; i < tiles.length; i += batchSize) {
    const batch = tiles.slice(i, i + batchSize);
    const promises = batch.map(async (t) => {
      const bmp = await fetchWmtsTile(t.zoom, t.row, t.col);
      if (bmp) {
        results.set(`${t.zoom}_${t.row}_${t.col}`, bmp);
      }
    });
    await Promise.all(promises);
  }

  return results;
}
