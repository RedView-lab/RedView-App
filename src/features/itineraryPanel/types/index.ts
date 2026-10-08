/**
 * Types du panneau d'itinéraire du dock de gauche (nœuds Figma 1539:19209 / 1539:19715).
 *
 * Le panneau héberge un projet éditable avec 1..n itinéraires. Chaque itinéraire
 * a quatre modes d'édition (Traçage, Rythme, POI, Nutrition) et une timeline
 * partagée (Feuille de route) en bas.
 */

export type { SportDiscipline } from '@/shared/lib/discipline';
export * from './analysis';
export * from './routing';
export * from './poi';
export * from './rhythm';
export * from './timeline';
export * from './itinerary';
export * from './project';
export * from './comments';
export * from './panelProps';
