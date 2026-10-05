/**
 * Co-édition d'un projet : modèle de fusion du document partagé, codage Yjs,
 * annuler par utilisateur, désignation de qui calcule les résultats dérivés.
 * Le ProjectStore n'en connaît que le contrat `ProjectCollabLink`
 * (itineraryPanel/context/ProjectStore/collab.ts).
 */
export { PROJECT_DOCUMENT_SPEC, ITINERARY_SPEC, DERIVED_INPUTS } from './schema';
export type { MergeSpec, DerivedKind } from './schema';
export { chunkRoutePoints, routeChunkBounds } from './routeChunks';
export { ProjectDocBinding } from './yjs/binding';
export type { InputChange } from './yjs/binding';
export { readDocument, writeDocument, rootMap } from './yjs/codec';
export { CollabComputeGate, DEFAULT_COMPUTE_GRACE_MS } from './computeGate';
export { createCollabSession, createCollabLink } from './session';
export type { CollabSession, CollabSessionOptions, CollabTransport, CollabTransportFactory } from './session';
export { broadcastChannelTransport } from './transports/broadcastChannel';
export { useCollabSession, isDevTabCollabEnabled } from './useCollabSession';
