import { describe, expect, it } from 'vitest';

import { pendingSourceCategory, pendingSourceIds, summarizePendingSources } from './loadingDiagnostics';

describe('loadingDiagnostics', () => {
  it('range chaque source de l’app dans une catégorie fermée', () => {
    expect(pendingSourceCategory('unified-dem')).toBe('dem');
    expect(pendingSourceCategory('aws-fast-dem')).toBe('dem');
    expect(pendingSourceCategory('ign-ortho')).toBe('satellite');
    expect(pendingSourceCategory('rv-vhr-ortho')).toBe('satellite');
    expect(pendingSourceCategory('rv-poi-gpu-source')).toBe('poi');
    expect(pendingSourceCategory('weather-overlay-source-rain-radar')).toBe('weather');
    expect(pendingSourceCategory('wind-terrain-overlay-source')).toBe('weather');
    expect(pendingSourceCategory('brouter-route-audit-source')).toBe('route');
    expect(pendingSourceCategory('slope-tiles')).toBe('slope');
    expect(pendingSourceCategory('rv-contour-lines-source')).toBe('slope');
    expect(pendingSourceCategory('lidar-selection-source')).toBe('lidar');
    expect(pendingSourceCategory('shadow-image')).toBe('sunlight');
    expect(pendingSourceCategory('composite')).toBe('basemap');
    expect(pendingSourceCategory('rv-comment-zones')).toBe('other');
  });

  it('résumé trié et sans doublon ; jamais un identifiant de source', () => {
    expect(summarizePendingSources(['rv-poi-gpu-source', 'unified-dem', 'aws-fast-dem'])).toBe('dem+poi');
    expect(summarizePendingSources(['route-itinerary-k3f9x2m7q1'])).toBe('route');
    expect(summarizePendingSources([])).toBe('none');
  });

  it('sources pas encore chargées, via l’API publique ; une carte sans style ne lève pas', () => {
    const map = {
      getStyle: () => ({ sources: { 'unified-dem': {}, composite: {}, 'rv-poi-gpu-source': {} } }),
      isSourceLoaded: (id: string) => id === 'composite',
    };
    expect(pendingSourceIds(map as never)).toEqual(['unified-dem', 'rv-poi-gpu-source']);
    const broken = {
      getStyle: () => {
        throw new Error('Style is not done loading');
      },
      isSourceLoaded: () => true,
    };
    expect(pendingSourceIds(broken as never)).toEqual([]);
  });
});
