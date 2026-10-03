/**
 * Filtres 1D sur des signaux échantillonnés à pas constant, en O(n) quelle
 * que soit la largeur de fenêtre (sommes préfixées), à fenêtre variable par
 * échantillon et à phase nulle : on connaît tout le parcours, la caméra n'a
 * donc aucun retard sur la trace.
 */

export type EdgeMode = 'odd' | 'even';

/**
 * Prolonge le signal au-delà de ses bords. `odd` (réflexion ponctuelle)
 * conserve la tendance linéaire — une position ou un cap lissé près d'une
 * extrémité garde sa direction ; `even` (miroir) conserve le niveau.
 */
function extend(values: Float64Array, pad: number, mode: EdgeMode): Float64Array {
  const n = values.length;
  const out = new Float64Array(n + 2 * pad);
  const first = values[0];
  const last = values[n - 1];
  for (let k = 0; k < out.length; k += 1) {
    const i = k - pad;
    if (i < 0) {
      const mirror = values[Math.min(n - 1, -i)];
      out[k] = mode === 'odd' ? 2 * first - mirror : mirror;
    } else if (i >= n) {
      const mirror = values[Math.max(0, 2 * (n - 1) - i)];
      out[k] = mode === 'odd' ? 2 * last - mirror : mirror;
    } else {
      out[k] = values[i];
    }
  }
  return out;
}

/** Intégrale de la fonction en escalier `values` (cellule k = [k, k + 1[), interpolée. */
function prefixIntegral(values: Float64Array): Float64Array {
  const prefix = new Float64Array(values.length + 1);
  for (let k = 0; k < values.length; k += 1) prefix[k + 1] = prefix[k] + values[k];
  return prefix;
}

function integralAt(prefix: Float64Array, u: number): number {
  const max = prefix.length - 1;
  if (u <= 0) return prefix[0];
  if (u >= max) return prefix[max];
  const k = Math.floor(u);
  return prefix[k] + (prefix[k + 1] - prefix[k]) * (u - k);
}

/**
 * Moyenne glissante centrée de demi-largeur `halfWidths[i]` (en échantillons,
 * fractionnaire : la moyenne varie continûment avec la largeur).
 */
function boxPass(
  values: Float64Array,
  halfWidth: (index: number) => number,
  maxHalfWidth: number,
  mode: EdgeMode,
  out: Float64Array,
): void {
  const n = values.length;
  const pad = Math.min(3 * n, Math.ceil(maxHalfWidth) + 2);
  const prefix = prefixIntegral(extend(values, pad, mode));
  for (let i = 0; i < n; i += 1) {
    const h = Math.min(halfWidth(i), pad - 1);
    const center = i + pad;
    out[i] = (integralAt(prefix, center + h + 1) - integralAt(prefix, center - h)) / (2 * h + 1);
  }
}

function sigmaAccessor(sigma: Float64Array | number): { at: (i: number) => number; max: number } {
  if (typeof sigma === 'number') {
    const value = Math.max(0, sigma);
    return { at: () => value, max: value };
  }
  let max = 0;
  for (let i = 0; i < sigma.length; i += 1) if (sigma[i] > max) max = sigma[i];
  return { at: (i) => Math.max(0, sigma[i]), max };
}

/**
 * Lissage quasi gaussien (trois moyennes glissantes successives) d'écart-type
 * `sigma` échantillons, constant ou par échantillon. Le résultat est rendu
 * dans un nouveau tableau ; l'origine du signal est retirée pendant le calcul
 * pour garder la précision des sommes préfixées.
 */
export function gaussianSmooth(values: Float64Array, sigma: Float64Array | number, mode: EdgeMode = 'odd'): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n < 3) {
    out.set(values);
    return out;
  }
  const { at, max } = sigmaAccessor(sigma);
  // Trois boîtes de largeur w ont une variance 3·w²/12 = σ² ⇒ w = 2σ, demi-largeur σ − ½.
  const halfWidth = (i: number) => Math.max(0, at(i) - 0.5);
  const maxHalf = Math.max(0, max - 0.5);
  const origin = values[0];
  let current = new Float64Array(n);
  for (let i = 0; i < n; i += 1) current[i] = values[i] - origin;
  let next = new Float64Array(n);
  for (let pass = 0; pass < 3; pass += 1) {
    boxPass(current, halfWidth, maxHalf, mode, next);
    [current, next] = [next, current];
  }
  for (let i = 0; i < n; i += 1) out[i] = current[i] + origin;
  return out;
}

/** Moyenne glissante simple (une passe) de demi-largeur variable. */
export function boxMean(values: Float64Array, halfWidths: Float64Array | number, mode: EdgeMode = 'even'): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const { at, max } = sigmaAccessor(halfWidths);
  const origin = values[0];
  const shifted = new Float64Array(n);
  for (let i = 0; i < n; i += 1) shifted[i] = values[i] - origin;
  boxPass(shifted, at, max, mode, out);
  for (let i = 0; i < n; i += 1) out[i] += origin;
  return out;
}

/**
 * Limiteur de pente symétrique : |y[i+1] − y[i]| ≤ maxStep[i]. Moyenne d'une
 * passe avant (en retard) et d'une passe arrière (en avance) : le résultat est
 * centré sur le signal et respecte la borne (moyenne de deux signaux bornés).
 */
export function symmetricSlewLimit(values: Float64Array, maxStep: (index: number) => number): Float64Array {
  const n = values.length;
  const forward = new Float64Array(n);
  const backward = new Float64Array(n);
  if (n === 0) return forward;
  forward[0] = values[0];
  for (let i = 1; i < n; i += 1) {
    const limit = maxStep(i - 1);
    const delta = values[i] - forward[i - 1];
    forward[i] = forward[i - 1] + Math.max(-limit, Math.min(limit, delta));
  }
  backward[n - 1] = values[n - 1];
  for (let i = n - 2; i >= 0; i -= 1) {
    const limit = maxStep(i);
    const delta = values[i] - backward[i + 1];
    backward[i] = backward[i + 1] + Math.max(-limit, Math.min(limit, delta));
  }
  for (let i = 0; i < n; i += 1) forward[i] = (forward[i] + backward[i]) / 2;
  return forward;
}

/** Médiane glissante de rayon `radius` (petit) : retire les pics isolés. */
export function medianFilter(values: Float64Array, radius: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const window: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = Math.min(radius, i, n - 1 - i);
    window.length = 0;
    for (let k = i - r; k <= i + r; k += 1) window.push(values[k]);
    window.sort((a, b) => a - b);
    out[i] = window[r];
  }
  return out;
}

/** Interpolation linéaire d'un tableau à pas constant, à un indice fractionnaire. */
export function sampleAt(values: Float64Array, index: number): number {
  const last = values.length - 1;
  if (index <= 0) return values[0];
  if (index >= last) return values[last];
  const i = Math.floor(index);
  return values[i] + (values[i + 1] - values[i]) * (index - i);
}
