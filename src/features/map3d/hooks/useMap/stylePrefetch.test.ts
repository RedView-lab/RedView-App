import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDVIEW_TOPO_DARK_STYLE_URL, applyBasemapTheme, getBaseStyleUrl } from '../../lib/basemapThemes';
import { prefetchedStyleCache, resolveStyleInput, THEMED_STYLE_RETRY_TIMEOUT_MS } from './stylePrefetch';

const baseStyle = () => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } }],
});

function respond(): Response {
  return new Response(JSON.stringify(baseStyle()), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('resolveStyleInput', () => {
  beforeEach(() => {
    prefetchedStyleCache.clear();
    vi.stubGlobal('window', globalThis);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => prefetchedStyleCache.clear());

  it('retries a RedView theme instead of showing its untouched base style', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockResolvedValueOnce(respond());
    vi.stubGlobal('fetch', fetchMock);
    const timeouts: number[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const input = await resolveStyleInput(REDVIEW_TOPO_DARK_STYLE_URL);

    expect(input).toEqual(applyBasemapTheme(REDVIEW_TOPO_DARK_STYLE_URL, baseStyle()));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of setTimeoutSpy.mock.calls) timeouts.push(call[1] ?? 0);
    expect(timeouts).toContain(THEMED_STYLE_RETRY_TIMEOUT_MS);
  });

  it('falls back to the base style URL only when the retry fails too', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(resolveStyleInput(REDVIEW_TOPO_DARK_STYLE_URL)).resolves.toBe(getBaseStyleUrl(REDVIEW_TOPO_DARK_STYLE_URL));
  });

  it('falls back at once for a plain Mapbox style (Mapbox loads the same look itself)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolveStyleInput('mapbox://styles/mapbox/outdoors-v12')).resolves.toBe('mapbox://styles/mapbox/outdoors-v12');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
