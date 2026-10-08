// ---------------------------------------------------------------------------
// Encodage et décodage des PNG Terrain-RGB
// Utilise un encodeur PNG brut pour éviter la gestion des couleurs
// d'OffscreenCanvas (gamma sRGB / profils ICC), qui altère les valeurs exactes
// de pixels dont a besoin le décodage raster-color-mix de Mapbox.
// ---------------------------------------------------------------------------

// ── Encodeur PNG brut ────────────────────────────────────────────────
// Construit un PNG minimal valide à partir d'un Uint8Array RGBA, sans aucun
// canvas. Garantit des valeurs de pixels exactes au bit près et aucun profil
// ICC embarqué.

function _pngCrc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const _CRC_TABLE = _pngCrc32Table();

function _pngCrc(buf, start, len) {
  let c = 0xffffffff;
  for (let i = start; i < start + len; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function _pngChunk(type, data) {
  // chunk = length(4) + type(4) + data(N) + crc(4)
  const len = data.length;
  const buf = new Uint8Array(12 + len);
  const view = new DataView(buf.buffer);
  view.setUint32(0, len);
  buf[4] = type.charCodeAt(0);
  buf[5] = type.charCodeAt(1);
  buf[6] = type.charCodeAt(2);
  buf[7] = type.charCodeAt(3);
  buf.set(data, 8);
  view.setUint32(8 + len, _pngCrc(buf, 4, 4 + len));
  return buf;
}

// ── Flux zlib : correspondances par répétition + Huffman dynamique ───
// CompressionStream('deflate') correspond au niveau 6 de zlib, dont la
// recherche de correspondances LZ77 coûte 20 à 30 ms sur une tuile de pente
// 512² filtrée en Paeth (Chromium, Node) sans rien y gagner : les résidus d'un
// champ lisse n'ont pas de répétitions lointaines. Mesuré sur de vraies tuiles
// (Mont-Blanc z12/z13, Lyon, Paris) : le niveau 6 donne 69 à 98 Ko, la stratégie
// Z_RLE de zlib 69 à 95 Ko en dix fois moins de temps. C'est cette stratégie —
// un octet qui répète le précédent devient une correspondance à distance 1
// (sol plat, mer), tout le reste un littéral codé en Huffman — avec un bloc
// dynamique tous les 16 K symboles comme zlib. Chaque arbre garde au moins deux
// codes, comme l'encodeur de zlib, pour que tous les décompresseurs l'acceptent
// (un code de longueurs de codes incomplet est une erreur pour l'inflate de zlib).
// Utilisé pour la tuile de pente grise opaque (buildGrayPng) et la tuile DEM RGB
// filtrée en Up (encodeTerrainRGBPng). Pas pour les lignes non filtrées : les
// triplets RGBA du Terrain-RGB se répètent à distance 4 et les paires gris +
// alpha à distance 2, où le niveau 6 reste 12 à 50 % plus petit.

const _ZRLE_BLOCK_SYMBOLS = 16384;
const _ZRLE_LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const _ZRLE_LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const _ZRLE_CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// Longueur de correspondance (3…258) → indice du code de longueur (0…28, soit les symboles 257…285).
const _ZRLE_LEN_CODE = (() => {
  const t = new Uint8Array(259);
  for (let c = 0; c < 29; c++) {
    const hi = Math.min(258, _ZRLE_LEN_BASE[c] + (1 << _ZRLE_LEN_EXTRA[c]) - 1);
    for (let l = _ZRLE_LEN_BASE[c]; l <= hi; l++) t[l] = c;
  }
  return t;
})();

// Longueurs de codes Huffman ≤ maxBits pour `freq` (construction à deux files
// sur les feuilles triées ; fréquences divisées par deux et reconstruction dans
// le rare cas où un code est trop long). L'appelant garantit au moins deux
// fréquences non nulles.
function _zrleCodeLengths(freq, maxBits) {
  const lengths = new Uint8Array(freq.length);
  const symbols = [];
  for (let s = 0; s < freq.length; s++) if (freq[s] > 0) symbols.push(s);
  const m = symbols.length;
  let weights = symbols.map((s) => freq[s]);
  const weight = new Float64Array(2 * m);
  const parent = new Int32Array(2 * m);
  const depth = new Uint16Array(2 * m);
  for (;;) {
    const order = weights.map((_, i) => i).sort((a, b) => weights[a] - weights[b]);
    for (let i = 0; i < m; i++) weight[i] = weights[order[i]];
    let leaf = 0;
    let node = m;
    const pick = (end) => (leaf < m && (node >= end || weight[leaf] <= weight[node]) ? leaf++ : node++);
    for (let k = m; k < 2 * m - 1; k++) {
      const a = pick(k);
      const b = pick(k);
      weight[k] = weight[a] + weight[b];
      parent[a] = k;
      parent[b] = k;
    }
    depth[2 * m - 2] = 0;
    let longest = 0;
    for (let k = 2 * m - 3; k >= 0; k--) {
      depth[k] = depth[parent[k]] + 1;
      if (k < m && depth[k] > longest) longest = depth[k];
    }
    if (longest <= maxBits) {
      for (let i = 0; i < m; i++) lengths[symbols[order[i]]] = depth[i];
      return lengths;
    }
    weights = weights.map((w) => (w >> 1) | 1);
  }
}

// Codes canoniques (RFC 1951 §3.2.2), bits inversés pour une sortie LSB d'abord.
function _zrleCodes(lengths) {
  const count = new Uint16Array(16);
  for (let s = 0; s < lengths.length; s++) count[lengths[s]]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + count[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s];
    if (!len) continue;
    let c = next[len]++;
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[s] = r;
  }
  return codes;
}

function _zrleEnsureTwoCodes(freq) {
  let used = 0;
  for (let s = 0; s < freq.length && used < 2; s++) if (freq[s] > 0) used++;
  for (let s = 0; used < 2; s++) if (freq[s] === 0) { freq[s] = 1; used++; }
}

function _zrleAdler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Flux zlib (RFC 1950) de `data`, lisible par tout décompresseur.
function zlibDeflateRle(data) {
  const n = data.length;
  let out = new Uint8Array(Math.max(1024, (n >> 1) + 1024));
  let pos = 2;
  out[0] = 0x78; // deflate, fenêtre de 32 K
  out[1] = 0x01; // FLEVEL 0 (le plus rapide), FCHECK tel que 0x7801 % 31 === 0
  let bitBuf = 0;
  let bitCnt = 0;
  const put = (value, bits) => {
    bitBuf |= value << bitCnt;
    bitCnt += bits;
    while (bitCnt >= 8) {
      out[pos++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };

  const symbols = new Uint16Array(_ZRLE_BLOCK_SYMBOLS); // < 256 littéral, sinon 256 + longueur de correspondance
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  const clFreq = new Uint32Array(19);
  const clOps = new Uint16Array(286 + 30); // symbole de longueur de code | valeur supplémentaire << 5
  let i = 0;
  do {
    litFreq.fill(0);
    distFreq.fill(0);
    let count = 0;
    while (i < n && count < _ZRLE_BLOCK_SYMBOLS) {
      const byte = data[i];
      if (i > 0 && byte === data[i - 1]) {
        const end = Math.min(n, i + 258);
        let j = i + 1;
        while (j < end && data[j] === byte) j++;
        const len = j - i;
        if (len >= 3) {
          symbols[count++] = 256 + len;
          litFreq[257 + _ZRLE_LEN_CODE[len]]++;
          distFreq[0]++;
          i = j;
          continue;
        }
      }
      symbols[count++] = byte;
      litFreq[byte]++;
      i++;
    }
    const final = i >= n;
    litFreq[256] = 1;
    _zrleEnsureTwoCodes(litFreq);
    _zrleEnsureTwoCodes(distFreq);
    const litLen = _zrleCodeLengths(litFreq, 15);
    const distLen = _zrleCodeLengths(distFreq, 15);
    const litCode = _zrleCodes(litLen);
    const distCode = _zrleCodes(distLen);
    let nLit = 286;
    while (nLit > 257 && litLen[nLit - 1] === 0) nLit--;
    let nDist = 30;
    while (nDist > 1 && distLen[nDist - 1] === 0) nDist--;

    // Longueurs de codes des deux arbres en une seule suite, codée par répétition (16/17/18).
    const seq = new Uint8Array(nLit + nDist);
    seq.set(litLen.subarray(0, nLit), 0);
    seq.set(distLen.subarray(0, nDist), nLit);
    clFreq.fill(0);
    let nOps = 0;
    const op = (sym, extra) => { clOps[nOps++] = sym | (extra << 5); clFreq[sym]++; };
    for (let k = 0; k < seq.length;) {
      const len = seq[k];
      let run = 1;
      while (k + run < seq.length && seq[k + run] === len) run++;
      k += run;
      if (len === 0) {
        while (run >= 11) { const r = Math.min(run, 138); op(18, r - 11); run -= r; }
        if (run >= 3) { op(17, run - 3); run = 0; }
      } else {
        op(len, 0);
        run--;
        while (run >= 3) { const r = Math.min(run, 6); op(16, r - 3); run -= r; }
      }
      while (run-- > 0) op(len, 0);
    }
    _zrleEnsureTwoCodes(clFreq);
    const clLen = _zrleCodeLengths(clFreq, 7);
    const clCode = _zrleCodes(clLen);
    let nCl = 19;
    while (nCl > 4 && clLen[_ZRLE_CL_ORDER[nCl - 1]] === 0) nCl--;

    // Pire cas : 21 bits par symbole (15 + 5 bits supplémentaires + 1 distance) +
    // l'en-tête du bloc (≤ 316 opérations de longueur de code de 14 bits).
    const need = pos + count * 3 + 1024;
    if (need > out.length) {
      const grown = new Uint8Array(Math.max(need, out.length * 2));
      grown.set(out.subarray(0, pos));
      out = grown;
    }

    put(final ? 1 : 0, 1);
    put(2, 2); // Huffman dynamique
    put(nLit - 257, 5);
    put(nDist - 1, 5);
    put(nCl - 4, 4);
    for (let k = 0; k < nCl; k++) put(clLen[_ZRLE_CL_ORDER[k]], 3);
    for (let k = 0; k < nOps; k++) {
      const sym = clOps[k] & 31;
      put(clCode[sym], clLen[sym]);
      if (sym === 16) put(clOps[k] >> 5, 2);
      else if (sym === 17) put(clOps[k] >> 5, 3);
      else if (sym === 18) put(clOps[k] >> 5, 7);
    }
    const distSym = distCode[0];
    const distBits = distLen[0];
    for (let k = 0; k < count; k++) {
      const s = symbols[k];
      if (s < 256) {
        put(litCode[s], litLen[s]);
      } else {
        const len = s - 256;
        const c = _ZRLE_LEN_CODE[len];
        put(litCode[257 + c], litLen[257 + c]);
        if (_ZRLE_LEN_EXTRA[c]) put(len - _ZRLE_LEN_BASE[c], _ZRLE_LEN_EXTRA[c]);
        put(distSym, distBits);
      }
    }
    put(litCode[256], litLen[256]);
  } while (i < n);

  if (bitCnt > 0) out[pos++] = bitBuf & 0xff;
  const adler = _zrleAdler32(data);
  if (pos + 4 > out.length) {
    const grown = new Uint8Array(pos + 4);
    grown.set(out.subarray(0, pos));
    out = grown;
  }
  out[pos++] = adler >>> 24;
  out[pos++] = (adler >>> 16) & 0xff;
  out[pos++] = (adler >>> 8) & 0xff;
  out[pos++] = adler & 0xff;
  return out.subarray(0, pos);
}

async function buildRawPng(width, height, rgba) {
  // Construit les lignes brutes : octet de filtre (0) + données RGBA de chaque ligne.
  // `set(subarray)` est un memcpy natif — ~10× plus rapide qu'une boucle JS octet par octet.
  const rowLen = width * 4;
  const rowBytes = 1 + rowLen;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const srcOff = y * rowLen;
    raw[off] = 0; // filtre : None
    raw.set(rgba.subarray(srcOff, srcOff + rowLen), off + 1);
  }
  return buildPngFromScanlines(width, height, raw);
}

// Assemble un PNG à partir de lignes déjà construites (octet de filtre + données).
// `colorType` : 6 = RGBA (défaut), 2 = RGB, 4 = gris + alpha.
async function buildPngFromScanlines(width, height, raw, colorType = 6) {
  // Compression deflate via CompressionStream
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return buildPngFromZlib(width, height, new Uint8Array(compressed), colorType);
}

// PNG autour d'un flux zlib déjà compressé des lignes.
function buildPngFromZlib(width, height, compData, colorType) {
  // Signature PNG
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR : largeur, hauteur, profondeur 8 bits, type de couleur 6 (RGBA)
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;  // profondeur de bits
  ihdrData[9] = colorType;
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = _pngChunk('IHDR', ihdrData);

  // IDAT
  const idat = _pngChunk('IDAT', compData);

  // IEND
  const iend = _pngChunk('IEND', new Uint8Array(0));

  // Assemble
  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let pos = 0;
  png.set(sig, pos); pos += sig.length;
  png.set(ihdr, pos); pos += ihdr.length;
  png.set(idat, pos); pos += idat.length;
  png.set(iend, pos);

  return new Blob([png], { type: 'image/png' });
}

// ── PNG gris + alpha (type de couleur 4, filtre Sub) ─────────────────
// Les tuiles de pente portent UN octet utile par pixel (l'angle en gamma
// racine) plus l'alpha NoData / zone : moitié moins d'octets par ligne qu'en
// RGBA, donc deflate travaille sur moitié moins de données. Les décodeurs
// d'image l'étendent en RGBA avec R = G = B = gris, exactement ce que lit le
// raster-color-mix [90, 0, 0, 0] de Mapbox.
// Reste au niveau 6 de zlib : les octets d'alpha entrelacés avec les gris
// cassent les répétitions, et zlibDeflateRle donnait 12 à 18 % de plus sur de
// vraies tuiles de zone.
async function buildGrayAlphaPng(width, height, gray, alpha) {
  const rowBytes = 1 + width * 2;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const src = y * width;
    raw[off] = 1; // type de filtre : Sub (résidu par rapport au pixel précédent)
    let prevGray = 0;
    let prevAlpha = 0;
    for (let x = 0; x < width; x++) {
      const g = gray[src + x];
      const a = alpha[src + x];
      const o = off + 1 + x * 2;
      raw[o] = (g - prevGray) & 0xff;
      raw[o + 1] = (a - prevAlpha) & 0xff;
      prevGray = g;
      prevAlpha = a;
    }
  }
  return buildPngFromScanlines(width, height, raw, 4);
}

// ── PNG gris (type de couleur 0, filtre Paeth) ───────────────────────
// Tuile à un seul canal, entièrement opaque (la tuile de pente habituelle) : un
// octet par pixel. Paeth prédit à partir des pixels de gauche, du dessus et en
// haut à gauche, ce qui convient au champ 2D lisse d'un raster de pente
// suréchantillonné : mesuré sur une tuile 512² de type LiDAR, 15 ms / 121 Ko
// contre 27 ms / 147 Ko en gris+alpha Sub. zlibDeflateRle fait ensuite passer
// une vraie tuile 512² de 22-34 ms (niveau 6) à quelques ms pour la même taille.
async function buildGrayPng(width, height, gray) {
  const rowBytes = 1 + width;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const row = y * width;
    const up = row - width;
    raw[off] = 4; // type de filtre : Paeth
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? gray[row + x - 1] : 0;
      const b = y > 0 ? gray[up + x] : 0;
      const c = x > 0 && y > 0 ? gray[up + x - 1] : 0;
      const p = a + b - c;
      const pa = p > a ? p - a : a - p;
      const pb = p > b ? p - b : b - p;
      const pc = p > c ? p - c : c - p;
      const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      raw[off + 1 + x] = (gray[row + x] - pred) & 0xff;
    }
  }
  return buildPngFromZlib(width, height, zlibDeflateRle(raw), 0);
}

