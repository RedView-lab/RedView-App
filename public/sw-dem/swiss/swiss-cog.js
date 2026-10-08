// ---------------------------------------------------------------------------
// Lecteur minimal de Cloud-Optimised GeoTIFF (COG) pour swissSURFACE3D Raster
// ---------------------------------------------------------------------------
// Pourquoi un lecteur maison plutôt que geotiff.js ?
//   * Le SW est un Worker *classique* (importScripts) — geotiff.js v2 est livré
//     en ESM, et ajouter une étape de build pour l'empaqueter crée une friction
//     inutile.
//   * Les COG swisstopo sont remarquablement uniformes : une seule bande
//     Float32, tuilage interne, compression DEFLATE, géoréférencement EPSG:2056
//     décrit par GeoKey.
//   * Il ne faut qu'un tout petit sous-ensemble du TIFF : assez de tags pour
//     passer de (mètres LV95) → (px image) → (index de tuile interne) →
//     (requête de plage) → (échantillon Float32).
//
// Contrat d'implémentation :
//   const cog = await openSwissCOG(url);
//   const elev = await cog.sampleLV95(E, N);   // mètres ou NaN
//
// Tous les fetchs de plages passent par `swissScheduleFetch()` (dans
// swiss-fetcher.js) pour partager un seul limiteur de concurrence dans tout le
// pipeline suisse.
// ---------------------------------------------------------------------------

// ─── TIFF tag IDs we care about ─────────────────────────────────────────────
const T_ImageWidth         = 256;
const T_ImageLength        = 257;
const T_BitsPerSample      = 258;
const T_Compression        = 259;
const T_SamplesPerPixel    = 277;
const T_TileWidth          = 322;
const T_TileLength         = 323;
const T_TileOffsets        = 324;
const T_TileByteCounts     = 325;
const T_SampleFormat       = 339;
const T_ModelPixelScaleTag = 33550;
const T_ModelTiepointTag   = 33922;
const T_GDAL_NODATA        = 42113;

// TIFF field type sizes
const TIFF_TYPE_SIZE = {
  1: 1,  // BYTE
  2: 1,  // ASCII
  3: 2,  // SHORT
  4: 4,  // LONG
  5: 8,  // RATIONAL
  6: 1,  // SBYTE
  7: 1,  // UNDEFINED
  8: 2,  // SSHORT
  9: 4,  // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

// ─── Helpers ────────────────────────────────────────────────────────────────

// Décompression DEFLATE (RFC 1951 + enveloppe zlib). Les COG swisstopo
// utilisent Compression=8, la forme enveloppée zlib ; DecompressionStream gère
// nativement 'deflate' (zlib) et 'deflate-raw'. On essaie d'abord zlib.
async function inflateDeflate(buffer) {
  // buffer: Uint8Array
  const tryDecompress = async (format) => {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format));
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  };
  try { return await tryDecompress('deflate'); }
  catch { return await tryDecompress('deflate-raw'); }
}

