import ExcelJS from 'exceljs';

import type { Itinerary } from '@/features/itineraryPanel/types';

import {
  ACCENT,
  DARK_BG,
  EDITABLE_FILL,
  HEADER_FONT,
  PARAMETERS_SHEET_NAME,
  SUBHEADER_FONT,
  SUMMARY_LABEL_FILL,
  THIN_BORDER,
  fill,
} from './constants';
import { parseStartDateTime, parseTimeReference } from './format';
import type { ScheduledCheckpoint } from './types';

export const START_CELL_REF = `'${PARAMETERS_SHEET_NAME}'!$B$4`;

export function addSummarySection(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  title: string,
): number {
  sheet.mergeCells(rowNumber, 1, rowNumber, 3);
  const row = sheet.getRow(rowNumber);
  const cell = row.getCell(1);
  cell.value = title;
  cell.font = { ...HEADER_FONT, size: 12 };
  cell.fill = fill(ACCENT);
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 22;
  return rowNumber + 1;
}

export function addParamRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  label: string,
  value: ExcelJS.CellValue,
  options?: { editable?: boolean; numFmt?: string },
): void {
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = label;
  row.getCell(2).value = value;
  row.getCell(1).font = SUBHEADER_FONT;
  row.getCell(1).fill = SUMMARY_LABEL_FILL;
  row.eachCell((cell) => {
    cell.border = THIN_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  if (options?.numFmt) {
    row.getCell(2).numFmt = options.numFmt;
  }
  if (options?.editable) {
    row.getCell(2).fill = EDITABLE_FILL;
  }
}

export function applyCheckpointRowStyle(
  row: ExcelJS.Row,
  checkpoint: ScheduledCheckpoint,
): void {
  let rowFill: ExcelJS.Fill | null = null;
  if (checkpoint.kind === 'start') rowFill = fill('FFE8F3E8');
  else if (checkpoint.kind === 'end') rowFill = fill('FFE9EDF7');
  else if (checkpoint.kind === 'pause' || checkpoint.kind === 'intervalPause') rowFill = fill('FFFDEFD5');
  else if (checkpoint.serviceFlags.sleep) rowFill = fill('FFEDE3FF');
  else if (checkpoint.serviceFlags.food) rowFill = fill('FFFDE9DD');
  else if (checkpoint.serviceFlags.water) rowFill = fill('FFE3F0FF');

  if (rowFill) {
    row.eachCell((cell) => {
      if (cell.address !== `L${row.number}`) {
        cell.fill = rowFill;
      }
    });
  }

  if (checkpoint.kind === 'start' || checkpoint.kind === 'end') {
    row.font = { bold: true };
  }
}

export function writeSimpleTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  headers: string[],
  rows: Array<Array<string | number | null>>,
  widths: number[],
  startColumn: 'A' | 'D' = 'A',
): void {
  const baseColumn = startColumn === 'A' ? 1 : 4;
  const headerRow = sheet.getRow(startRow);

  headers.forEach((header, index) => {
    const cell = headerRow.getCell(baseColumn + index);
    cell.value = header;
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
    sheet.getColumn(baseColumn + index).width = widths[index];
  });

  rows.forEach((values, rowOffset) => {
    const row = sheet.getRow(startRow + 1 + rowOffset);
    values.forEach((value, cellOffset) => {
      const cell = row.getCell(baseColumn + cellOffset);
      cell.value = value;
      cell.border = THIN_BORDER;
      cell.alignment = {
        horizontal: cellOffset === 0 ? 'left' : 'center',
        vertical: 'middle',
        wrapText: true,
      };
    });
  });
}

export function buildEditableStartValue(itinerary: Itinerary): Date | null {
  if (itinerary.rhythm.startDate && itinerary.rhythm.startTime) {
    return parseStartDateTime(itinerary.rhythm.startDate, itinerary.rhythm.startTime);
  }
  if (itinerary.rhythm.startTime) {
    return parseTimeReference(itinerary.rhythm.startTime);
  }
  return null;
}

export function secondsToExcelTime(totalSeconds: number | null | undefined): number | null {
  if (!Number.isFinite(totalSeconds)) return null;
  return (totalSeconds as number) / 86400;
}

export function nullableKm(distanceM: number | null): number | null {
  return Number.isFinite(distanceM) ? (distanceM as number) / 1000 : null;
}

export function yesNo(value: boolean): string {
  return value ? 'Oui' : 'Non';
}