// ── Encodeur PNG optimisé pour les pentes (RGBA, filtre Sub) ─────────
// Chemin rapide dédié aux tuiles de pente. Les encodeurs DEM / altitude
// utilisent toujours buildRawPng (filtre 0 = None) parce qu'ils encodent TROIS
// octets utiles par pixel qui profitent peu de la prédiction. Les tuiles de
// pente sont pour l'essentiel des gradients lisses à un canal — chaque pixel
// est fortement corrélé à son voisin de gauche —, donc le filtre PNG Sub
// (type 1) transforme la ligne en résidus quasi nuls que deflate compresse en
// une fraction du temps et de la taille. Sur une tuile de pente 256×256 typique :
//   filtre 0 (None) → ~6 à 12 Ko après deflate, ~3 à 6 ms de CPU
//   filtre 1 (Sub)  → ~2 à 4 Ko après deflate, ~1 à 2 ms de CPU
// Le décodeur (source raster Mapbox, décodeur PNG du navigateur) gère tous les
// filtres PNG standard de façon transparente : aucun changement côté client.
async function buildRawPngSlope(width, height, rgba) {
  const rowBytes = 1 + width * 4;
  const raw = new Uint8Array(height * rowBytes);
  // Filtre Sub (type 1) : résidu = octet - octet_quatre_positions_avant (même
  // canal du pixel précédent). 4 canaux → pas de 4. Cas particulier du premier
  // pixel de chaque ligne (pas de voisin de gauche → résidu = valeur brute).
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const srcRow = y * width * 4;
    raw[off] = 1; // type de filtre : Sub
    // Premier pixel de la ligne : pas de voisin de gauche → stocké tel quel.
    raw[off + 1] = rgba[srcRow];
    raw[off + 2] = rgba[srcRow + 1];
    raw[off + 3] = rgba[srcRow + 2];
    raw[off + 4] = rgba[srcRow + 3];
    // Pixels suivants : on soustrait l'octet situé 4 positions avant.
    for (let x = 4; x < width * 4; x++) {
      raw[off + 1 + x] = (rgba[srcRow + x] - rgba[srcRow + x - 4]) & 0xff;
    }
  }

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  const compData = new Uint8Array(compressed);

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;  // profondeur de bits
  ihdrData[9] = 6;  // type de couleur : RGBA (comme buildRawPng, pour que le décodage Mapbox
                    // suive le même chemin ; seul le filtre interne au PNG diffère).
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = _pngChunk('IHDR', ihdrData);
  const idat = _pngChunk('IDAT', compData);
  const iend = _pngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let pos = 0;
  png.set(sig, pos); pos += sig.length;
  png.set(ihdr, pos); pos += ihdr.length;
  png.set(idat, pos); pos += idat.length;
  png.set(iend, pos);
  return new Blob([png], { type: 'image/png' });
}

