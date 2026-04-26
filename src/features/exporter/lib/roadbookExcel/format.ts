import ExcelJS from 'exceljs';

export function sanitizeFileName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase() || 'itinerary';
}

export function buildColumnHeaders(columns: Partial<ExcelJS.Column>[]): string[] {
  return columns.map((column) => {
    const header = column.header;
    if (Array.isArray(header)) return String(header[0] ?? '');
    return String(header ?? '');
  });
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (!Number.isFinite(totalSeconds)) return '--';
  const safeSeconds = Math.max(0, Math.round(totalSeconds as number));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function formatMinutesAsDuration(totalMinutes: number | null | undefined): string {
  if (!Number.isFinite(totalMinutes)) return '--';
  return formatDuration((totalMinutes as number) * 60);
}

export function formatInteger(value: number | null | undefined): string {
  return Number.isFinite(value) ? String(Math.round(value as number)) : '--';
}

export function formatDistanceKm(distanceM: number | null | undefined): string {
  return Number.isFinite(distanceM) ? ((distanceM as number) / 1000).toFixed(1) : '--';
}

export function formatNumber(value: number | null | undefined, digits: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : '--';
}

export function formatSignedNumber(value: number | null | undefined, digits: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : '--';
}

export function formatPercent(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${Math.round(value as number)} %` : '--';
}

export function formatKmh(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${(value as number).toFixed(1)} km/h` : '--';
}

export function formatScheduleDate(
  date: Date | null,
  reference: Date | null,
  hasRealDate: boolean,
): string {
  if (!date) return '--';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  if (hasRealDate) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month} ${hours}:${minutes}`;
  }
  if (!reference) return `${hours}:${minutes}`;
  const dayOffset = Math.floor((date.getTime() - reference.getTime()) / 86_400_000);
  return `J+${dayOffset} ${hours}:${minutes}`;
}

export function parseStartDateTime(dateIso: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateIso.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;
  const year = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const day = Number.parseInt(dateMatch[3], 10);
  const hours = Number.parseInt(timeMatch[1], 10);
  const minutes = Number.parseInt(timeMatch[2], 10);
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseTimeReference(time: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return new Date(2000, 0, 1, hours, minutes, 0, 0);
}