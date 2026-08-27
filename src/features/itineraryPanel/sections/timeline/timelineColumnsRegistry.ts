import type { TimelineColumnDef } from './TimelineColumnsTypes';
import {
  avgPowerBetween,
  DASH,
  fmtClock,
  fmtDistanceKm,
  fmtElevation,
  fmtPower,
  fmtSeconds,
  fmtSpeed,
  gainLossBetween,
} from './timelineColumnsFormatters';

function avgSpeedFromElapsed(
  distanceM: number | null,
  elapsedS: number | null,
): number | null {
  if (distanceM == null || elapsedS == null || elapsedS <= 0 || distanceM <= 0) return null;
  return distanceM / 1000 / (elapsedS / 3600);
}

function avgSpeedBetweenDistanceAndTime(
  fromM: number | null,
  toM: number | null,
  fromS: number | null,
  toS: number | null,
): number | null {
  if (fromM == null || toM == null || fromS == null || toS == null) return null;
  const dM = toM - fromM;
  const dS = toS - fromS;
  if (dM <= 0 || dS <= 0) return null;
  return dM / 1000 / (dS / 3600);
}

export const TIMELINE_COLUMNS: TimelineColumnDef[] = [
  {
    id: 'typePicto',
    label: 'Type (picto)',
    shortLabel: 'Type',
    defaultOn: true,
    align: 'center',
    minWidth: 64,
    custom: true,
    getCell: (ctx) => ({ display: '', sortKey: ctx.item.kind }),
  },
  {
    id: 'typeText',
    label: 'Type (texte)',
    shortLabel: 'Type',
    defaultOn: true,
    align: 'left',
    minWidth: 80,
    custom: true,
    getCell: (ctx) => ({ display: '', sortKey: ctx.item.kind }),
  },
  {
    id: 'name',
    label: 'Nom',
    defaultOn: true,
    align: 'left',
    minWidth: 160,
    pinned: true,
    custom: true,
    getCell: (ctx) => ({ display: ctx.item.label, sortKey: ctx.item.label.toLowerCase() }),
  },
  {
    id: 'distance',
    label: 'Distance',
    defaultOn: true,
    align: 'right',
    minWidth: 80,
    pinned: true,
    getCell: (ctx) => ({
      display: fmtDistanceKm(ctx.item.distanceKm),
      sortKey: ctx.item.distanceKm ?? null,
    }),
  },
  {
    id: 'clockTime',
    label: 'Heure de passage',
    shortLabel: 'Heure',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: (ctx) => ({
      display: fmtClock(ctx.elapsedS, ctx.reference),
      sortKey: ctx.elapsedS,
    }),
  },
  {
    id: 'elapsedTime',
    label: 'Temps',
    defaultOn: true,
    align: 'right',
    minWidth: 72,
    getCell: (ctx) => ({
      display: fmtSeconds(ctx.elapsedS),
      sortKey: ctx.elapsedS,
    }),
  },
  {
    id: 'segmentTimePrev',
    label: 'Temps depuis élément précédent',
    shortLabel: 'Δ prev',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const d = ctx.elapsedS != null && ctx.elapsedPrevS != null
        ? ctx.elapsedS - ctx.elapsedPrevS
        : null;
      return { display: fmtSeconds(d), sortKey: d };
    },
  },
  {
    id: 'segmentTimeNext',
    label: 'Temps jusqu’au prochain élément',
    shortLabel: 'Δ next',
    defaultOn: true,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const d = ctx.elapsedS != null && ctx.elapsedNextS != null
        ? ctx.elapsedNextS - ctx.elapsedS
        : null;
      return { display: fmtSeconds(d), sortKey: d };
    },
  },
  {
    id: 'avgSpeedFromStart',
    label: 'Vitesse moyenne depuis le début',
    shortLabel: 'V̄ depuis départ',
    defaultOn: true,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const v = avgSpeedFromElapsed(ctx.distanceM, ctx.elapsedS);
      return { display: fmtSpeed(v), sortKey: v };
    },
  },
  {
    id: 'avgSpeedSincePrev',
    label: 'Vitesse moyenne depuis l’élément précédent',
    shortLabel: 'V̄ depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const v = avgSpeedBetweenDistanceAndTime(ctx.prevDistanceM, ctx.distanceM, ctx.elapsedPrevS, ctx.elapsedS);
      return { display: fmtSpeed(v), sortKey: v };
    },
  },
  {
    id: 'avgSpeedToNext',
    label: 'Vitesse moyenne jusqu’au prochain élément',
    shortLabel: 'V̄ → next',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const v = avgSpeedBetweenDistanceAndTime(ctx.distanceM, ctx.nextDistanceM, ctx.elapsedS, ctx.elapsedNextS);
      return { display: fmtSpeed(v), sortKey: v };
    },
  },
  {
    id: 'avgPowerFromStart',
    label: 'Puissance moyenne (depuis le début)',
    shortLabel: 'P̄ depuis départ',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const p = avgPowerBetween(ctx.prediction, 0, ctx.distanceM);
      return { display: fmtPower(p), sortKey: p };
    },
  },
  {
    id: 'avgPowerSincePrev',
    label: 'Puissance moyenne (depuis l’élément précédent)',
    shortLabel: 'P̄ depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const p = avgPowerBetween(ctx.prediction, ctx.prevDistanceM, ctx.distanceM);
      return { display: fmtPower(p), sortKey: p };
    },
  },
  {
    id: 'avgPowerToNext',
    label: 'Puissance moyenne (jusqu’au prochain élément)',
    shortLabel: 'P̄ → next',
    defaultOn: false,
    align: 'right',
    minWidth: 88,
    getCell: (ctx) => {
      const p = avgPowerBetween(ctx.prediction, ctx.distanceM, ctx.nextDistanceM);
      return { display: fmtPower(p), sortKey: p };
    },
  },
  {
    id: 'gainFromStart',
    label: 'Dénivelé + (depuis le début)',
    shortLabel: 'D+ depuis départ',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const g = gainLossBetween(ctx.prediction, 0, ctx.distanceM)?.gain ?? null;
      return { display: fmtElevation(g), sortKey: g };
    },
  },
  {
    id: 'gainSincePrev',
    label: 'Dénivelé + (depuis l’élément précédent)',
    shortLabel: 'D+ depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const g = gainLossBetween(ctx.prediction, ctx.prevDistanceM, ctx.distanceM)?.gain ?? null;
      return { display: fmtElevation(g), sortKey: g };
    },
  },
  {
    id: 'gainToNext',
    label: 'Dénivelé + (jusqu’au prochain élément)',
    shortLabel: 'D+ → next',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const g = gainLossBetween(ctx.prediction, ctx.distanceM, ctx.nextDistanceM)?.gain ?? null;
      return { display: fmtElevation(g), sortKey: g };
    },
  },
  {
    id: 'lossFromStart',
    label: 'Dénivelé - (depuis le début)',
    shortLabel: 'D- depuis départ',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const l = gainLossBetween(ctx.prediction, 0, ctx.distanceM)?.loss ?? null;
      return { display: fmtElevation(l), sortKey: l };
    },
  },
  {
    id: 'lossSincePrev',
    label: 'Dénivelé - (depuis l’élément précédent)',
    shortLabel: 'D- depuis prev',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const l = gainLossBetween(ctx.prediction, ctx.prevDistanceM, ctx.distanceM)?.loss ?? null;
      return { display: fmtElevation(l), sortKey: l };
    },
  },
  {
    id: 'lossToNext',
    label: 'Dénivelé - (jusqu’au prochain élément)',
    shortLabel: 'D- → next',
    defaultOn: false,
    align: 'right',
    minWidth: 80,
    getCell: (ctx) => {
      const l = gainLossBetween(ctx.prediction, ctx.distanceM, ctx.nextDistanceM)?.loss ?? null;
      return { display: fmtElevation(l), sortKey: l };
    },
  },
  {
    id: 'altitude',
    label: 'Altitude',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: (ctx) => {
      const a = ctx.point?.elevation_m ?? null;
      return { display: fmtElevation(a), sortKey: a };
    },
  },
  {
    id: 'wind',
    label: 'Vent',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
  {
    id: 'temperature',
    label: 'Température',
    shortLabel: 'Temp.',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
  {
    id: 'rain',
    label: 'Pluie',
    defaultOn: false,
    align: 'right',
    minWidth: 64,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
  {
    id: 'cloudCover',
    label: 'Couverture nuageuse',
    shortLabel: 'Nuages',
    defaultOn: false,
    align: 'right',
    minWidth: 72,
    getCell: () => ({ display: DASH, sortKey: null }),
  },
];
