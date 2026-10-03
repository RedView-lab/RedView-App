// Evaluated in the page. Returns text-size and layout metrics in CSS px of the real viewport.
(() => {
  const vw = innerWidth, vh = innerHeight;
  const texts = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const txt = node.textContent.replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    // Map markers (POI badges, 2xs/3xs by design) and Mapbox attribution are not UI text.
    if (el.closest('script,style,noscript,.mapboxgl-ctrl-attrib,.mapboxgl-ctrl-logo,.mapboxgl-marker')) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    // Actually on top (not covered by an overlay / collapsed panel)?
    const cx = Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width, 6) / 2));
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    let scale = 1;
    if (el instanceof SVGElement) {
      const bb = el.getBBox ? el.getBBox() : null;
      const er = el.getBoundingClientRect();
      scale = bb && bb.height > 0 ? er.height / bb.height : 1;
    } else if (el.offsetWidth > 0) {
      scale = el.getBoundingClientRect().width / el.offsetWidth;
    }
    let ancestorTransform = null;
    for (let a = el; a; a = a.parentElement) {
      const t = getComputedStyle(a).transform;
      if (t && t !== 'none' && !/^matrix\(1, 0, 0, 1,/.test(t)) { ancestorTransform = t; break; }
    }
    texts.push({
      text: txt.slice(0, 40),
      cls: (el.getAttribute('class') || el.tagName).toString().slice(0, 60),
      fs,
      eff: +(fs * scale).toFixed(2),
      weight: cs.fontWeight,
      x: Math.round(r.left), y: Math.round(r.top),
      scaled: !!ancestorTransform,
    });
  }
  // Interactive targets
  const targets = [...document.querySelectorAll('button, [role=button], input:not([type=hidden]), select, a[href], [role=tab], [role=menuitem], [role=checkbox]')]
    .filter((el) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh)
    .map(({ el, r }) => ({ label: (el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 30), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }));

  // Regions
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const regionEl = (name) => document.querySelector(`[data-rv-region="${name}"]`);
  const absPanels = [...document.querySelectorAll('div[style*="z-index: 25"]')];
  const hostOf = (inner) => (inner ? absPanels.find((p) => p.contains(inner)) : null);
  const visibleRect = (el) => (el && el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ? rect(el) : null);
  const regions = {
    left: visibleRect(regionEl('left-panel') ?? hostOf(document.querySelector('[class*="rvi-panel"]'))?.firstElementChild),
    right: visibleRect(regionEl('right-panel') ?? hostOf(document.querySelector('[class*="rvc-"]'))?.firstElementChild),
    toolbar: null,
    center: null,
    mapTools: visibleRect(document.querySelector('.rvmvc-map-tools')),
    search: visibleRect(document.querySelector('[class*="place-search"], [class*="dashboard-search"]')),
  };
  regions.toolbar = visibleRect(regionEl('center-toolbar') ?? absPanels.find((p) => /height: 48px/.test(p.getAttribute('style') || '')));
  regions.center = visibleRect(regionEl('center-panel') ?? absPanels.find((p) => /--rvc-center-panel-height/.test(p.getAttribute('style') || '')));
  const scaleVar = getComputedStyle(document.documentElement).getPropertyValue('--app-scale');
  const canvas = document.querySelector('[data-rv-canvas]') ?? document.querySelector('#root div[style*="container-name"]');
  const canvasStyle = canvas ? { transform: canvas.style.transform, zoom: canvas.style.zoom } : null;
  const docOverflow = { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight };
  // Analysis toolbar of the center panel: rows actually used (useToolbarFitDensity).
  const analysisBar = document.querySelector('.rvc-center-analysis__toolbar');
  let analysisToolbar = null;
  if (analysisBar && analysisBar.checkVisibility?.()) {
    const tops = [...analysisBar.querySelectorAll(':scope > *, :scope > .rvc-center-analysis__filters > *')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 || r.height > 0);
    const firstRowBottom = Math.min(...tops.map((r) => r.bottom));
    analysisToolbar = {
      wraps: tops.some((r) => r.top >= firstRowBottom - 0.5),
      density: analysisBar.dataset.density ?? '',
      w: +analysisBar.getBoundingClientRect().width.toFixed(1),
    };
  }
  return { vw, vh, appScale: scaleVar, canvasStyle, texts, targets, regions, docOverflow, analysisToolbar };
})()
