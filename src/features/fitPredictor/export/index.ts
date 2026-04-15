import type { PredictionResult } from '../types';
import { buildCheckpoints } from './checkpoints';
import { downloadExcel } from './download';
import { buildWorkbook } from './excelBuilder';
import type { ExportConfig } from './types';

const DEFAULT_CONFIG: ExportConfig = {
  intervalKm: 20,
};

/**
 * Export a prediction result to a professionally formatted .xlsx file.
 *
 * Generates checkpoints every `intervalKm` (default 20 km) with cumulative
 * time, section time, speed, elevation, gradient, and power data.
 */
export async function exportPredictionToExcel(
  result: PredictionResult,
  config?: Partial<ExportConfig>,
): Promise<void> {
  const merged: ExportConfig = { ...DEFAULT_CONFIG, ...config };
  const checkpoints = buildCheckpoints(result.points, merged.intervalKm);
  const workbook = buildWorkbook(result, checkpoints, merged);

  const date = new Date().toISOString().slice(0, 10);
  const routePart = merged.routeName
    ? `_${merged.routeName.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : '';
  const filename = `RedView_Prediction${routePart}_${date}.xlsx`;

  await downloadExcel(workbook, filename);
}

export type { CheckpointRow, ExportConfig } from './types';
