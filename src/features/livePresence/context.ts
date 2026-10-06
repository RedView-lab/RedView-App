import { createContext, useContext } from 'react';

import type { MotionStore } from './engine/MotionStore';
import type { ChartPointResolver } from './engine/PeerCursorsOverlay';

/** Un autre éditeur présent, tel que l'interface le montre. */
export interface LivePeer {
  clientId: string;
  userId: string;
  name: string;
  /** Couleur de sa pastille (curseur, cadre du suivi). */
  color: string;
  /** Texte lisible sur cette couleur. */
  ink: string;
  /** Client qu'il suit. */
  following: string | null;
  /** Numéro de son Spotlight (null : il ne présente pas). */
  spotlight: number | null;
  activeItineraryId: string | null;
}

export interface FollowState {
  userId: string;
  /** Onglet suivi (celui cliqué ; la vue affichée est celle du bout de la chaîne : `followTarget`). */
  clientId: string;
  name: string;
  color: string;
  /** Suivi lancé par un Spotlight : il s'arrête quand la présentation s'arrête. */
  viaSpotlight: boolean;
}

export interface LivePresenceValue {
  selfClientId: string | null;
  selfUserId: string | null;
  /** Nom affiché de cet éditeur. */
  selfName: string | null;
  /** Les autres éditeurs (pas cet onglet). */
  peers: readonly LivePeer[];
  following: FollowState | null;
  /** Éditeur dont la vue est affichée (bout de la chaîne de suivi). */
  followTarget: LivePeer | null;
  /** Je présente ma vue (Spotlight). */
  presenting: boolean;
  /** Quelqu'un d'autre présente (le plus récent). */
  presenter: LivePeer | null;
  /** Éditeurs qui me suivent. */
  followers: readonly LivePeer[];
  store: MotionStore;
  followUser(userId: string, options?: { viaSpotlight?: boolean }): void;
  stopFollowing(): void;
  setPresenting(on: boolean): void;
  /** Itinéraire actif de cet éditeur (ceux qui le suivent passent dessus). */
  publishActiveItinerary(itineraryId: string | null): void;
  /** Point de la trace pour un survol du graphique (itinéraire, distance) : point de couleur sur la carte. */
  setChartPointResolver(resolver: ChartPointResolver): void;
}

export const LivePresenceContext = createContext<LivePresenceValue | null>(null);

/** Présence en direct du projet ouvert ; null hors session de co-édition. */
export function useLivePresenceOptional(): LivePresenceValue | null {
  return useContext(LivePresenceContext);
}
