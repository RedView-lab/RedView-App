// ============================================
// Composants de shaders WGSL — passe d'agrandissement
// ============================================
//
// Pendant que la caméra bouge, la scène peut être rendue à une fraction de la
// résolution du canvas (c'est le fill-rate qui limite les GPU intégrés) ; cette
// passe l'étire sur le canvas avec un filtrage bilinéaire.

export const BLIT_SHADER = /* wgsl */ `
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;

struct BlitVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn blit_vs(@builtin(vertex_index) vi: u32) -> BlitVsOut {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: BlitVsOut;
  out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}

@fragment
fn blit_fs(in: BlitVsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(colorTex, colorSampler, in.uv, 0.0).rgb, 1.0);
}
`;

/** Force de l'accentuation des images fixes accumulées (0 = désactivée, 1 = maximum d'AMD CAS). */
const PRESENT_SHARPNESS = 0.3;

/**
 * Affiche l'anticrénelage progressif des images fixes : la cible d'accumulation
 * (moyenne courante en lumière linéaire, rgba16float, taille du canvas) réencodée
 * en sRGB sur le canvas. Les échantillons décalés répartis sur un pixel agissent
 * comme un filtre boîte de 1 px qui adoucit un peu l'image : une légère
 * accentuation adaptative au contraste (AMD FidelityFX CAS, voisinage en croix)
 * rend le détail sans halo, plus faible là où le contraste local est fort.
 */
export const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var accumTex: texture_2d<f32>;

@vertex
fn present_vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn accumAt(p: vec2<i32>, maxCoord: vec2<i32>) -> vec3<f32> {
  return clamp(textureLoad(accumTex, clamp(p, vec2<i32>(0), maxCoord), 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn present_fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let maxCoord = vec2<i32>(textureDimensions(accumTex)) - vec2<i32>(1);
  let p = vec2<i32>(fragCoord.xy);
  let c = accumAt(p, maxCoord);
  let n = accumAt(p + vec2<i32>(0, -1), maxCoord);
  let s = accumAt(p + vec2<i32>(0, 1), maxCoord);
  let e = accumAt(p + vec2<i32>(1, 0), maxCoord);
  let w = accumAt(p + vec2<i32>(-1, 0), maxCoord);
  let lo = min(c, min(min(n, s), min(e, w)));
  let hi = max(c, max(max(n, s), max(e, w)));
  // Headroom before clipping, relative to the local maximum.
  let amount = sqrt(clamp(min(lo, vec3<f32>(1.0) - hi) / max(hi, vec3<f32>(1e-4)), vec3<f32>(0.0), vec3<f32>(1.0)));
  let weight = amount * (-1.0 / mix(8.0, 5.0, ${PRESENT_SHARPNESS.toFixed(2)}));
  let sharp = clamp((c + (n + s + e + w) * weight) / (vec3<f32>(1.0) + 4.0 * weight), vec3<f32>(0.0), vec3<f32>(1.0));
  let srgb = select(sharp * 12.92, 1.055 * pow(sharp, vec3<f32>(1.0 / 2.4)) - 0.055, sharp > vec3<f32>(0.0031308));
  return vec4<f32>(srgb, 1.0);
}
`;
