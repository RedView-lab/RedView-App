// ============================================
// Cloud phase function: Henyey-Greenstein + Draine blend
// ============================================
//
// Jendersie & d'Eon, "An Approximate Mie Scattering Function for Fog and
// Cloud Rendering" (SIGGRAPH 2023 Talks, NVIDIA): a HG forward peak blended
// with Draine's phase function matches 95 % of the Mie phase function of
// water droplets, from a fit on the mean droplet diameter d (5–50 µm). The
// cloud shader evaluates the same formula with the parameters computed here.

const INV_4PI = 1 / (4 * Math.PI);

function henyeyGreenstein(cosTheta: number, g: number): number {
  const g2 = g * g;
  const denom = 1 + g2 - 2 * g * cosTheta;
  return INV_4PI * (1 - g2) / (denom * Math.sqrt(denom));
}

/** Draine's two-parameter phase function (HG for α = 0, Cornette-Shanks for α = 1). */
function draine(cosTheta: number, g: number, alpha: number): number {
  const g2 = g * g;
  const denom = 1 + g2 - 2 * g * cosTheta;
  return INV_4PI * ((1 - g2) / (denom * Math.sqrt(denom)))
    * ((1 + alpha * cosTheta * cosTheta) / (1 + (alpha * (1 + 2 * g2)) / 3));
}

export interface MieFit {
  gHG: number;
  gD: number;
  alpha: number;
  wD: number;
}

/** Fit of the paper for droplets of mean diameter `d` µm (5 ≤ d ≤ 50). */
export function mieFitForDiameter(d: number): MieFit {
  const dd = Math.max(5, Math.min(50, d));
  return {
    gHG: Math.exp(-0.0990567 / (dd - 1.67154)),
    gD: Math.exp(-2.20679 / (dd + 3.91029) - 0.428934),
    alpha: Math.exp(3.62489 - 8.29288 / (dd + 5.52825)),
    wD: Math.exp(-0.599085 / (dd - 0.641583) - 0.665888),
  };
}

export function approximateMie(cosTheta: number, fit: MieFit): number {
  return (1 - fit.wD) * henyeyGreenstein(cosTheta, fit.gHG) + fit.wD * draine(cosTheta, fit.gD, fit.alpha);
}

/** Mean droplet diameter of cumulus clouds (µm). */
export const CLOUD_DROPLET_DIAMETER_UM = 20;
