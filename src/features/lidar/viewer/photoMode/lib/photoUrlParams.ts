// ============================================
// Photo mode — URL overrides (benches and shared views)
// ============================================
//
// `?photo=1` opens the viewer with the photo mode on; `photoDate`,
// `photoTime`, `clouds`, `coverage`, `cloudBase`, `haze` and `ev` override
// the remembered settings. Every value is validated: an invalid one is
// ignored, never cast.

import { CLOUD_PRESETS } from './cloudPresets';
import type { CloudPresetId, PhotoModeState } from '../types';

export type PhotoUrlOverrides = Partial<PhotoModeState>;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function numberIn(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

export function parsePhotoUrlOverrides(params: URLSearchParams): PhotoUrlOverrides {
  const out: PhotoUrlOverrides = {};
  if (params.get('photo') === '1') out.enabled = true;
  const date = params.get('photoDate');
  if (date && DATE_RE.test(date)) out.date = date;
  const time = params.get('photoTime');
  if (time && TIME_RE.test(time)) out.time = time;
  const clouds = params.get('clouds');
  if (clouds && Object.prototype.hasOwnProperty.call(CLOUD_PRESETS, clouds)) out.clouds = clouds as CloudPresetId;
  const coverage = numberIn(params.get('coverage'), 0, 100);
  if (coverage !== undefined) out.coverage = coverage;
  const base = numberIn(params.get('cloudBase'), -10000, 10000);
  if (base !== undefined) out.cloudBaseOffsetM = base;
  const haze = numberIn(params.get('haze'), 0, 100);
  if (haze !== undefined) out.haze = haze;
  const ev = numberIn(params.get('ev'), -3, 3);
  if (ev !== undefined) out.exposureEv = ev;
  return out;
}
