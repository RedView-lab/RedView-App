import { expect } from 'vitest'

/**
 * Tableaux typés comparés en une seule boucle à plat. L'égalité profonde
 * générique de Vitest les parcourt élément par élément (~1,4 µs par élément :
 * 1,35 s pour 1 Mo ; une tuile LiDAR de 130 000 points faisait dépasser le délai
 * de 5 s au runner de CI). Même verdict que le chemin générique : même type,
 * même longueur, `Object.is` par élément (NaN égale NaN, +0 ≠ −0) ; tout le
 * reste (DataView, Buffer contre Uint8Array, types mélangés) lui est laissé.
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
