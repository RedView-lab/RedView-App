import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from 'y-protocols/awareness';

import type { CollabTransport } from '../session';
import { rootMap } from '../yjs/codec';

/**
 * Transport de développement : les onglets d'un même navigateur qui ouvrent
 * le même projet se synchronisent par `BroadcastChannel`, sans serveur. Sert
 * à éprouver la co-édition dans la vraie application (deux onglets) avant le
 * serveur temps réel, qui fournira un transport du même contrat.
 *
 * Protocole : à l'arrivée, `hello` (vecteur d'état) ; un pair qui a le
 * document répond `state` (ce qui manque). Ensuite chaque mise à jour Yjs et
 * chaque changement de présence sont diffusés.
 */

type Message =
  | { type: 'hello'; from: number; stateVector: Uint8Array }
  | { type: 'state'; to: number; update: Uint8Array }
  | { type: 'update'; update: Uint8Array }
  | { type: 'awareness'; update: Uint8Array };

export interface BroadcastChannelTransportOptions {
  /** Attente d'un pair qui a déjà le document (sinon le document enregistré est semé). */
  syncTimeoutMs?: number;
}

export function broadcastChannelTransport(
  channelName: string,
  { syncTimeoutMs = 400 }: BroadcastChannelTransportOptions = {},
) {
  return (ydoc: Y.Doc, awareness: Awareness): CollabTransport => {
    const channel = new BroadcastChannel(channelName);
    const origin = Object.freeze({ transport: channelName });
    const post = (message: Message) => channel.postMessage(message);
    let settle: (received: boolean) => void = () => undefined;
    const synced = new Promise<boolean>((resolve) => {
      let settled = false;
      settle = (received) => {
        if (settled) return;
        settled = true;
        resolve(received);
      };
    });
    const timeout = setTimeout(() => settle(false), syncTimeoutMs);

    const onUpdate = (update: Uint8Array, updateOrigin: unknown) => {
      if (updateOrigin !== origin) post({ type: 'update', update });
    };
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      awarenessOrigin: unknown,
    ) => {
      if (awarenessOrigin === origin) return;
      post({ type: 'awareness', update: encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]) });
    };

    channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      switch (message.type) {
        case 'hello':
          if (rootMap(ydoc).size > 0) {
            post({ type: 'state', to: message.from, update: Y.encodeStateAsUpdate(ydoc, message.stateVector) });
          }
          post({ type: 'awareness', update: encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()]) });
          break;
        case 'state':
          if (message.to !== awareness.clientID) break;
          Y.applyUpdate(ydoc, message.update, origin);
          settle(true);
          break;
        case 'update':
          Y.applyUpdate(ydoc, message.update, origin);
          break;
        case 'awareness':
          applyAwarenessUpdate(awareness, message.update, origin);
          break;
      }
    };
    ydoc.on('update', onUpdate);
    awareness.on('update', onAwareness);
    post({ type: 'hello', from: awareness.clientID, stateVector: Y.encodeStateVector(ydoc) });

    return {
      synced,
      destroy: () => {
        clearTimeout(timeout);
        settle(false);
        removeAwarenessStates(awareness, [awareness.clientID], 'destroy');
        post({ type: 'awareness', update: encodeAwarenessUpdate(awareness, [awareness.clientID]) });
        ydoc.off('update', onUpdate);
        awareness.off('update', onAwareness);
        channel.close();
      },
    };
  };
}