// ── Encodage des altitudes → PNG Terrain-RGB ─────────────────────────

// Tuile DEM plate précalculée au niveau de la mer (tous les pixels à altitude=0).
// Générée une seule fois à la demande — renvoyée pour toute requête DEM en échec,
// pour que Mapbox GL ait toujours un maillage de terrain valide sur lequel
// draper l'imagerie satellite. Sans elle, Mapbox affiche du blanc là où il n'y a
// pas de DEM → globe cassé.
let _flatDemTilePromise = null;

function getFlatDemTile() {
  if (!_flatDemTilePromise) {
    _flatDemTilePromise = (async () => {
      const size = DEM_TILE_SIZE;
      const elevations = new Float32Array(size * size); // Tout à zéro = niveau de la mer
      const blob = await encodeTerrainRGBPng(elevations);
      if (typeof swLog !== 'undefined' && swLog.isDebug()) {
        swLog.debug('build', `Flat DEM tile generated: ${blob.size} bytes (${size}x${size})`);
      }
      return blob;
    })();
  }
  return _flatDemTilePromise;
}

// Écrit directement les lignes du Terrain-RGB : RGB (type de couleur 2, l'alpha
// valait toujours 255) avec le filtre Up du PNG (chaque octet moins celui du
// dessus), compressé par zlibDeflateRle. Les lignes voisines d'un champ
// d'altitude diffèrent peu : les résidus sont de petits octets que Huffman code
// bien sans recherche de correspondances. Mesuré dans Chromium contre
// l'ancienne tuile RGBA non filtrée passée par CompressionStream (niveau 6) :
// vraies tuiles Terrarium (Mont-Blanc z12, Chamonix z13, Aiguilles z14, Beauce
// z12) 3,1-4,6 ms / 45-62 Ko au lieu de 5,7-10,2 ms / 60-88 Ko ; une surface
// bruitée de type 0,40 m 5,1 ms / 88 Ko au lieu de 8,6 ms / 113 Ko. Le niveau 6
// sur les lignes filtrées est plus petit sur les tuiles lisses (26-41 Ko) mais
// 84 % plus lent sur les bruitées, où sa recherche ne trouve rien. Décodage un
// peu plus rapide aussi (createImageBitmap + getImageData).
// Les décodeurs lisent tous les types de couleur et filtres PNG : les tuiles
// déjà en cache dans l'ancien format restent valides.
//
// La même boucle produit aussi la grille Float32 exacte que renverrait un
// décodage ultérieur de ce blob (`-10000 + val * 0.1`, calculée avec le même
// `val` entier) et en amorce DECODED_TERRAIN_RGB_CACHE : le garde-fou de santé,
// le test de planéité de l'overzoom et les décodages pente / altitude d'une
// tuile fraîchement construite ne coûtent alors rien.
async function encodeTerrainRGBPng(elevations) {
  const size = DEM_TILE_SIZE;
  const rowLen = size * 3;
  const rowBytes = 1 + rowLen;
  const raw = new Uint8Array(size * rowBytes);
  const decoded = new Float32Array(size * size);
  // Octets de la ligne du dessus (des zéros au-dessus de la première ligne : Up = None).
  const above = new Uint8Array(rowLen);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 2; // filtre : Up
    let o = rowOffset + 1;
    let p = 0;
    const rowStart = y * size;
    for (let x = 0; x < size; x++) {
      const i = rowStart + x;
      const height = sanitizeElevation(elevations[i]);
      const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
      const r = (val >> 16) & 0xff;
      const g = (val >> 8) & 0xff;
      const b = val & 0xff;
      // Uint8Array stocke la différence modulo 256, comme le veut le filtre.
      raw[o] = r - above[p];
      raw[o + 1] = g - above[p + 1];
      raw[o + 2] = b - above[p + 2];
      above[p] = r;
      above[p + 1] = g;
      above[p + 2] = b;
      o += 3;
      p += 3;
      decoded[i] = -10000 + val * 0.1;
    }
  }

  const blob = buildPngFromZlib(size, size, zlibDeflateRle(raw), 2);
  decodedTerrainRgbPut(blob, decoded);
  return blob;
}