// ─── Décodeur LZW TIFF (Compression = 5) ────────────────────────────────────
// Les COG swissSURFACE3D Raster de swisstopo sont compressés en LZW (vérifié en
// sondant l'en-tête — tag 259 = 5). DecompressionStream n'a pas de moteur LZW :
// on embarque un décodeur minimal en JS pur.
//
// Particularités du LZW TIFF 6.0 §13 (par rapport au LZW classique / GIF) :
//   * L'empaquetage des bits se fait **MSB d'abord** (GIF : LSB d'abord).
//   * La largeur de code démarre à 9 bits et grandit quand l'index du
//     dictionnaire atteint les seuils de « changement anticipé » 510, 1022, 2046
//     (un de moins que 2^largeur − 1, selon l'errata TIFF de 2002).
//   * CLEAR = 256 réinitialise le dictionnaire et la largeur de code à 9 bits.
//   * EOI = 257 termine le flux.
//   * Les entrées 258+ du dictionnaire sont des paires { firstCode, suffixByte } ;
//     la longueur de sortie n'est pas bornée, donc on accumule par blocs puis on
//     concatène une fois.
function decodeTIFFLZW(input) {
  const CLEAR = 256;
  const EOI = 257;
  const MAX_CODE = 4093; // 2^12 − 3 (les entrées 4094 et 4095 sont réservées / interdites)

  const inLen = input.length;
  // Taille de sortie préallouée estimée (le LZW développe en général ~2-3× ; on
  // agrandira). Une tuile fait tileW*tileH*4 octets (p. ex. 512*512*4 = 1 Mio) :
  // on part de là.
  let out = new Uint8Array(Math.max(inLen * 3, 1 << 16));
  let outPos = 0;
  const ensureOut = (need) => {
    if (outPos + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < outPos + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out);
    out = next;
  };

  // Lecteur de bits (MSB d'abord sur le flux d'octets d'entrée).
  let bitBuf = 0;
  let bitCnt = 0;
  let bytePos = 0;
  const readCode = (width) => {
    while (bitCnt < width && bytePos < inLen) {
      bitBuf = (bitBuf << 8) | input[bytePos++];
      bitCnt += 8;
    }
    if (bitCnt < width) return -1;
    bitCnt -= width;
    return (bitBuf >>> bitCnt) & ((1 << width) - 1);
  };

  // Dictionnaire en tableaux parallèles (prefixCode, suffixByte). Résoudre une
  // entrée remonte la chaîne des préfixes dans un petit tampon de travail.
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const scratch = new Uint8Array(4096);

  const writeEntry = (code) => {
    let len = 0;
    let c = code;
    while (c >= 0) {
      scratch[len++] = (c < 256) ? c : suffix[c];
      if (c < 256) break;
      c = prefix[c];
    }
    ensureOut(len);
    // le tampon de travail est à l'envers — on émet à rebours.
    for (let i = len - 1; i >= 0; i--) out[outPos++] = scratch[i];
    return scratch[len - 1]; // premier octet de l'entrée
  };

  let codeWidth = 9;
  let nextCode = 258;
  let prevCode = -1;

  while (true) {
    const code = readCode(codeWidth);
    if (code < 0 || code === EOI) break;
    if (code === CLEAR) {
      codeWidth = 9;
      nextCode = 258;
      prevCode = -1;
      continue;
    }

    let firstByte;
    if (code < nextCode) {
      // Code connu — on l'émet et (s'il y a un précédent) on ajoute prev+firstByte au dictionnaire.
      firstByte = writeEntry(code);
      if (prevCode !== -1 && nextCode <= MAX_CODE) {
        prefix[nextCode] = prevCode;
        suffix[nextCode] = firstByte;
        nextCode++;
      }
    } else if (code === nextCode && prevCode !== -1) {
      // Cas KwKwK : nouveau code = prev + firstByte(prev). On l'ajoute au
      // dictionnaire, puis on l'émet. On obtient d'abord le firstByte de prev
      // SANS l'émettre (parcours de la chaîne).
      let c = prevCode;
      while (c >= 256) c = prefix[c];
      firstByte = c;
      if (nextCode <= MAX_CODE) {
        prefix[nextCode] = prevCode;
        suffix[nextCode] = firstByte;
        nextCode++;
      }
      writeEntry(code);
    } else {
      // Bad code — corrupt stream. Bail.
      break;
    }

    prevCode = code;

    // « Changement anticipé » TIFF : la largeur grandit un code AVANT que le
    // dictionnaire ne soit plein, pour que l'encodeur et le décodeur
    // s'accordent sur la largeur du code suivant.
    if (codeWidth < 12 && nextCode === ((1 << codeWidth) - 1)) {
      codeWidth++;
    }
  }

  return out.subarray(0, outPos);
}

