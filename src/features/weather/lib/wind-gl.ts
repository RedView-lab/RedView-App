/** Wind grid decoded from the VPS weather tiles (consumed by the wind layer). */
export interface WindData {
  /** Float32 grid: 3 floats per texel [u, v, speed] (row-major, top=north). */
  image: Float32Array;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  speedMin: number;
  speedMax: number;
}
