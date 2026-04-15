import ExcelJS from 'exceljs';
import type { PredictionResult } from '../types';
import type { CheckpointRow, ExportConfig } from './types';

/* ────────────── helpers ────────────── */

function formatHMS(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const DARK_BG = 'FF1A1A1A';
const ACCENT = 'FFE67E22';
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const HEADER_FILL = (color: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: color },
});
const ZEBRA_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF5F5F5' },
};
const FINISH_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFDFF0D8' },
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
};

/* ──────── Sheet 1: Temps de passage ──────── */

function buildCheckpointSheet(
  wb: ExcelJS.Workbook,
  checkpoints: CheckpointRow[],
  isFinishRow: (idx: number) => boolean,
) {
  const ws = wb.addWorksheet('Temps de passage');

  // Columns
  ws.columns = [
    { header: 'KM', key: 'km', width: 8 },
    { header: 'Distance (km)', key: 'dist', width: 14 },
    { header: 'Temps roulé', key: 'cumTime', width: 15 },
    { header: 'Temps section', key: 'segTime', width: 15 },
    { header: 'Vit. moy (km/h)', key: 'speed', width: 16 },
    { header: 'D+ (m)', key: 'gain', width: 10 },
    { header: 'D- (m)', key: 'loss', width: 10 },
    { header: 'Altitude (m)', key: 'elev', width: 13 },
    { header: 'Pente moy (%)', key: 'grade', width: 14 },
    { header: 'Puissance moy (W)', key: 'power', width: 18 },
  ];

  // Header styling
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 24;

  // Data rows
  checkpoints.forEach((cp, idx) => {
    const row = ws.addRow({
      km: cp.km,
      dist: Math.round(cp.distanceCumM / 100) / 10, // 1 decimal
      cumTime: formatHMS(cp.elapsedTimeS),
      segTime: formatHMS(cp.segmentTimeS),
      speed: Math.round(cp.avgSpeedKmh * 10) / 10,
      gain: cp.elevGainM,
      loss: cp.elevLossM,
      elev: cp.elevationM,
      grade: Math.round(cp.avgGradientPct * 10) / 10,
      power: Math.round(cp.avgPowerW),
    });

    row.eachCell((cell) => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = THIN_BORDER;
    });

    // Finish row highlight
    if (isFinishRow(idx)) {
      row.eachCell((cell) => {
        cell.fill = FINISH_FILL;
        cell.font = { bold: true };
      });
    } else if (idx % 2 === 1) {
      row.eachCell((cell) => {
        cell.fill = ZEBRA_FILL;
      });
    }
  });

  // Freeze header
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];
}

/* ──────── Sheet 2: Résumé ──────── */

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  result: PredictionResult,
  config: ExportConfig,
) {
  const ws = wb.addWorksheet('Résumé');
  ws.columns = [
    { width: 28 },
    { width: 30 },
  ];

  const addHeader = (text: string) => {
    const row = ws.addRow([text]);
    row.getCell(1).font = { ...HEADER_FONT, size: 13 };
    row.getCell(1).fill = HEADER_FILL(ACCENT);
    row.getCell(2).fill = HEADER_FILL(ACCENT);
    ws.mergeCells(row.number, 1, row.number, 2);
    row.height = 28;
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
  };

  const addPair = (label: string, value: string | number) => {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: 'middle' };
    row.getCell(2).alignment = { vertical: 'middle' };
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });
  };

  // Route info
  addHeader('  PARCOURS');
  if (config.routeName) addPair('Nom', config.routeName);
  addPair('Distance totale', `${(result.total_distance_m / 1000).toFixed(1)} km`);
  addPair('Dénivelé positif', `${Math.round(result.elevation_gain_m)} m`);
  addPair('Dénivelé négatif', `${Math.round(result.elevation_loss_m)} m`);
  ws.addRow([]);

  // Time info
  addHeader('  TEMPS ESTIMÉS');
  addPair('Temps roulé (sans pauses)', formatHMS(result.riding_time_s));
  addPair('Temps total (avec pauses)', formatHMS(result.total_time_s));
  addPair('Temps de pause estimé', formatHMS(result.stop_time_s));
  addPair('Vitesse moyenne', `${result.avg_speed_kmh.toFixed(1)} km/h`);
  if (result.total_time_low_s != null && result.total_time_high_s != null) {
    addPair('Borne basse', formatHMS(result.total_time_low_s));
    addPair('Borne haute', formatHMS(result.total_time_high_s));
  }
  ws.addRow([]);

  // Rider profile
  addHeader('  PROFIL COUREUR');
  const rp = result.rider_profile;
  addPair('FTP', `${Math.round(rp.ftp_w)} W`);
  addPair('Poids coureur', `${rp.rider_weight_kg.toFixed(1)} kg`);
  addPair('Poids vélo + équip.', `${rp.bike_weight_kg.toFixed(1)} kg`);
  addPair('Poids total', `${rp.mass_kg.toFixed(1)} kg`);
  addPair('W/kg', rp.wkg.toFixed(2));
  addPair('CdA', rp.cda.toFixed(4));
  addPair('Crr', rp.crr.toFixed(4));
  addPair('Capteur de puissance', rp.has_power ? 'Oui' : 'Non');
  ws.addRow([]);

  // Export metadata
  addHeader('  EXPORT');
  addPair('Intervalle checkpoints', `${config.intervalKm} km`);
  addPair('Date export', new Date().toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }));
  addPair('Généré par', 'RedView — Prediction Engine');
}

/* ──────── Public API ──────── */

export function buildWorkbook(
  result: PredictionResult,
  checkpoints: CheckpointRow[],
  config: ExportConfig,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RedView';
  wb.created = new Date();

  const isFinishRow = (idx: number) => idx === checkpoints.length - 1;

  buildCheckpointSheet(wb, checkpoints, isFinishRow);
  buildSummarySheet(wb, result, config);

  return wb;
}
