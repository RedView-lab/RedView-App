import { expect } from 'vitest'

/**
 * Typed arrays compared in one flat loop. Vitest's generic deep equality walks
 * them element by element (~1.4 µs per element: 1.35 s for 1 MB, a 130 000-point
 * LiDAR tile timed the CI runner out at 5 s). Same verdict as the generic path:
 * same type, same length, `Object.is` per element (NaN equals NaN, +0 ≠ −0);
 * anything else (DataView, Buffer against Uint8Array, mixed types) is left to it.
 */
function typedArraysEqual(a: unknown, b: unknown): boolean | undefined {
  if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return undefined
  if (a instanceof DataView || b instanceof DataView) return undefined
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return undefined
  const x = a as unknown as ArrayLike<number | bigint>
  const y = b as unknown as ArrayLike<number | bigint>
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false
  return true
}

expect.addEqualityTesters([typedArraysEqual])
