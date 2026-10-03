export function mat4MultiplyInto(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[0 * 4 + i] * b[j * 4 + 0] +
        a[1 * 4 + i] * b[j * 4 + 1] +
        a[2 * 4 + i] * b[j * 4 + 2] +
        a[3 * 4 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

export function vec3Of(v: ArrayLike<number>): [number, number, number] {
  return [v[0]!, v[1]!, v[2]!];
}

/** Camera position in world space from a rigid view matrix (−Rᵀ·t). */
export function cameraPositionFromView(view: Float32Array): [number, number, number] {
  return [
    -(view[0]! * view[12]! + view[1]! * view[13]! + view[2]! * view[14]!),
    -(view[4]! * view[12]! + view[5]! * view[13]! + view[6]! * view[14]!),
    -(view[8]! * view[12]! + view[9]! * view[13]! + view[10]! * view[14]!),
  ];
}

/** Camera forward (−Z of the view basis) in world space. */
export function cameraForwardFromView(view: Float32Array): [number, number, number] {
  return [-view[8]!, -view[9]!, -view[10]!];
}