// ── Décodage d'un PNG Terrain-RGB → altitudes Float32 ────────────────
//
// Mémoïsé par identité de Blob via une WeakMap. Le même Blob est souvent
// décodé plusieurs fois dans le même tick :
//   * le handler de pente décode son blob DEM, puis le handler d'altitude
//     décode le MÊME blob quelques ms plus tard quand les deux overlays sont actifs
//   * les chemins de composition décodent leur blob Mapbox de base, puis
//     build-tile redécode le même blob Mapbox comme source de préremplissage AWS
//   * tryParentOverzoom décode un blob parent pour vérifier ses statistiques de
//     planéité, puis overzoomDemTile redécode le même blob parent
// Chaque décodage coûte ~8 à 20 ms (createImageBitmap + getImageData + boucle
// Float32 pour une tuile 256², plus pour une tuile Mapbox 512²). Sur un zoom
// avant de 100 tuiles avec pentes et altitude actives, cela économise ~2 à 4 s
// de CPU sur le fil du SW.
//
// LRU borné (Map dans l'ordre d'insertion), PAS une WeakMap : DEM_HOT_CACHE
// garde jusqu'à 2048 blobs de tuiles vivants, et une WeakMap épinglait une
// grille Float32 de 256 Ko par blob (jusqu'à ~512 Mo de tas du SW) jamais
// relue — les lectures du niveau chaud passent par Response.blob(), qui
// produit une nouvelle identité de Blob. 128 entrées (~32 Mo) couvrent encore
// toutes les réutilisations en rafale (garde-fou, overzoom, voisines de pente,
// parents frères). Renvoie un Float32Array PARTAGÉ : les appelants ne doivent
// PAS le modifier en place (composite.js copie avant le despike).
const DECODED_TERRAIN_RGB_CACHE_MAX = 128;
const DECODED_TERRAIN_RGB_CACHE = new Map();

