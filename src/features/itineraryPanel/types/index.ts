/**
 * Types for the left-dock Itinerary Panel (Figma nodes 1539:19209 / 1539:19715).
 *
 * The panel hosts an editable project with 1..n itineraries. Each itinerary
 * has four editing modes (Traçage, Rythme, POI, Nutrition) and a shared
 * timeline (Feuille de route) at the bottom.
 */

export type { SportDiscipline } from '@/shared/lib/discipline';
export * from './analysis';
export * from './routing';
export * from './poi';
export * from './rhythm';
export * from './timeline';
export * from './itinerary';
export * from './project';
export * from './panelProps';
