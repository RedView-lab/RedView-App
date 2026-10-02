// Nuages de points COPC de la base 3DDB de l'AIST (産総研 3D データベース) :
// API GeoJSON publique (CORS `*`, 60 requêtes/min), un enregistrement par
// feuille avec son lien COPC.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './s3.mjs';

const API = 'https://gsvrg.ipri.aist.go.jp/3ddb_demo/api/v1/services/ALL/features';
/** Hôte servant les COPC avec CORS (les liens de l'API pointent vers un hôte qui redirige sans CORS). */
export const AIST_COPC_BASE = 'https://gsvrg.ipri.aist.go.jp/3ddb-pds/copc/';

async function fetchPage(title, offset) {
  const url = `${API}?${new URLSearchParams({ title, limit: '400', offset: String(offset) })}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.ok) return (await res.json()).features ?? [];
    } catch { /* réessai */ }
    await new Promise(r => setTimeout(r, 10_000 * (attempt + 1)));
  }
  throw new Error(`3DDB API failed: ${url}`);
}

/**
 * Enregistrements COPC d'un jeu 3DDB (filtre `title` côté API, `group` côté
 * client : « 兵庫県高精度3次元点群データ1m » partage le préfixe du titre).
 * → [{ code, file }] avec `code` la feuille (« 05NF3711 ») et `file` le nom du COPC.
 */
export async function cachedAistRecords(title, group, { refresh = false } = {}) {
  const file = path.join(CACHE_DIR, `aist-${group}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = [];
  for (let offset = 0; ; offset += 400) {
    const features = await fetchPage(title, offset);
    for (const f of features) {
      const p = f.properties ?? {};
      if (String(p.group) !== String(group)) continue;
      const link = (p.external_links ?? []).find(l => l.external_link_type === 'copc')?.external_link;
      const code = String(p.title ?? '').match(/(\d{2}[A-Z]{2}\d{3,4})/i)?.[1];
      if (link && code) records.push({ code: code.toUpperCase(), file: link.split('/').pop() });
    }
    if (features.length < 400) break;
    await new Promise(r => setTimeout(r, 1200)); // 60 requêtes/min
  }
  fs.writeFileSync(file, JSON.stringify(records));
  return records;
}
