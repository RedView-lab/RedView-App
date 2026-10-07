import type { Duplex } from 'node:stream';

/**
 * Écritures regroupées par tour de boucle d'événements : le premier envoi
 * vers une connexion pendant un tour bouchonne son socket TCP (`cork`), le
 * débouchage a lieu en fin de tour (`setImmediate`, après toutes les lectures
 * de la phase « poll »). Les trames WebSocket restent distinctes (aucun
 * changement de protocole) mais partent en un seul `writev` : sous charge, un
 * appel système par trame et par destinataire était le premier poste du
 * serveur (`writev`, 22 % du temps à 50 salles, `bench:collab-load`). Au
 * repos, un seul message par tour : rien n'est retardé au-delà du tour en
 * cours.
 *
 * `cork` est compté par Node : le `cork`/`uncork` que `ws` fait autour de
 * chaque trame s'imbrique dans le nôtre sans le vider.
 */
export interface WriteCoalescer {
  /** À appeler juste avant d'écrire sur `socket`. */
  hold(socket: Duplex): void;
}

export function createWriteCoalescer(schedule: (flush: () => void) => void = setImmediate): WriteCoalescer {
  const corked = new Set<Duplex>();
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    for (const socket of corked) socket.uncork();
    corked.clear();
  }

  return {
    hold(socket) {
      if (corked.has(socket) || socket.destroyed) return;
      socket.cork();
      corked.add(socket);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
  };
}
