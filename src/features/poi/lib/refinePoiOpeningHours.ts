const DAY_NAME_TO_INDEX: Record<string, number> = {
  mo: 0,
  tu: 1,
  we: 2,
  th: 3,
  fr: 4,
  sa: 5,
  su: 6,
};

function parseTimeToMinutes(timeStr: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export type OpenStatus = 'open' | 'closed' | 'unknown';

export function evaluateOpeningHours(
  openingHoursStr: string | undefined,
  arrivalTimeMs: number | null,
  timezoneOffsetMin: number,
  toleranceMin = 30,
): OpenStatus {
  if (!openingHoursStr || arrivalTimeMs == null) return 'unknown';

  const raw = openingHoursStr.trim().toLowerCase();
  if (raw === '24/7') return 'open';
  if (raw === 'off') return 'closed';

  const arrivalDate = new Date(arrivalTimeMs + timezoneOffsetMin * 60 * 1000);
  const dayIndex = (arrivalDate.getUTCDay() + 6) % 7;
  const arrivalMinutes = arrivalDate.getUTCHours() * 60 + arrivalDate.getUTCMinutes();

  const rules = raw.split(';').map((s) => s.trim()).filter(Boolean);
  let matchedDay = false;
  let isOpenNow = false;

  for (const rule of rules) {
    const spaceIdx = rule.indexOf(' ');
    if (spaceIdx === -1) continue;

    const daysPart = rule.slice(0, spaceIdx).trim();
    const timesPart = rule.slice(spaceIdx + 1).trim();

    if (daysPart === 'off') continue;

    let dayMatches = false;
    if (daysPart === '24/7' || daysPart === 'ph' || daysPart === 'sh') {
      continue;
    }

    const dayTokens = daysPart.split(',').map((s) => s.trim());
    for (const token of dayTokens) {
      if (token.includes('-')) {
        const [d1, d2] = token.split('-').map((s) => s.trim());
        const i1 = DAY_NAME_TO_INDEX[d1!];
        const i2 = DAY_NAME_TO_INDEX[d2!];
        if (i1 != null && i2 != null) {
          if (i1 <= i2) {
            if (dayIndex >= i1 && dayIndex <= i2) dayMatches = true;
          } else {
            if (dayIndex >= i1 || dayIndex <= i2) dayMatches = true;
          }
        }
      } else {
        const i = DAY_NAME_TO_INDEX[token];
        if (i === dayIndex) dayMatches = true;
      }
    }

    if (!dayMatches) continue;
    matchedDay = true;

    if (timesPart === 'off') {
      return 'closed';
    }

    const timeRanges = timesPart.split(',').map((s) => s.trim());
    for (const range of timeRanges) {
      const parts = range.split('-').map((s) => s.trim());
      if (parts.length !== 2) continue;
      const startMin = parseTimeToMinutes(parts[0]!);
      const endMin = parseTimeToMinutes(parts[1]!);
      if (startMin == null || endMin == null) continue;

      const effectiveStart = startMin - toleranceMin;
      const effectiveEnd = endMin + toleranceMin;

      if (effectiveStart <= effectiveEnd) {
        if (arrivalMinutes >= effectiveStart && arrivalMinutes <= effectiveEnd) {
          isOpenNow = true;
        }
      } else {
        if (arrivalMinutes >= effectiveStart || arrivalMinutes <= effectiveEnd) {
          isOpenNow = true;
        }
      }
    }
  }

  if (!matchedDay) return 'unknown';
  return isOpenNow ? 'open' : 'closed';
}