function readTagValue(view, entryOffset, type, count, littleEndian, bytesView) {
  const typeSize = TIFF_TYPE_SIZE[type] || 0;
  const totalBytes = typeSize * count;
  // Pour les valeurs en ligne (≤ 4 octets), la valeur est dans l'emplacement
  // valeur/décalage (entryOffset+8). Pour les plus grandes, c'est un décalage
  // dans le fichier.
  const isInline = totalBytes <= 4;
  let dataOffset, data;
  if (isInline) {
    dataOffset = entryOffset + 8;
    data = view;
  } else {
    dataOffset = view.getUint32(entryOffset + 8, littleEndian);
    data = new DataView(bytesView.buffer, bytesView.byteOffset, bytesView.byteLength);
  }

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = dataOffset + i * typeSize;
    switch (type) {
      case 1: case 7: out[i] = data.getUint8(off); break;
      case 2: out[i] = data.getUint8(off); break;
      case 3: out[i] = data.getUint16(off, littleEndian); break;
      case 4: out[i] = data.getUint32(off, littleEndian); break;
      case 6: out[i] = data.getInt8(off); break;
      case 8: out[i] = data.getInt16(off, littleEndian); break;
      case 9: out[i] = data.getInt32(off, littleEndian); break;
      case 11: out[i] = data.getFloat32(off, littleEndian); break;
      case 12: out[i] = data.getFloat64(off, littleEndian); break;
      default: out[i] = 0;
    }
  }
  return out;
}

