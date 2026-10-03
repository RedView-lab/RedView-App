

// Résultats partagés des critères du bench LiDAR LOD.

interface CheckResult {
  name: string;
  pass: boolean;
  before: string;
  after: string;
}

export const results: CheckResult[] = [];
export const notes: string[] = [];

export function check(name: string, pass: boolean, before: string, after: string): void {
  results.push({ name, pass, before, after });
}

export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}