function decodedTerrainRgbGet(blob) {
  const entry = DECODED_TERRAIN_RGB_CACHE.get(blob);
  if (!entry) return null;
  DECODED_TERRAIN_RGB_CACHE.delete(blob);
  DECODED_TERRAIN_RGB_CACHE.set(blob, entry);
  return entry;
}

function decodedTerrainRgbPut(blob, elevations) {
  if (!blob || !elevations) return;
  DECODED_TERRAIN_RGB_CACHE.delete(blob);
  DECODED_TERRAIN_RGB_CACHE.set(blob, elevations);
  while (DECODED_TERRAIN_RGB_CACHE.size > DECODED_TERRAIN_RGB_CACHE_MAX) {
    const oldest = DECODED_TERRAIN_RGB_CACHE.keys().next().value;
    DECODED_TERRAIN_RGB_CACHE.delete(oldest);
  }
}

let _sharedOffscreenCanvas = null;
let _sharedOffscreenCtx = null;

function getSharedOffscreenCtx(width, height) {
  if (!_sharedOffscreenCanvas) {
    _sharedOffscreenCanvas = new OffscreenCanvas(width, height);
    _sharedOffscreenCtx = _sharedOffscreenCanvas.getContext('2d', {
      colorSpace: 'srgb',
      willReadFrequently: true,
    });
  } else if (_sharedOffscreenCanvas.width !== width || _sharedOffscreenCanvas.height !== height) {
    _sharedOffscreenCanvas.width = width;
    _sharedOffscreenCanvas.height = height;
    _sharedOffscreenCtx = _sharedOffscreenCanvas.getContext('2d', {
      colorSpace: 'srgb',
      willReadFrequently: true,
    });
  }
  return _sharedOffscreenCtx;
}

