import ExcelJS from 'exceljs';

import type { PredictionResult } from '@/features/fitPredictor/types';
import type { Itinerary } from '@/features/itineraryPanel/types';

import { SUMMARY_SHEET_NAME } from './constants';
import { formatDistanceKm, formatDuration, formatInteger, formatKmh, formatMinutesAsDuration, formatPercent } from './format';
import {
  formatGapSummary,
  summarizeServiceWindows,
} from './checkpoints';
import { buildScheduleStartLabel } from './schedule';
import { addParamRow, addSummarySection } from './sheetShared';
import type { ScheduledCheckpoint } from './types';

export function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  itinerary: Itinerary,
  schedule: ScheduledCheckpoint[],
  prediction: PredictionResult | null,
): void {
  const sheet = workbook.addWorksheet(SUMMARY_SHEET_NAME);
  sheet.columns = [{ width: 28 }, { width: 24 }, { width: 28 }];

  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itinéraire';
  const totalDistanceM = schedule[schedule.length - 1]?.distanceM ?? 0;
  const totalStopMinutes = schedule.reduce((sum, checkpoint) => sum + checkpoint.stopMinutes, 0);
  const startLabel = buildScheduleStartLabel(itinerary);
  const finishLabel = schedule[schedule.length - 1]?.departureLabel || schedule[schedule.length - 1]?.arrivalLabel || '--';
  const waterSummary = summarizeServiceWindows(schedule, 'water');
  const foodSummary = summarizeServiceWindows(schedule, 'food');
  const sleepSummary = summarizeServiceWindows(schedule, 'sleep');
  const mechanicSummary = summarizeServiceWindows(schedule, 'mechanic');

  let rowNumber = 1;
  rowNumber = addSummarySection(sheet, rowNumber, 'Parcours');
  addParamRow(sheet, rowNumber++, 'Nom', routeName);
  addParamRow(sheet, rowNumber++, 'Distance totale', `${formatDistanceKm(totalDistanceM)} km`);
  addParamRow(sheet, rowNumber++, 'Dénivelé positif', `${formatInteger(itinerary.metrics?.ascentM ?? prediction?.elevation_gain_m)} m`);
  addParamRow(sheet, rowNumber++, 'Dénivelé négatif', `${formatInteger(itinerary.metrics?.descentM ?? prediction?.elevation_loss_m)} m`);
  addParamRow(sheet, rowNumber++, 'Part tarmac', formatPercent(itinerary.metrics?.tarmacPercent));
  addParamRow(sheet, rowNumber++, 'Part off-road', formatPercent(itinerary.metrics?.offroadPercent));
  addParamRow(sheet, rowNumber++, 'Points roadbook', schedule.length);
  addParamRow(sheet, rowNumber++, 'Feuilles exportées', 'Paramètres, Roadbook, Ravito, Timeline, Analyse, Segments, Trace');
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Timing ultra');
  addParamRow(sheet, rowNumber++, 'Départ', startLabel);
  addParamRow(sheet, rowNumber++, 'Arrivée estimée', finishLabel);
  addParamRow(sheet, rowNumber++, 'Temps roulant FIT', formatDuration(prediction?.riding_time_s ?? null));
  addParamRow(sheet, rowNumber++, 'Temps pause FIT', formatDuration(prediction?.stop_time_s ?? null));
  addParamRow(sheet, rowNumber++, 'Pauses planifiées export', formatMinutesAsDuration(totalStopMinutes));
  addParamRow(sheet, rowNumber++, 'Temps total FIT', formatDuration(prediction?.total_time_s ?? null));
  addParamRow(sheet, rowNumber++, 'Vit. moyenne FIT', formatKmh(prediction?.avg_speed_kmh ?? null));
  addParamRow(sheet, rowNumber++, 'Incertitude haute', formatDuration(prediction?.total_time_high_s ?? null));
  addParamRow(sheet, rowNumber++, 'Incertitude basse', formatDuration(prediction?.total_time_low_s ?? null));
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Ravito et sommeil');
  addParamRow(sheet, rowNumber++, 'Points eau', waterSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap eau', formatGapSummary(waterSummary));
  addParamRow(sheet, rowNumber++, 'Points food', foodSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap food', formatGapSummary(foodSummary));
  addParamRow(sheet, rowNumber++, 'Points sommeil', sleepSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap sommeil', formatGapSummary(sleepSummary));
  addParamRow(sheet, rowNumber++, 'Points méca', mechanicSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap méca', formatGapSummary(mechanicSummary));
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Réglages pris en compte');
  addParamRow(sheet, rowNumber++, 'Date de départ', itinerary.rhythm.startDate ?? '--');
  addParamRow(sheet, rowNumber++, 'Heure de départ', itinerary.rhythm.startTime ?? '--');
  addParamRow(sheet, rowNumber++, 'Pauses POI favoris', itinerary.rhythm.pauseAtFavoritePois ? 'Oui' : 'Non');
  addParamRow(sheet, rowNumber++, 'Pauses intervalle', itinerary.rhythm.pauseEveryIntervalEnabled ? 'Oui' : 'Non');
  addParamRow(sheet, rowNumber++, 'Lignes intervalle', itinerary.rhythm.pauseIntervals.length);
  addParamRow(sheet, rowNumber++, 'Export généré le', new Date().toLocaleString('fr-FR'));
}