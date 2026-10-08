/**
 * Tuile LiDAR synthétique façon IGN : un fichier LAS 1.4 non compressé (format
 * de point 7, RGB 16 bits) d'une tuile Lambert-93 de 1 km — relief, sol
 * (classe 2), arbres (classe 5) et bâtiments (classe 6). Le visualiseur la lit
 * comme une tuile téléchargée (chemin non COPC, cache LOD construit à la
 * première ouverture) avec couleur intégrée : le test n'a besoin d'aucun réseau.
 */

const HEADER_SIZE = 375;
const RECORD_SIZE = 36;
const SCALE = 0.01;

/** Nombres pseudo-aléatoires déterministes (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hauteur du sol (m) en (u, v) locaux à la tuile ∈ [0, 1000] : une vallée entre deux crêtes. */
function groundZ(u, v) {
  return 1400
    + 160 * Math.sin(u / 170) * Math.cos(v / 140)
    + 55 * Math.sin(u / 47 + v / 63)
    + 0.18 * Math.abs(u - 500);
}

/**
 * @param {{ xKm: number, yKm: number, spacing?: number }} tile nom IGN
 *   (x du bord ouest, y du bord nord, en km)
 * @returns {Buffer}
 */
export function buildSyntheticLas({ xKm, yKm, spacing = 1.6 }) {
  const minX = xKm * 1000;
  const maxY = yKm * 1000;
  const minY = maxY - 1000;
  const rand = random(xKm * 7919 + yKm);
  const points = [];
  const push = (u, v, z, cls, rgb, intensity) => points.push({ x: minX + u, y: minY + v, z, cls, rgb, intensity });

  const steps = Math.floor(1000 / spacing);
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const u = Math.min(1000, i * spacing + (rand() - 0.5) * spacing * 0.6);
      const v = Math.min(1000, j * spacing + (rand() - 0.5) * spacing * 0.6);
      const z = groundZ(u, v);
      // Herbe dans la vallée, roche et neige plus haut.
      const t = Math.min(1, Math.max(0, (z - 1300) / 450));
      const noise = rand() * 0.12;
      const rgb = t > 0.8
        ? [0.92 - noise, 0.93 - noise, 0.95 - noise]
        : [0.32 + t * 0.4 + noise, 0.45 + t * 0.2 + noise, 0.22 + t * 0.35 + noise];
      push(u, v, z, 2, rgb, 0.35 + 0.4 * rand());
    }
  }
  for (let k = 0; k < 450; k++) {
    const cu = 60 + rand() * 880;
    const cv = 60 + rand() * 880;
    const height = 8 + rand() * 14;
    const base = groundZ(cu, cv);
    for (let p = 0; p < 70; p++) {
      const h = rand() * height;
      const r = (1 - h / height) * height * 0.28 * Math.sqrt(rand());
      const a = rand() * Math.PI * 2;
      push(cu + Math.cos(a) * r, cv + Math.sin(a) * r, base + 2 + h, 5, [0.12, 0.32 + rand() * 0.1, 0.12], 0.2 + 0.2 * rand());
    }
  }
  for (let b = 0; b < 14; b++) {
    const cu = 120 + rand() * 760;
    const cv = 120 + rand() * 760;
    const w = 12 + rand() * 16;
    const d = 10 + rand() * 12;
    const roof = groundZ(cu, cv) + 7 + rand() * 5;
    for (let du = -w / 2; du <= w / 2; du += 0.8) {
      for (let dv = -d / 2; dv <= d / 2; dv += 0.8) push(cu + du, cv + dv, roof, 6, [0.62, 0.22, 0.16], 0.7);
    }
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const offset = [minX, minY, Math.floor(minZ)];
  const buf = Buffer.alloc(HEADER_SIZE + points.length * RECORD_SIZE);
  buf.write('LASF', 0, 'ascii');
  buf.writeUInt16LE(0x0010, 6); // drapeau CRS WKT, comme les fichiers IGN
  buf.writeUInt8(1, 24);
  buf.writeUInt8(4, 25);
  buf.write('RedView synthetic tile', 26, 'ascii');
  buf.write('lidar-viewer-engines', 58, 'ascii');
  buf.writeUInt16LE(279, 90);
  buf.writeUInt16LE(2026, 92);
  buf.writeUInt16LE(HEADER_SIZE, 94);
  buf.writeUInt32LE(HEADER_SIZE, 96);
  buf.writeUInt32LE(0, 100);
  buf.writeUInt8(7, 104);
  buf.writeUInt16LE(RECORD_SIZE, 105);
  for (let i = 0; i < 3; i++) {
    buf.writeDoubleLE(SCALE, 131 + i * 8);
    buf.writeDoubleLE(offset[i], 155 + i * 8);
  }
  buf.writeDoubleLE(minX + 1000, 179);
  buf.writeDoubleLE(minX, 187);
  buf.writeDoubleLE(maxY, 195);
  buf.writeDoubleLE(minY, 203);
  buf.writeDoubleLE(maxZ, 211);
  buf.writeDoubleLE(minZ, 219);
  buf.writeBigUInt64LE(BigInt(points.length), 247);
  buf.writeBigUInt64LE(BigInt(points.length), 255);

  const u16 = (value) => Math.max(0, Math.min(65535, Math.round(value * 65535)));
  points.forEach((p, i) => {
    const at = HEADER_SIZE + i * RECORD_SIZE;
    buf.writeInt32LE(Math.round((p.x - offset[0]) / SCALE), at);
    buf.writeInt32LE(Math.round((p.y - offset[1]) / SCALE), at + 4);
    buf.writeInt32LE(Math.round((p.z - offset[2]) / SCALE), at + 8);
    buf.writeUInt16LE(u16(p.intensity), at + 12);
    buf.writeUInt8(0x11, at + 14);
    buf.writeUInt8(p.cls, at + 16);
    buf.writeUInt16LE(u16(Math.min(1, p.rgb[0])), at + 30);
    buf.writeUInt16LE(u16(Math.min(1, p.rgb[1])), at + 32);
    buf.writeUInt16LE(u16(Math.min(1, p.rgb[2])), at + 34);
  });
  return buf;
}
