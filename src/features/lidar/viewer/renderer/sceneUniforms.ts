/** Floats of the scene (camera + overlays) uniform block, see `packSceneUniforms`. */
export const SCENE_UNIFORM_FLOATS = 80;

/** Overlay and lighting state written after the camera in the scene uniform block. */
export interface SceneUniformState {
  pointSize: number;
  canvasWidth: number;
  canvasHeight: number;
  sunDir: [number, number, number];
  hmOriginX: number;
  hmOriginZ: number;
  hmScaleX: number;
  hmScaleZ: number;
  density: number;
  centerAltitude: number;
  maxAltitude: number;
  colorModeIndex: number;
  snowMode: number;
  snowOriginX: number;
  snowOriginZ: number;
  snowScaleX: number;
  snowScaleZ: number;
  slopeEnabled: number;
  slopeOpacity: number;
  altitudeEnabled: number;
  altitudeOpacity: number;
  sunlightEnabled: number;
  shadowEnabled: number;
  shadowOpacity: number;
  sunlightMapEnabled: number;
  sunlightMapOpacity: number;
  sunIntensity: number;
  exposure: number;
  sunColor: [number, number, number];
  skyColor: [number, number, number];
  sunDiscPos: [number, number, number] | null;
  sunDiscRadius: number;
  pointFilterEnabled: number;
  pointFilterMask: [number, number, number, number];
  /** 1 in photo mode (WebGPU): the shading pass writes albedo only, see photoMode/. */
  photoMode?: number;
}

/**
 * Packs the scene uniform block (layout shared with the WGSL `Scene` struct):
 * view-projection, camera basis and position, then the overlay state.
 */
export function packSceneUniforms(
  f: Float32Array,
  u32: Uint32Array,
  viewProj: Float32Array,
  view: Float32Array,
  camPos: [number, number, number],
  s: SceneUniformState,
): void {
  // 0..15: viewProj
  f.set(viewProj, 0);

  // 16..19: right, 20..23: up, 24..27: cameraPos
  f[16] = view[0]!; f[17] = view[4]!; f[18] = view[8]!; f[19] = 0;
  f[20] = view[1]!; f[21] = view[5]!; f[22] = view[9]!; f[23] = 0;
  f[24] = camPos[0]; f[25] = camPos[1]; f[26] = camPos[2]; f[27] = 1;

  // 28..31: scalars
  f[28] = s.pointSize;
  f[29] = s.photoMode ?? 0;
  f[30] = s.canvasWidth;
  f[31] = s.canvasHeight;

  // 32..35: sunDir
  const sunLen = Math.hypot(s.sunDir[0], s.sunDir[1], s.sunDir[2]) || 1;
  f[32] = s.sunDir[0] / sunLen;
  f[33] = s.sunDir[1] / sunLen;
  f[34] = s.sunDir[2] / sunLen;
  f[35] = 0;

  // 36..39: heightmap params
  f[36] = s.hmOriginX; f[37] = s.hmOriginZ; f[38] = s.hmScaleX; f[39] = s.hmScaleZ;

  // 40..43: density, altitude params, colour mode
  f[40] = s.density; f[41] = s.centerAltitude; f[42] = s.maxAltitude; f[43] = s.colorModeIndex;

  // 44..48: snow params
  f[44] = s.snowMode;
  f[45] = s.snowOriginX; f[46] = s.snowOriginZ; f[47] = s.snowScaleX; f[48] = s.snowScaleZ;

  // 49..52: slope and altitude state
  f[49] = s.slopeEnabled; f[50] = s.slopeOpacity; f[51] = s.altitudeEnabled; f[52] = s.altitudeOpacity;

  // 53..59: sunlight params
  f[53] = s.sunlightEnabled;
  f[54] = s.shadowEnabled;
  f[55] = s.shadowOpacity;
  f[56] = s.sunlightMapEnabled;
  f[57] = s.sunlightMapOpacity;
  f[58] = s.sunIntensity;
  f[59] = s.exposure;

  // 60..67: sun & sky colours
  f[60] = s.sunColor[0]; f[61] = s.sunColor[1]; f[62] = s.sunColor[2]; f[63] = 1.0;
  f[64] = s.skyColor[0]; f[65] = s.skyColor[1]; f[66] = s.skyColor[2]; f[67] = 1.0;

  // 68..71: sun disc
  if (s.sunDiscPos) {
    f[68] = s.sunDiscPos[0]; f[69] = s.sunDiscPos[1]; f[70] = s.sunDiscPos[2]; f[71] = s.sunDiscRadius;
  } else {
    f[68] = 0; f[69] = 0; f[70] = 0; f[71] = 0;
  }

  // 72..75: point filter params, 76..79: bitmask (u32 words)
  f[72] = s.pointFilterEnabled; f[73] = 0; f[74] = 0; f[75] = 0;
  u32[76] = s.pointFilterMask[0] >>> 0;
  u32[77] = s.pointFilterMask[1] >>> 0;
  u32[78] = s.pointFilterMask[2] >>> 0;
  u32[79] = s.pointFilterMask[3] >>> 0;
}
