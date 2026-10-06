/**
 * Chargement des scripts classiques du Service Worker (public/sw-dem/) pour
 * les benchs : même code que le SW et son pool de workers pente.
 *
 * Les modules sont évalués dans CE realm (runInThisContext), pas dans un bac
 * à sable vm.createContext : un global contextifié fait passer chaque lecture
 * de `Math` / `Float32Array` par des intercepteurs (code 10-30× plus lent).
 * Leurs `const` de premier niveau vivent alors dans la portée lexicale
 * globale : chaque fichier n'est chargé qu'une fois par processus (un second
 * chargement lèverait « already been declared »), d'où ce registre partagé
 * entre les suites lancées par run-all-benchmarks.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export type SwContext = Record<string, unknown>;

const SW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sw-dem');
const loaded = new Set<string>();
let shimsInstalled = false;

function installShims(g: SwContext): void {
  if (shimsInstalled) return;
  shimsInstalled = true;
  g.self = globalThis;
  // Le SW construit ses clés de cache depuis des URL relatives à l'origine
  // (`new Request('/dem-tiles/…')`).
  const NativeRequest = globalThis.Request;
  g.Request = class extends NativeRequest {
    constructor(input: string | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
    }
  };
}

/** Charge (une fois) les modules donnés, dans l'ordre, et rend le global. */
export function loadSwModules(modules: string[]): SwContext {
  const g = globalThis as unknown as SwContext;
  installShims(g);
  for (const mod of modules) {
    if (loaded.has(mod)) continue;
    const file = path.join(SW_DIR, mod);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
    loaded.add(mod);
  }
  return g;
}

/** Lit une constante de premier niveau d'un module déjà chargé. */
export function readSwConstant<T>(name: string): T {
  return vm.runInThisContext(name) as T;
}
