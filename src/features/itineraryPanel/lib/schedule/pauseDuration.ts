export function formatPauseDurationInput(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0';
  return String(Math.max(0, Math.round(min)));
}

export function parsePauseDurationInput(raw: string, prev: number): number {
  const text = raw.trim().toLowerCase();
  if (!text || text === '-') return prev;

  const hoursMatch = text.match(/^(\d+)\s*h\s*(\d{0,2})$/);
  if (hoursMatch) {
    const hours = Number.parseInt(hoursMatch[1], 10);
    const minutes = hoursMatch[2] ? Number.parseInt(hoursMatch[2], 10) : 0;
    return Math.max(0, hours * 60 + minutes);
  }

  const minutesMatch = text.match(/^(\d+)\s*(min|m)?$/);
  if (minutesMatch) {
    return Math.max(0, Number.parseInt(minutesMatch[1], 10));
  }

  return prev;
}