// ─── Analyseur d'en-tête COG ────────────────────────────────────────────────
// Lit l'en-tête TIFF ET parcourt la chaîne des IFD pour exposer toute la
// pyramide (IFD0 pleine résolution + IFD d'aperçu 2× / 4× / 8× ...). Renvoie
// un descripteur dont le tableau `levels[]` a une entrée par niveau de
// résolution. Les appelants choisissent le niveau adapté au m/px de sortie
// demandé via pickSwissCOGLevel(), pour ne pas toujours payer les données
// natives à 0,5 m.
//
// Les COG swissSURFACE3D Raster font 2000×2000 px avec tuilage interne et
// portent en général 4 à 5 niveaux d'aperçu (1000², 500², 250², 125²). La charge
// par IFD est petite (< 1 Ko chacune) : un premier fetch d'en-tête de 128 Ko
// couvre IFD0 et tous les aperçus sans second aller-retour.
//
// Fonction d'appui : analyse une IFD qui commence à `ifdOffset`. Renvoie soit
//   { level, nextIFDOffset, _largestNeeded }
// soit une demande de nouveau fetch { _needMoreBytes }. `inheritedTiepoint` /
// `inheritedNoData` se propagent quand une IFD d'aperçu les omet (certains
// écrivains GDAL retirent ces tags des niveaux de pyramide).
function _parseIFD(ifdOffset, view, headerBytes, LE, inheritedTiepoint, inheritedNoData) {
  if (ifdOffset + 2 > headerBytes.byteLength) {
    return { _needMoreBytes: ifdOffset + 4096 };
  }
  const numEntries = view.getUint16(ifdOffset, LE);
  const entriesStart = ifdOffset + 2;
  if (entriesStart + numEntries * 12 + 4 > headerBytes.byteLength) {
    return { _needMoreBytes: entriesStart + numEntries * 12 + 4 };
  }

  const tags = {};
  let largestNeeded = entriesStart + numEntries * 12 + 4;
  for (let i = 0; i < numEntries; i++) {
    const entryOff = entriesStart + i * 12;
    const tag   = view.getUint16(entryOff, LE);
    const type  = view.getUint16(entryOff + 2, LE);
    const count = view.getUint32(entryOff + 4, LE);
    const typeSize = TIFF_TYPE_SIZE[type] || 0;
    const totalBytes = typeSize * count;
    const inline = totalBytes <= 4;
    const valueOffset = inline ? (entryOff + 8) : view.getUint32(entryOff + 8, LE);
    if (!inline) {
      const need = valueOffset + totalBytes;
      if (need > largestNeeded) largestNeeded = need;
    }
    tags[tag] = { type, count, valueOffset, inline, _entryOff: entryOff };
  }
  if (largestNeeded > headerBytes.byteLength) {
    return { _needMoreBytes: largestNeeded };
  }

  const readTag = (tagId) => {
    const t = tags[tagId];
    if (!t) return null;
    return readTagValue(view, t._entryOff, t.type, t.count, LE, headerBytes);
  };

  const width  = readTag(T_ImageWidth)?.[0]  ?? 0;
  const height = readTag(T_ImageLength)?.[0] ?? 0;
  const tileW  = readTag(T_TileWidth)?.[0];
  const tileH  = readTag(T_TileLength)?.[0];
  const compression = readTag(T_Compression)?.[0] ?? 1;
  const sampleFormat = readTag(T_SampleFormat)?.[0] ?? 1;
  const bitsPerSample = readTag(T_BitsPerSample)?.[0] ?? 8;
  const samplesPerPixel = readTag(T_SamplesPerPixel)?.[0] ?? 1;

  if (!tileW || !tileH) throw new Error('not a tiled TIFF');
  if (samplesPerPixel !== 1) throw new Error(`unsupported samplesPerPixel=${samplesPerPixel}`);
  if (sampleFormat !== 3 || bitsPerSample !== 32) {
    throw new Error(`unsupported sample format=${sampleFormat} bits=${bitsPerSample} (expected Float32)`);
  }
  if (compression !== 1 && compression !== 5 && compression !== 8 && compression !== 32946) {
    throw new Error(`unsupported compression=${compression}`);
  }
  const tileOffsets    = readTag(T_TileOffsets);
  const tileByteCounts = readTag(T_TileByteCounts);
  if (!tileOffsets || !tileByteCounts) {
    throw new Error('missing TileOffsets / TileByteCounts');
  }

  const pixelScale = readTag(T_ModelPixelScaleTag); // [sx, sy, sz]
  const tiepoint   = readTag(T_ModelTiepointTag) || inheritedTiepoint;
  const nodataTag  = readTag(T_GDAL_NODATA);
  let nodata = inheritedNoData;
  if (nodataTag && nodataTag.length > 0) {
    let str = '';
    for (let i = 0; i < nodataTag.length; i++) {
      const c = nodataTag[i];
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    const n = parseFloat(str);
    if (Number.isFinite(n)) nodata = n;
  }

  // pixelScale / tiepoint : les IFD d'aperçu les omettent souvent ; l'appelant
  // les déduit du rapport de dimensions avec IFD0 s'ils manquent.
  const tilesAcross = Math.ceil(width / tileW);
  const tilesDown   = Math.ceil(height / tileH);

  // Lit NextIFDOffset (les 4 derniers octets du répertoire).
  const nextIFDOffset = view.getUint32(entriesStart + numEntries * 12, LE);

  const level = {
    width, height,
    tileW, tileH,
    tilesAcross, tilesDown,
    compression,
    tileOffsets,
    tileByteCounts,
    pixelScale,    // null si absent — l'appelant le déduira
    tiepoint,      // tableau de 6 éléments ou null
    nodata,
  };
  return { level, nextIFDOffset, _largestNeeded: largestNeeded };
}

async function parseSwissCOGHeader(url, headerBytes) {
  if (headerBytes.byteLength < 16) throw new Error('header too short');
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

  const bo = view.getUint16(0, true);
  let LE;
  if (bo === 0x4949) LE = true;
  else if (bo === 0x4D4D) LE = false;
  else throw new Error('not a TIFF');

  const magic = view.getUint16(2, LE);
  if (magic !== 42) throw new Error(`unsupported TIFF magic ${magic}`);

  let nextOffset = view.getUint32(4, LE);
  const rawLevels = [];
  let inheritedTiepoint = null;
  let inheritedNoData = NaN;
  let safety = 0;
  let largestNeededOverall = 0;

  while (nextOffset !== 0 && safety < 16) {
    const r = _parseIFD(nextOffset, view, headerBytes, LE, inheritedTiepoint, inheritedNoData);
    if (r._needMoreBytes) {
      // Remonte une demande de nouveau fetch. On prend le plus grand entre le
      // besoin de cette IFD et tout dépassement découvert plus tôt, pour éviter
      // des allers-retours de fetchs.
      return { _needMoreBytes: Math.max(r._needMoreBytes, largestNeededOverall) };
    }
    rawLevels.push(r.level);
    if (r._largestNeeded > largestNeededOverall) largestNeededOverall = r._largestNeeded;
    if (r.level.tiepoint) inheritedTiepoint = r.level.tiepoint;
    if (Number.isFinite(r.level.nodata)) inheritedNoData = r.level.nodata;
    nextOffset = r.nextIFDOffset;
    safety++;
  }
  if (rawLevels.length === 0) throw new Error('no IFDs found');

  // IFD0 doit porter le géoréférencement.
  const lvl0 = rawLevels[0];
  if (!lvl0.pixelScale || !lvl0.tiepoint || lvl0.tiepoint.length < 6) {
    throw new Error('missing georeferencing tags on IFD0');
  }
  const [sx0, sy0] = lvl0.pixelScale;
  const [I0, J0, , X0, Y0] = lvl0.tiepoint;
  const originE = X0 - I0 * sx0;
  const originN = Y0 + J0 * sy0;

  // Construit levels[]. Pour les IFD d'aperçu sans pixelScale explicite, on le
  // déduit du rapport de dimensions avec IFD0 (convention COG standard).
  const levels = rawLevels.map((lv, idx) => {
    let pixelScaleX, pixelScaleY;
    if (lv.pixelScale) {
      pixelScaleX = lv.pixelScale[0];
      pixelScaleY = lv.pixelScale[1];
    } else {
      pixelScaleX = sx0 * (lvl0.width / lv.width);
      pixelScaleY = sy0 * (lvl0.height / lv.height);
    }
    return {
      idx,
      width: lv.width,
      height: lv.height,
      tileW: lv.tileW,
      tileH: lv.tileH,
      tilesAcross: lv.tilesAcross,
      tilesDown: lv.tilesDown,
      compression: lv.compression,
      tileOffsets: lv.tileOffsets,
      tileByteCounts: lv.tileByteCounts,
      pixelScaleX,
      pixelScaleY,
    };
  });

  // Tri des niveaux par pixelScale croissant (niveau 0 = le plus fin). Les COG
  // swisstopo les écrivent déjà dans cet ordre, mais on l'impose par précaution.
  levels.sort((a, b) => a.pixelScaleX - b.pixelScaleX);
  for (let i = 0; i < levels.length; i++) levels[i].idx = i;

  const nodata = Number.isFinite(lvl0.nodata) ? lvl0.nodata : NaN;

  return {
    url,
    LE,
    levels,
    originE, originN,
    nodata,
    // Emprise (LV95) d'après le niveau 0
    Emin: originE,
    Emax: originE + levels[0].width * levels[0].pixelScaleX,
    Nmax: originN,
    Nmin: originN - levels[0].height * levels[0].pixelScaleY,
  };
}

// Choisit le niveau le plus grossier dont le pixelScale reste ≤ au m/px de
// sortie voulu. Si le m/px demandé est plus fin que la résolution native du
// COG, renvoie le niveau 0. L'appelant doit borner mppOut à une valeur basse
// raisonnable (p. ex. 0,5 m natif) — on ne suréchantillonne pas.
function pickSwissCOGLevel(cog, mppOut) {
  const levels = cog.levels;
  let best = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].pixelScaleX <= mppOut) best = i;
    else break;
  }
  return best;
}