async function decodeTerrainRGBBlob(blob) {
  const cached = decodedTerrainRgbGet(blob);
  if (cached) return cached;
  const elevations = await decodeTerrainRGBBlobUncached(blob);
  decodedTerrainRgbPut(blob, elevations);
  return elevations;
}

async function decodeTerrainRGBBlobUncached(blob) {
  const img = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const width = img.width;
  const height = img.height;
  let imageData;
  try {
    const ctx = getSharedOffscreenCtx(width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, width, height);
  } finally {
    img.close(); // Libère tout de suite la mémoire de texture GPU
  }
  const pixels = imageData.data;
  const len = width * height;
  const elevations = new Float32Array(len);
  const u32 = new Uint32Array(pixels.buffer, pixels.byteOffset, len);

  for (let i = 0; i < len; i++) {
    const val = u32[i];
    // En petit-boutiste : val = (A << 24) | (B << 16) | (G << 8) | R
    // Formule Terrain-RGB : -10000 + ((R << 16) | (G << 8) | B) * 0.1
    const rgb = ((val & 0xff) << 16) | (val & 0x0000ff00) | ((val >> 16) & 0xff);
    elevations[i] = -10000 + rgb * 0.1;
  }

  // ── DEBUG : journalise les diagnostics de décodage ──
  if (DEBUG) {
    let minE = Infinity, maxE = -Infinity, sumE = 0;
    for (let i = 0; i < elevations.length; i++) {
      const e = elevations[i];
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      sumE += e;
    }
    const meanE = sumE / elevations.length;
    console.log(
      `[slope][decode] ${width}x${height} blob=${blob.size}B | elev min=${minE.toFixed(1)} max=${maxE.toFixed(1)} mean=${meanE.toFixed(1)} range=${(maxE - minE).toFixed(1)}m`,
    );
    if (maxE - minE < 1) {
      console.warn('[slope][decode] FLAT DEM — elevation range < 1 m');
    }
  }

  return elevations;
}

