/** Reference races offered for the running prediction (distance in metres). */
export const RACE_DISTANCE_OPTIONS = [
  { distanceM: 5000, label: '5 km' },
  { distanceM: 10000, label: '10 km' },
  { distanceM: 21097, label: 'Semi-marathon' },
  { distanceM: 42195, label: 'Marathon' },
] as const;

/**
 * Parse a race time typed as "45:30", "1:45:30", "1h45" or "45" (minutes).
 * Returns seconds, or null when the text is not a plausible race time.
 */
export function parseRaceTime(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;

  const hours = /^(\d{1,2})h(\d{0,2})$/.exec(text);
  if (hours) {
    const seconds = Number(hours[1]) * 3600 + Number(hours[2] || 0) * 60;
    return seconds > 0 ? seconds : null;
  }

  const parts = text.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const nums = parts.map(Number);
  let seconds: number;
  if (nums.length === 1) {
    seconds = nums[0] * 60;
  } else if (nums.length === 2) {
    if (nums[1] >= 60) return null;
    seconds = nums[0] * 60 + nums[1];
  } else {
    if (nums[1] >= 60 || nums[2] >= 60) return null;
    seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  return seconds >= 60 ? seconds : null;
}

/** "45:30" under an hour, "1:45:30" above. */
export function formatRaceTime(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
