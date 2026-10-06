/**
 * Présence en direct d'un projet partagé, comme Figma : curseurs des autres
 * éditeurs sur la carte 3D, suivre la vue d'un éditeur (clic sur sa pastille
 * dans l'en-tête), présenter sa vue (Spotlight), survol du graphique partagé.
 * Ce qui bouge (caméra, curseurs) passe par le canal `motion` de la
 * co-édition (features/collab), avec pertes, rejoué en différé et interpolé ;
 * rien n'est écrit dans le document.
 *
 *  - lib/ : lecture en différé (playout), cadrage contain du suivi, chaîne de
 *    suivi, survol local du graphique (fonctions pures, testées) ;
 *  - engine/ : session (hors React), émetteur, flux reçus, suivi de caméra,
 *    calque des curseurs ;
 *  - components/ : cadre et bandeau du suivi, survol des autres sur le
 *    graphique, pont avec le projet (itinéraire actif).
 */
export { LivePresenceContext, useLivePresenceOptional } from './context';
export type { FollowState, LivePeer, LivePresenceValue } from './context';
export { useLivePresence } from './hooks/useLivePresence';
export { FollowingFrame } from './components/FollowingFrame';
export { LivePresenceBridge } from './components/LivePresenceBridge';