/**
 * Suréchantillonneur Catmull-Rom direct de Float32Array vers Float32Array.
 * Évite les allocations de tableaux temporaires dans la boucle interne et les
 * étapes intermédiaires d'encodage / décodage PNG.
 */
function overzoomDemElevations(parentElevations, parentZ, parentX, parentY, targetZ, targetX, targetY) {
  if (!parentElevations) return null;
  const size = DEM_TILE_SIZE; // 256
  const dz = targetZ - parentZ;
  const nChildren = 1 << dz; // p. ex. dz=2 → 4 sous-tuiles par axe

  // Quel enfant dans la grille du parent
  const childX = targetX - (parentX << dz);
  const childY = targetY - (parentY << dz);

  // Garde-fou : la tuile cible doit vraiment se trouver dans le parent.
  if (childX < 0 || childY < 0 || childX >= nChildren || childY >= nChildren) {
    if (DEBUG) console.warn(
      `[sw-dem][overzoom] child OOB: target ${targetZ}/${targetX}/${targetY} not inside parent ${parentZ}/${parentX}/${parentY} (child=${childX},${childY} max=${nChildren - 1})`,
    );
    return null;
  }

  // Région de pixels source dans la tuile parente
  const srcSize = size / nChildren; // pixels couverts par un enfant
  const srcX0 = childX * srcSize;
  const srcY0 = childY * srcSize;

  // Aide : échantillonnage borné des altitudes du parent
  const pSample = (px, py) => {
    const cx = Math.max(0, Math.min(px, size - 1));
    const cy = Math.max(0, Math.min(py, size - 1));
    return parentElevations[cy * size + cx];
  };

  const out = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    const sy = srcY0 + (py + 0.5) * srcSize / size - 0.5;
    const iy = Math.floor(sy);
    const fy = sy - iy;

    for (let px = 0; px < size; px++) {
      const sx = srcX0 + (px + 0.5) * srcSize / size - 0.5;
      const ix = Math.floor(sx);
      const fx = sx - ix;

      // Noyau Catmull-Rom 4×4 sans allocation de tableau dans la boucle interne
      const r0 = cubicHermite(pSample(ix - 1, iy - 1), pSample(ix, iy - 1), pSample(ix + 1, iy - 1), pSample(ix + 2, iy - 1), fx);
      const r1 = cubicHermite(pSample(ix - 1, iy),     pSample(ix, iy),     pSample(ix + 1, iy),     pSample(ix + 2, iy),     fx);
      const r2 = cubicHermite(pSample(ix - 1, iy + 1), pSample(ix, iy + 1), pSample(ix + 1, iy + 1), pSample(ix + 2, iy + 1), fx);
      const r3 = cubicHermite(pSample(ix - 1, iy + 2), pSample(ix, iy + 2), pSample(ix + 1, iy + 2), pSample(ix + 2, iy + 2), fx);

      let val = cubicHermite(r0, r1, r2, r3, fy);
      if (val < MIN_VALID_ELEVATION_M) val = MIN_VALID_ELEVATION_M;
      else if (val > MAX_VALID_ELEVATION_M) val = MAX_VALID_ELEVATION_M;
      out[py * size + px] = val;
    }
  }

  return out;
}

/**
 * À partir d'un blob de tuile DEM parente en (parentZ, parentX, parentY),
 * extrait la sous-région correspondant à (targetZ, targetX, targetY) et la
 * suréchantillonne en bicubique (Catmull-Rom) à DEM_TILE_SIZE × DEM_TILE_SIZE.
 *
 * Renvoie un Blob PNG Terrain-RGB, ou null en cas d'échec.
 */
async function overzoomDemTile(parentBlob, parentZ, parentX, parentY, targetZ, targetX, targetY) {
  const parentElevations = await decodeTerrainRGBBlob(parentBlob);
  const out = overzoomDemElevations(parentElevations, parentZ, parentX, parentY, targetZ, targetX, targetY);
  if (!out) return null;
  return encodeTerrainRGBPng(out);
}