// ─── Internal-tile fetch + decode ───────────────────────────────────────────

// Décode en Float32Array une plage d'octets de tuile interne déjà récupérée.
// Séparé de fetchAndDecodeTile() pour que l'ordonnanceur de plages regroupées
// de swiss-fetcher.js puisse récupérer plusieurs tuiles en une requête HTTP puis
// décoder chaque tranche indépendamment (chaque tuile est compressée à part).
async function decodeSwissTileBytes(level, levelIdx, tileIndex, buf) {
  if (!buf) return null;

  let raw;
  if (level.compression === 1) {
    raw = new Uint8Array(buf);
  } else if (level.compression === 5) {
    try {
      raw = decodeTIFFLZW(new Uint8Array(buf));
    } catch (e) {
      console.warn(`[swiss-cog] LZW decode failed for L${levelIdx}/${tileIndex}:`, e?.message || e);
      return null;
    }
  } else if (level.compression === 8 || level.compression === 32946) {
    raw = await inflateDeflate(new Uint8Array(buf));
  } else {
    console.warn(`[swiss-cog] unsupported compression=${level.compression} for L${levelIdx}/${tileIndex}`);
    return null;
  }

  const expectedBytes = level.tileW * level.tileH * 4;
  if (raw.byteLength < expectedBytes) {
    if (DEBUG) console.warn(`[swiss-cog] short tile L${levelIdx}/${tileIndex}: ${raw.byteLength}/${expectedBytes}`);
    return null;
  }

  return new Float32Array(raw.buffer, raw.byteOffset, level.tileW * level.tileH);
}

