import type { PredictionResult } from '@/features/fitPredictor';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { Itinerary } from '@/features/itineraryPanel';
import type { ItineraryVisualNode } from '@/features/itineraryPanel/lineage/itineraryLineage';

import type { SummaryTreeNode } from './types';

const PLACEHOLDER = '--';

export const HEADER_CELLS = [
  'Distance',
  'Durée',
  'Dénivelé /',
  'Dénivelé -',
  'Pente moyenne',
  'Tarmac',
  'Off-road',
  '7%',
  '7%',
  '7%',
];

function formatDistance(km: number | undefined): string {
  if (km == null || !Number.isFinite(km)) return PLACEHOLDER;
  return km.toFixed(2);
}

function formatDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return PLACEHOLDER;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatAscent(meters: number | undefined): string {
  if (meters == null || !Number.isFinite(meters)) return PLACEHOLDER;
  return `+${Math.round(meters)}`;
}

function formatDescent(meters: number | undefined): string {
  if (meters == null || !Number.isFinite(meters)) return PLACEHOLDER;
  return `-${Math.round(meters)}`;
}

function formatPercent(percent: number | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return PLACEHOLDER;
  return `${Math.round(percent)}%`;
}

function itineraryDistanceKm(itinerary: Itinerary): number | undefined {
  if (itinerary.metrics?.distanceKm != null) return itinerary.metrics.distanceKm;
  const endRow = itinerary.timeline.find((row) => row.kind === 'end');
  return endRow?.distanceKm ?? undefined;
}

export function buildValues(itinerary: Itinerary, prediction?: PredictionResult | null): string[] {
  const metrics = itinerary.metrics ?? {};
  const durationSec = prediction
    ? (buildPauseAwareSchedule(itinerary, prediction)?.totalDurationSeconds ?? metrics.durationSec)
    : metrics.durationSec;
  return [
    formatDistance(itineraryDistanceKm(itinerary)),
    formatDuration(durationSec),
    formatAscent(metrics.ascentM),
    formatDescent(metrics.descentM),
    formatPercent(metrics.avgSlopePercent),
    formatPercent(metrics.tarmacPercent),
    formatPercent(metrics.offroadPercent),
    PLACEHOLDER,
    PLACEHOLDER,
    PLACEHOLDER,
  ];
}

export const EMPTY_VALUES: string[] = HEADER_CELLS.map(() => PLACEHOLDER);

export function buildSummaryTree(visualNodes: ItineraryVisualNode[]): SummaryTreeNode[] {
  if (visualNodes.length === 0) return [];

  const branchById = new Map<string, SummaryTreeNode>();
  visualNodes.forEach((node) => {
    branchById.set(node.itinerary.id, { node, children: [] });
  });

  const roots: SummaryTreeNode[] = [];
  visualNodes.forEach((node) => {
    const branch = branchById.get(node.itinerary.id);
    if (!branch) return;
    const parentBranch = node.parentItineraryId ? branchById.get(node.parentItineraryId) : null;
    if (parentBranch) parentBranch.children.push(branch);
    else roots.push(branch);
  });

  return roots;
}