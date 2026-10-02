// Listing S3 (ListObjectsV2, accès anonyme) et lecture d'en-têtes LAS par
// requêtes Range, avec cache disque : le crawl NZ complet prend ~1 h.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

async function fetchText(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (res.ok) return await res.text();
    } catch { /* réessai */ }
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`S3 listing failed: ${url}`);
}

/** Sous-dossiers directs d'un préfixe. */
export async function listDirs(bucketUrl, prefix) {
  const xml = await fetchText(`${bucketUrl}?list-type=2&delimiter=/&prefix=${encodeURIComponent(prefix)}`);
  return [...xml.matchAll(/<Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)].map(m => m[1]);
}

/** Tous les objets sous un préfixe : [clé, taille]. */
export async function listAll(bucketUrl, prefix) {
  const rows = [];
  let token = null;
  do {
    const xml = await fetchText(`${bucketUrl}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`);
    for (const m of xml.matchAll(/<Contents><Key>([^<]*)<\/Key>.*?<Size>(\d+)<\/Size>/g)) {
      if (!m[1].endsWith('/')) rows.push([m[1].replace(/&amp;/g, '&'), Number(m[2])]);
    }
    const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    token = next && xml.includes('<IsTruncated>true') ? next[1] : null;
  } while (token);
  return rows;
}

/**
 * Listing mis en cache par préfixe (un fichier JSON par préfixe) ; `refresh`
 * force le re-crawl. Un préfixe interrompu n'est jamais écrit à moitié.
 */
export async function cachedListAll(bucketUrl, prefix, { refresh = false } = {}) {
  const file = path.join(CACHE_DIR, `list-${new URL(bucketUrl).host}-${prefix.replace(/[^\w.-]+/g, '_')}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = await listAll(bucketUrl, prefix);
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

function parseLasHeader(b) {
  if (b.length < 227 || b.toString('latin1', 0, 4) !== 'LASF') return null;
  const minor = b[25];
  let count = b.readUInt32LE(107);
  if (minor >= 4 && b.length >= 255) {
    const count64 = Number(b.readBigUInt64LE(247));
    if (count64 > 0) count = count64;
  }
  return {
    count,
    minX: b.readDoubleLE(187), maxX: b.readDoubleLE(179),
    minY: b.readDoubleLE(203), maxY: b.readDoubleLE(195),
  };
}

/**
 * En-tête LAS d'un fichier LAS/LAZ, ou de la première entrée d'un ZIP.
 * `bytes` : 1 Kio suffit hors ZIP (en-tête LAS ≤ 375 o).
 */
export async function probeLasHeader(url, bytes = 65_536) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: AbortSignal.timeout(90_000) });
      if (res.status === 404) return null;
      if (res.status !== 206 && res.status !== 200) throw new Error(String(res.status));
      const head = Buffer.from(await res.arrayBuffer());
      if (head.toString('latin1', 0, 4) === 'LASF') return parseLasHeader(head);
      if (head.readUInt32LE(0) === 0x04034b50) {
        const method = head.readUInt16LE(8);
        const data = head.subarray(30 + head.readUInt16LE(26) + head.readUInt16LE(28));
        const las = method === 0 ? data : zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        return parseLasHeader(las);
      }
      return null;
    } catch {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

/** Sondes d'en-têtes en parallèle, cache persistant par URL. */
export async function cachedProbes(urls, { concurrency = 16, label = 'probe', bytes } = {}) {
  const file = path.join(CACHE_DIR, 'las-headers.json');
  const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const todo = urls.filter(u => !(u in cache));
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const url = todo[cursor++];
      cache[url] = await probeLasHeader(url, bytes);
      if (++done % 200 === 0) {
        console.log(`  ${label}: ${done}/${todo.length}`);
        fs.writeFileSync(file, JSON.stringify(cache));
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (todo.length) fs.writeFileSync(file, JSON.stringify(cache));
  return Object.fromEntries(urls.map(u => [u, cache[u]]));
}