async function fetchAndDecodeTile(cog, levelIdx, tileIndex, fetcher) {
  const level = cog.levels[levelIdx];
  if (!level) return null;
  const offset = level.tileOffsets[tileIndex];
  const length = level.tileByteCounts[tileIndex];
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
    return null;
  }
  const buf = await fetcher(cog.url, offset, length);
  if (!buf) return null;
  return decodeSwissTileBytes(level, levelIdx, tileIndex, buf);
}

// Convertit LV95 (E, N) → image (px, py) en coordonnées de *centre de pixel*
// pour le niveau de pyramide choisi.
function cogLV95ToPixel(cog, level, E, N) {
  const px = (E - cog.originE) / level.pixelScaleX;
  const py = (cog.originN - N) / level.pixelScaleY;
  return { px, py };
}

// Échantillonnage bilinéaire d'un point LV95 au niveau de pyramide donné.
// Renvoie NaN hors des bornes ou sans donnée. L'objet COG doit exposer une
// fonction asynchrone `getInternalTile(levelIdx, tileIndex)` (mémoïsée par
// l'appelant).
async function sampleSwissCOG(cog, levelIdx, E, N, getInternalTile) {
  if (E < cog.Emin || E > cog.Emax || N < cog.Nmin || N > cog.Nmax) return NaN;
  const level = cog.levels[levelIdx];
  if (!level) return NaN;

  const { px, py } = cogLV95ToPixel(cog, level, E, N);
  const x0 = Math.max(0, Math.min(Math.floor(px), level.width - 1));
  const y0 = Math.max(0, Math.min(Math.floor(py), level.height - 1));
  const x1 = Math.min(x0 + 1, level.width - 1);
  const y1 = Math.min(y0 + 1, level.height - 1);
  const fx = px - x0;
  const fy = py - y0;

  const sampleAt = async (x, y) => {
    const tx = (x / level.tileW) | 0;
    const ty = (y / level.tileH) | 0;
    const tileIndex = ty * level.tilesAcross + tx;
    const tile = await getInternalTile(levelIdx, tileIndex);
    if (!tile) return NaN;
    const lx = x - tx * level.tileW;
    const ly = y - ty * level.tileH;
    const v = tile[ly * level.tileW + lx];
    if (!Number.isFinite(v)) return NaN;
    if (cog.nodata !== undefined && v === cog.nodata) return NaN;
    return v;
  };

  const v00 = await sampleAt(x0, y0);
  const v10 = await sampleAt(x1, y0);
  const v01 = await sampleAt(x0, y1);
  const v11 = await sampleAt(x1, y1);

  // Si un voisin vaut NaN, repli sur la moyenne des plus proches valides.
  let sum = 0, count = 0;
  if (!Number.isNaN(v00)) { sum += v00 * (1 - fx) * (1 - fy); count++; }
  if (!Number.isNaN(v10)) { sum += v10 * fx * (1 - fy); count++; }
  if (!Number.isNaN(v01)) { sum += v01 * (1 - fx) * fy; count++; }
  if (!Number.isNaN(v11)) { sum += v11 * fx * fy; count++; }
  if (count === 0) return NaN;
  if (count === 4) return sum;
  // Couverture partielle — on renormalise par les seuls poids bilinéaires valides.
  let wSum = 0;
  if (!Number.isNaN(v00)) wSum += (1 - fx) * (1 - fy);
  if (!Number.isNaN(v10)) wSum += fx * (1 - fy);
  if (!Number.isNaN(v01)) wSum += (1 - fx) * fy;
  if (!Number.isNaN(v11)) wSum += fx * fy;
  return wSum > 0 ? sum / wSum : NaN;
}

