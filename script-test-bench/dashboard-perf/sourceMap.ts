/**
 * Résolution minimale d'une position du build vers la source (sourcemaps v3
 * de `vite build`, en `hidden` : `dist/assets/*.js.map` restent sur disque en
 * local). Sert à nommer les fonctions d'un profil CPU (`--profile`) sans
 * dépendance : décodage VLQ base64 des `mappings`, segment le plus proche à
 * gauche sur la ligne.
 */
import fs from 'node:fs';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

interface Segment { col: number; source: number; line: number; name: number }
interface DecodedMap { sources: string[]; names: string[]; lines: Segment[][] }

function decode(raw: { sources: string[]; names?: string[]; mappings: string }): DecodedMap {
  const lines: Segment[][] = [];
  let source = 0;
  let line = 0;
  let _srcCol = 0;
  let name = 0;
  for (const text of raw.mappings.split(';')) {
    const segments: Segment[] = [];
    let col = 0;
    for (const part of text.split(',')) {
      if (!part) continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of part) {
        const digit = DIGIT.get(char) ?? 0;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      col += values[0];
      if (values.length >= 4) {
        source += values[1];
        line += values[2];
        _srcCol += values[3];
        if (values.length >= 5) name += values[4];
        segments.push({ col, source, line, name: values.length >= 5 ? name : -1 });
      }
    }
    lines.push(segments);
  }
  return { sources: raw.sources, names: raw.names ?? [], lines };
}

const cache = new Map<string, DecodedMap | null>();

/** `file` : chemin du .js du build ; positions 0-based comme dans un profil CDP. */
export function originalPosition(file: string, line: number, column: number): string | null {
  if (!cache.has(file)) {
    try {
      cache.set(file, decode(JSON.parse(fs.readFileSync(`${file}.map`, 'utf8'))));
    } catch {
      cache.set(file, null);
    }
  }
  const map = cache.get(file);
  const segments = map?.lines[line];
  if (!map || !segments?.length) return null;
  let best: Segment | null = null;
  for (const segment of segments) {
    if (segment.col > column) break;
    best = segment;
  }
  if (!best) return null;
  const source = map.sources[best.source].replace(/^(\.\.\/)+/, '').replace(/^.*?\/(src|node_modules)\//, '$1/');
  return `${source}:${best.line + 1}${best.name >= 0 ? ` (${map.names[best.name]})` : ''}`;
}
