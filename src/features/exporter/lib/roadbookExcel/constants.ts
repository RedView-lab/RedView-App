import ExcelJS from 'exceljs';

export const SHEET_NAME = 'Feuille de route';
export const SERVICES_SHEET_NAME = 'Ravito';
export const SUMMARY_SHEET_NAME = 'Résumé ultra';
export const PARAMETERS_SHEET_NAME = 'Parametres';
export const TIMELINE_SHEET_NAME = 'Timeline brute';
export const ANALYSIS_SHEET_NAME = 'Analyse';
export const SEGMENTS_SHEET_NAME = 'Segments';
export const ROUTE_POINTS_SHEET_NAME = 'Trace brute';

export const DARK_BG = 'FF111111';
export const MID_BG = 'FF262626';
export const ACCENT = 'FFB44D12';

export const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
  size: 11,
};

export const SUBHEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FF111111' },
  size: 11,
};

export const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
};

export const ZEBRA_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF7F7F7' },
};

export const SUMMARY_LABEL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF2F2F2' },
};

export const EDITABLE_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE2F0D9' },
};

export function fill(argb: string): ExcelJS.Fill {
  return {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb },
  };
}