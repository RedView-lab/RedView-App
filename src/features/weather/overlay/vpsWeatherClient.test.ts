import { describe, expect, it } from 'vitest';

import { buildVpsTileUrl } from './vpsWeatherClient';

describe('buildVpsTileUrl', () => {
  it('versionne la tuile par le run de prévision (le VPS réécrit le même fichier à chaque run)', () => {
    expect(buildVpsTileUrl('temp', '2026-10-09T15:00:00Z', 'webp', '2026-10-09T06:10:00Z'))
      .toBe('/api/weather/tiles/temp_2026-10-09T15:00:00Z.webp?v=2026-10-09T06%3A10%3A00Z');
  });

  it('sans version connue, garde l’ancienne forme', () => {
    expect(buildVpsTileUrl('temp', '2026-10-09T15:00:00Z')).toBe('/api/weather/tiles/temp_2026-10-09T15:00:00Z.png');
  });
});
