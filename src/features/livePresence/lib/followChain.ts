/**
 * Qui suivre vraiment (comme tldraw) : suivre quelqu'un qui en suit un autre,
 * c'est suivre le bout de la chaîne (A suit B qui suit C → A voit C), sans
 * jamais boucler ; et parmi les onglets d'un même utilisateur, le plus
 * récemment actif.
 */

export interface FollowPeer {
  clientId: string;
  userId: string;
  /** Client que cet éditeur suit (présence `following`). */
  following?: string | null;
}

/**
 * Client dont la vue est à afficher pour suivre `clientId` (null : il n'est
 * plus là). Une boucle (il me suit, ou suit quelqu'un qui me suit) s'arrête
 * au dernier éditeur valide.
 */
export function resolveFollowTarget(clientId: string, peers: readonly FollowPeer[], selfClientId: string | null): string | null {
  const byClient = new Map(peers.map((peer) => [peer.clientId, peer]));
  if (!byClient.has(clientId) || clientId === selfClientId) return null;
  const visited = new Set<string>();
  if (selfClientId) visited.add(selfClientId);
  let current = clientId;
  for (;;) {
    visited.add(current);
    const next = byClient.get(current)?.following;
    if (!next || visited.has(next) || !byClient.has(next)) return current;
    current = next;
  }
}

/** Onglet d'un utilisateur à suivre : le plus récemment actif (pas celui-ci). */
export function pickClientOfUser(
  userId: string,
  peers: readonly FollowPeer[],
  selfClientId: string | null,
  lastActivity: (clientId: string) => number,
): string | null {
  let best: string | null = null;
  let bestActivity = Number.NEGATIVE_INFINITY;
  for (const peer of peers) {
    if (peer.userId !== userId || peer.clientId === selfClientId) continue;
    const activity = lastActivity(peer.clientId);
    if (best === null || activity > bestActivity) {
      best = peer.clientId;
      bestActivity = activity;
    }
  }
  return best;
}
