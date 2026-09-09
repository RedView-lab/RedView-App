import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import './styles.css';

export interface FpsDiagnosticsMonitorProps {
  map: MapboxMap | null;
  top?: number;
  right?: number;
  style?: CSSProperties;
}

interface PerformanceSnapshot {
  fps: number;
  minFps: number;
  frameMs: number;
  renderRate: number;
  zoom: number;
  pitch: number;
  bearing: number;
  canvasWidth: number;
  canvasHeight: number;
  dpr: number;
  megaPixels: number;
  hasTerrain: boolean;
  jsHeapMb: number | null;
  gpuName: string;
}

function getGpuRendererName(): string {
  if (typeof document === 'undefined') return 'Inconnu';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'Inconnu (Pas de WebGL)';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const unmasked = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (unmasked) {
        // Clean up ANGLE wrapper string
        return String(unmasked)
          .replace(/^ANGLE\s*\(([^,]+),\s*/, '')
          .replace(/\s*Direct3D.*$/, '')
          .replace(/\s*vs_.*$/, '')
          .replace(/\)$/, '')
          .trim();
      }
    }
    return gl.getParameter(gl.RENDERER) || 'WebGL Standard';
  } catch {
    return 'Inconnu';
  }
}

export function FpsDiagnosticsMonitor({
  map,
  top = 12,
  right = 72,
  style,
}: FpsDiagnosticsMonitorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot>({
    fps: 60,
    minFps: 60,
    frameMs: 16.6,
    renderRate: 0,
    zoom: 0,
    pitch: 0,
    bearing: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    megaPixels: 0,
    hasTerrain: false,
    jsHeapMb: null,
    gpuName: 'Détection...',
  });

  const gpuNameRef = useRef('Détection...');
  const renderCountRef = useRef(0);
  const isTerrainDisabledByTestRef = useRef(false);

  useEffect(() => {
    gpuNameRef.current = getGpuRendererName();
  }, []);

  useEffect(() => {
    if (!map) return;
    const onRender = () => {
      renderCountRef.current += 1;
    };
    map.on('render', onRender);
    return () => {
      map.off('render', onRender);
    };
  }, [map]);

  useEffect(() => {
    let animId = 0;
    let lastTime = performance.now();
    let frameTimes: number[] = [];
    let recentMinFps = 60;
    let minFpsWindow: number[] = [];
    let lastStatsUpdate = performance.now();

    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;

      if (dt > 0 && dt < 200) {
        const instantFps = 1000 / dt;
        frameTimes.push(instantFps);
        minFpsWindow.push(instantFps);
      }

      // Update HUD state every 250ms
      if (now - lastStatsUpdate >= 250) {
        const intervalSec = (now - lastStatsUpdate) / 1000;
        lastStatsUpdate = now;

        const avgFps = frameTimes.length > 0
          ? Math.round(frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length)
          : 60;
        frameTimes = [];

        // Rolling minimum over ~2.5s (10 windows)
        if (minFpsWindow.length > 80) {
          recentMinFps = Math.round(Math.min(...minFpsWindow));
          minFpsWindow = minFpsWindow.slice(-40);
        }

        const rendersPerSec = Math.round(renderCountRef.current / intervalSec);
        renderCountRef.current = 0;

        let canvasWidth = 0;
        let canvasHeight = 0;
        let zoom = 0;
        let pitch = 0;
        let bearing = 0;
        let hasTerrain = false;

        if (map) {
          try {
            const canvas = map.getCanvas();
            if (canvas) {
              canvasWidth = canvas.width;
              canvasHeight = canvas.height;
            }
            zoom = Number(map.getZoom().toFixed(1));
            pitch = Math.round(map.getPitch());
            bearing = Math.round(map.getBearing());
            hasTerrain = Boolean(map.getTerrain());
          } catch {
            /* best-effort */
          }
        }

        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const megaPixels = canvasWidth > 0 && canvasHeight > 0
          ? Number(((canvasWidth * canvasHeight) / 1_000_000).toFixed(2))
          : 0;

        let jsHeapMb: number | null = null;
        if (typeof window !== 'undefined' && (performance as any).memory?.usedJSHeapSize) {
          jsHeapMb = Math.round((performance as any).memory.usedJSHeapSize / 1_048_576);
        }

        setSnapshot({
          fps: Math.min(avgFps, 120),
          minFps: Math.min(recentMinFps, avgFps),
          frameMs: Number((dt).toFixed(1)),
          renderRate: rendersPerSec,
          zoom,
          pitch,
          bearing,
          canvasWidth,
          canvasHeight,
          dpr: Number(dpr.toFixed(2)),
          megaPixels,
          hasTerrain,
          jsHeapMb,
          gpuName: gpuNameRef.current,
        });
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animId);
    };
  }, [map]);

  const toggleTestTerrain = () => {
    if (!map) return;
    try {
      if (map.getTerrain()) {
        map.setTerrain(null);
        isTerrainDisabledByTestRef.current = true;
      } else {
        // Re-enable unified or fallback DEM
        const sourceId = map.getSource('unified-dem')
          ? 'unified-dem'
          : map.getSource('aws-fast-dem')
          ? 'aws-fast-dem'
          : 'mapbox-dem';
        if (map.getSource(sourceId)) {
          map.setTerrain({ source: sourceId, exaggeration: 1.5 });
        }
        isTerrainDisabledByTestRef.current = false;
      }
    } catch (e) {
      console.warn('[FpsMonitor] toggle terrain error', e);
    }
  };

  const toggleTestPitch = () => {
    if (!map) return;
    const targetPitch = map.getPitch() > 20 ? 0 : 60;
    map.easeTo({ pitch: targetPitch, duration: 400 });
  };

  const fpsColor = snapshot.fps >= 55
    ? '#22c55e'
    : snapshot.fps >= 38
    ? '#eab308'
    : '#ef4444';

  const getBottleneckReason = () => {
    if (snapshot.fps >= 55) {
      return {
        level: 'is-ok',
        icon: '✓',
        text: 'Fluidité optimale : +55 FPS stable.',
      };
    }
    if (snapshot.pitch > 45 && snapshot.hasTerrain) {
      return {
        level: 'is-critical',
        icon: '⚠️',
        text: `Relief 3D à fort pitch (${snapshot.pitch}°) : l'iGPU calcule des milliers de triangles DEM jusqu'à l'horizon.`,
      };
    }
    if (snapshot.megaPixels >= 4.0) {
      return {
        level: 'is-warning',
        icon: '⚠️',
        text: `Résolution élevée (${snapshot.megaPixels} MP / DPR ${snapshot.dpr}) : le fillrate sature la mémoire partagée de l'APU.`,
      };
    }
    if (snapshot.renderRate > 45) {
      return {
        level: 'is-warning',
        icon: '⚡',
        text: `Nombreux rafraîchissements WebGL (${snapshot.renderRate} r/s) : saturation shaders fragment.`,
      };
    }
    return {
      level: 'is-warning',
      icon: '⚙️',
      text: "Charge combinée carte 3D / thread principal JavaScript.",
    };
  };

  const bottleneck = getBottleneckReason();

  return (
    <div
      className="rv-fps-monitor"
      style={{
        top: `${top}px`,
        right: `${right}px`,
        ...style,
      }}
    >
      <div
        className="rv-fps-pill"
        onClick={() => setIsOpen((prev) => !prev)}
        title="Ouvrir les diagnostics de performance"
      >
        <span className="rv-fps-dot" style={{ background: fpsColor, color: fpsColor }} />
        <span className="rv-fps-val" style={{ color: fpsColor }}>
          {snapshot.fps} FPS
        </span>
        <span className="rv-fps-ms">
          {snapshot.frameMs} ms
        </span>
        <span className={`rv-fps-chevron ${isOpen ? 'is-open' : ''}`}>▼</span>
      </div>

      {isOpen && (
        <div className="rv-fps-card">
          <div className="rv-fps-header">
            <span className="rv-fps-title">Diagnostics Graphiques</span>
            <span className="rv-fps-gpu-badge" title={snapshot.gpuName}>
              {snapshot.gpuName}
            </span>
          </div>

          <div className={`rv-fps-bottleneck ${bottleneck.level}`}>
            <span>{bottleneck.icon}</span>
            <span>{bottleneck.text}</span>
          </div>

          <div className="rv-fps-grid">
            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">FPS (Moyen / Min)</div>
              <div className="rv-fps-stat-value" style={{ color: fpsColor }}>
                {snapshot.fps} / {snapshot.minFps}
              </div>
            </div>

            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">Temps Frame</div>
              <div className="rv-fps-stat-value">
                {snapshot.frameMs} ms
              </div>
            </div>

            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">Caméra (Pitch / Zoom)</div>
              <div className="rv-fps-stat-value">
                {snapshot.pitch}° / z{snapshot.zoom}
              </div>
            </div>

            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">Relief 3D DEM</div>
              <div className="rv-fps-stat-value" style={{ color: snapshot.hasTerrain ? '#60a5fa' : '#9ca3af' }}>
                {snapshot.hasTerrain ? 'Actif (Tessellation)' : 'Désactivé (2D Plat)'}
              </div>
            </div>

            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">Résolution Canvas</div>
              <div className="rv-fps-stat-value">
                {snapshot.canvasWidth}×{snapshot.canvasHeight}
              </div>
            </div>

            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">Pixel Ratio (DPR)</div>
              <div className="rv-fps-stat-value">
                {snapshot.dpr}x ({snapshot.megaPixels} MP)
              </div>
            </div>

            {snapshot.jsHeapMb !== null && (
              <div className="rv-fps-stat-box">
                <div className="rv-fps-stat-label">Mémoire JS (Heap)</div>
                <div className="rv-fps-stat-value">
                  {snapshot.jsHeapMb} Mo
                </div>
              </div>
            )}

            <div className="rv-fps-stat-box">
              <div className="rv-fps-stat-label">Repaints WebGL / s</div>
              <div className="rv-fps-stat-value">
                {snapshot.renderRate} / sec
              </div>
            </div>
          </div>

          <div className="rv-fps-actions">
            <div className="rv-fps-actions-title">Tests Immédiats d'Identification</div>
            <div className="rv-fps-button-row">
              <button
                type="button"
                className={`rv-fps-btn ${!snapshot.hasTerrain ? 'is-active' : ''}`}
                onClick={toggleTestTerrain}
                title="Désactive temporairement le relief DEM pour mesurer l'impact du maillage 3D"
              >
                {snapshot.hasTerrain ? 'Désactiver Relief 3D' : 'Réactiver Relief 3D'}
              </button>
              <button
                type="button"
                className="rv-fps-btn"
                onClick={toggleTestPitch}
                title="Bascule l'inclinaison de la caméra (0° 2D vs 60° 3D)"
              >
                {snapshot.pitch > 20 ? 'Vue 2D (0°)' : 'Vue 3D (60°)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
