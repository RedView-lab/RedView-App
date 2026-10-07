// ============================================
// Photo mode — times of day
// ============================================

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

export function parseClockMinutes(time: string, fallback = 12 * 60): number {
  const match = HHMM_RE.exec(time.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

export function formatClockMinutes(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Moments of the day the panel's chips jump to, from the sunrise and sunset
 * of the date (`--:--` in polar day or night: usual times instead).
 */
export function photoTimePresets(sunriseTime: string, sunsetTime: string): Array<{ label: string; time: string }> {
  const rise = HHMM_RE.test(sunriseTime) ? parseClockMinutes(sunriseTime) : 6 * 60 + 30;
  const set = HHMM_RE.test(sunsetTime) ? parseClockMinutes(sunsetTime) : 20 * 60 + 30;
  return [
    { label: 'Aube', time: formatClockMinutes(rise + 12) },
    { label: 'Heure dorée', time: formatClockMinutes(set - 50) },
    { label: 'Midi', time: formatClockMinutes((rise + set) / 2) },
    { label: 'Coucher', time: formatClockMinutes(set - 8) },
  ];
}

/** Default time of the photo mode: the evening golden hour. */
export function defaultPhotoTime(sunsetTime: string): string {
  return photoTimePresets('--:--', sunsetTime)[1]!.time;
}