// Échantillonneur bilinéaire synchrone. Même calcul que sampleSwissCOG(), mais
// lit les tuiles internes décodées par un accesseur *synchrone*
// (`getTileSync(cog, levelIdx, tileIndex) → Float32Array | null`). Les appelants
// DOIVENT avoir préchargé toutes les tuiles internes que touche le point avant
// l'appel. Retirer l'`await` par pixel (4 lectures de cache × 65 536 px ≈ 260 k
// microtâches par tuile) est le plus gros gain CPU du chemin de construction suisse.
function sampleSwissCOGSync(cog, levelIdx, E, N, getTileSync) {
  if (E < cog.Emin || E > cog.Emax || N < cog.Nmin || N > cog.Nmax) return NaN;
  const level = cog.levels[levelIdx];
  if (!level) return NaN;

  const px = (E - cog.originE) / level.pixelScaleX;
  const py = (cog.originN - N) / level.pixelScaleY;
  const widthM1 = level.width - 1;
  const heightM1 = level.height - 1;
  const x0 = Math.max(0, Math.min(Math.floor(px), widthM1));
  const y0 = Math.max(0, Math.min(Math.floor(py), heightM1));
  const x1 = Math.min(x0 + 1, widthM1);
  const y1 = Math.min(y0 + 1, heightM1);
  const fx = px - x0;
  const fy = py - y0;

  const tileW = level.tileW;
  const tileH = level.tileH;
  const across = level.tilesAcross;
  const nodata = cog.nodata;

  const sampleAt = (x, y) => {
    const tx = (x / tileW) | 0;
    const ty = (y / tileH) | 0;
    const tile = getTileSync(cog, levelIdx, ty * across + tx);
    if (!tile) return NaN;
    const v = tile[(y - ty * tileH) * tileW + (x - tx * tileW)];
    if (!Number.isFinite(v)) return NaN;
    if (nodata !== undefined && v === nodata) return NaN;
    return v;
  };

  const v00 = sampleAt(x0, y0);
  const v10 = sampleAt(x1, y0);
  const v01 = sampleAt(x0, y1);
  const v11 = sampleAt(x1, y1);

  let sum = 0, count = 0;
  if (!Number.isNaN(v00)) { sum += v00 * (1 - fx) * (1 - fy); count++; }
  if (!Number.isNaN(v10)) { sum += v10 * fx * (1 - fy); count++; }
  if (!Number.isNaN(v01)) { sum += v01 * (1 - fx) * fy; count++; }
  if (!Number.isNaN(v11)) { sum += v11 * fx * fy; count++; }
  if (count === 0) return NaN;
  if (count === 4) return sum;
  let wSum = 0;
  if (!Number.isNaN(v00)) wSum += (1 - fx) * (1 - fy);
  if (!Number.isNaN(v10)) wSum += fx * (1 - fy);
  if (!Number.isNaN(v01)) wSum += (1 - fx) * fy;
  if (!Number.isNaN(v11)) wSum += fx * fy;
  return wSum > 0 ? sum / wSum : NaN;
}
