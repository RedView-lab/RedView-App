/**
 * File d'attente par clé, dans la mémoire du processus : les opérations sur
 * une même clé (un client Stripe, un projet partagé…) passent l'une après
 * l'autre, celles de clés différentes en parallèle. Pour les séquences
 * « lire l'état puis écrire » chez un service tiers qui n'offre ni
 * transaction ni verrou : deux requêtes simultanées y lisaient le même état
 * et écrivaient chacune par-dessus l'autre. Un seul serveur d'app : un verrou
 * en mémoire suffit.
 *
 * Sur globalThis : le serveur de dev recharge les modules d'API à chaque
 * requête, une file locale au module serait perdue d'un appel à l'autre.
 */

type LockTable = Map<string, Promise<unknown>>;

const tables: Map<string, LockTable> = ((globalThis as { __rvKeyedLocks?: Map<string, LockTable> })
  .__rvKeyedLocks ??= new Map());

export function createKeyedLock(name: string): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  let locks = tables.get(name);
  if (!locks) {
    locks = new Map();
    tables.set(name, locks);
  }
  const table = locks;
  return async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = table.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    table.set(key, current);
    try {
      return await current;
    } finally {
      if (table.get(key) === current) table.delete(key);
    }
  };
}
