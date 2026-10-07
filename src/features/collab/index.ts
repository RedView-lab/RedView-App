/**
 * Co-édition d'un projet, modèle de Figma : serveur qui fait foi
 * (server/multiplayer), document à plat (objets + propriétés, dernier écrit
 * gagne par propriété, listes à index fractionnaires), annuler par
 * utilisateur, baux pour qui calcule les résultats dérivés. Le ProjectStore
 * n'en connaît que le contrat `ProjectCollabLink`
 * (itineraryPanel/context/ProjectStore/collab.ts).
 *
 *  - model/ : document ↔ objets, opérations, différence, inverse, validation ;
 *  - room/ : cœur d'une salle (ordre, baux, présence), sans réseau ;
 *  - client/ : synchro, annuler, porte des calculs, connexion WebSocket ;
 *  - sim/ : simulateur déterministe (tests, bench:collab).
 */
export { PROJECT_DOCUMENT_SPEC, ITINERARY_SPEC, DERIVED_INPUTS } from './schema';
export type { MergeSpec, DerivedKind } from './schema';
export { chunkRoutePoints, routeChunkBounds } from './routeChunks';
export { PROTOCOL_VERSION } from './protocol';
export type { ClientMessage, ServerMessage, PeerInfo, LeaseInfo, PresenceState } from './protocol';
export type { CollabState, CollabStatus } from './client/collabClient';
export { useCollabSession } from './hooks/useCollabSession';
export type { CollabSessionHandle } from './hooks/useCollabSession';
