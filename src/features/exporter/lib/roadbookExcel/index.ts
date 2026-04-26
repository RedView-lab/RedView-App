import ExcelJS from 'exceljs';

import { downloadExcel } from '@/features/fitPredictor/export/download';
import type { Itinerary } from '@/features/itineraryPanel/types';

import { collectIntervalPauseCheckpoints, collectRouteSamples, collectTimelineCheckpoints, compareCheckpointSeeds } from './checkpoints';
import { sanitizeFileName } from './format';
import { buildSchedule } from './schedule';
import {
  buildAnalysisSheet,
  buildParametersSheet,
  buildRoadbookSheet,
  buildRoutePointsSheet,
  buildSegmentsSheet,
  buildServicesSheet,
  buildSummarySheet,
  buildTimelineSheet,
} from './sheets';

export async function exportRoadbookExcel(
  itinerary: Itinerary,
): Promise<{ fileName: string }> {
  const workbook = buildRoadbookWorkbook(itinerary);
  const baseName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'itinerary';
  const fileName = `${sanitizeFileName(baseName)}-feuille-de-route.xlsx`;
  await downloadExcel(workbook, fileName);
  return { fileName };
}

export function buildRoadbookWorkbook(itinerary: Itinerary): ExcelJS.Workbook {
  const route = collectRouteSamples(itinerary);
  const prediction = itinerary.prediction ?? null;
  const manualCheckpoints = collectTimelineCheckpoints(itinerary, route);
  const intervalCheckpoints = collectIntervalPauseCheckpoints(itinerary, route, prediction);
  const checkpoints = [...manualCheckpoints, ...intervalCheckpoints].sort(compareCheckpointSeeds);
  const schedule = buildSchedule(itinerary, route, checkpoints, prediction);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RedView';
  workbook.created = new Date();
  workbook.subject = 'Feuille de route ultra-cyclisme';
  workbook.title = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Feuille de route';

  buildParametersSheet(workbook, itinerary, schedule, route, prediction);
  buildRoadbookSheet(workbook, itinerary, schedule);
  buildServicesSheet(workbook, schedule);
  buildTimelineSheet(workbook, itinerary, schedule);
  buildAnalysisSheet(workbook, prediction);
  buildSegmentsSheet(workbook, prediction);
  buildRoutePointsSheet(workbook, route);
  buildSummarySheet(workbook, itinerary, schedule, prediction);

  return workbook;
}