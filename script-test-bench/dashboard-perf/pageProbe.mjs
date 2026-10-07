/**
 * Sonde injectée dans chaque document (`context.addInitScript`) :
 *   - `__rvPerf` : FCP, LCP, tâches longues et « long animation frames »
 *     (temps de blocage) depuis le début du document ;
 *   - `__rvFrames.start()/stop()` : horodatages rAF pendant un geste ;
 *   - `__rvMap()` : l'instance Mapbox du dashboard (aucune poignée globale :
 *     remontée des fibres React depuis `.mapboxgl-map` jusqu'au hook dont
 *     `current` a `getCanvas`) ;
 *   - `__rvMapState()` : carte prête (style et tuiles chargés), tracé présent ;
 *   - `__rvMapPoint()` : centre de la partie de la carte qu'aucun panneau ne
 *     recouvre (cible des gestes).
 */
export const PAGE_PROBE = `(() => {
  if (window.__rvPerf) return;
  const perf = { fcp: null, lcp: null, longTasks: [], loafs: [] };
  window.__rvPerf = perf;
  const observe = (type, onEntry) => {
    try {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) onEntry(entry); }).observe({ type, buffered: true });
    } catch {}
  };
  observe('paint', (e) => { if (e.name === 'first-contentful-paint') perf.fcp = e.startTime; });
  observe('largest-contentful-paint', (e) => { perf.lcp = e.startTime; });
  observe('longtask', (e) => { perf.longTasks.push([e.startTime, e.duration]); });
  observe('long-animation-frame', (e) => { perf.loafs.push([e.startTime, e.duration, e.blockingDuration]); });

  let frames = null;
  window.__rvFrames = {
    start() {
      frames = [];
      const tick = (t) => { if (!frames) return; frames.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    },
    stop() { const out = frames ?? []; frames = null; return out; },
  };

  window.__rvMap = () => {
    const el = document.querySelector('.mapboxgl-map');
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    for (let fiber = key ? el[key] : null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
        const value = hook.memoizedState;
        const current = value && typeof value === 'object' && 'current' in value ? value.current : null;
        if (current && typeof current.getCanvas === 'function') return current;
      }
    }
    return null;
  };

  // Centre de la partie visible de la carte : le canvas couvre toute la
  // fenêtre, les panneaux (gauche, droite, analyse) le recouvrent en partie.
  window.__rvMapPoint = () => {
    const canvas = document.querySelector('.mapboxgl-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const free = [];
    for (let gy = 1; gy < 24; gy++) {
      for (let gx = 1; gx < 32; gx++) {
        const x = rect.left + (rect.width * gx) / 32;
        const y = rect.top + (rect.height * gy) / 24;
        if (document.elementFromPoint(x, y) === canvas) free.push([x, y]);
      }
    }
    if (!free.length) return null;
    const xs = free.map((p) => p[0]).sort((a, b) => a - b);
    const ys = free.map((p) => p[1]).sort((a, b) => a - b);
    const mx = xs[xs.length >> 1];
    const my = ys[ys.length >> 1];
    let best = free[0];
    for (const p of free) if (Math.hypot(p[0] - mx, p[1] - my) < Math.hypot(best[0] - mx, best[1] - my)) best = p;
    const width = xs[xs.length - 1] - xs[0];
    const height = ys[ys.length - 1] - ys[0];
    return { x: best[0], y: best[1], width, height };
  };

  window.__rvMapState = () => {
    const map = window.__rvMap();
    if (!map) return { map: false, ready: false, route: false };
    let route = false;
    try {
      const sources = map.getStyle()?.sources ?? {};
      route = Object.keys(sources).some((id) => id.startsWith('brouter-route-source-'));
    } catch {}
    let ready = false;
    try { ready = map.isStyleLoaded() && map.loaded() && map.areTilesLoaded(); } catch {}
    const c = map.getCenter();
    return { map: true, ready, route, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), lng: c.lng, lat: c.lat };
  };
})();`;
