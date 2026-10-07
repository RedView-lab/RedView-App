import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';

import { useLivePresenceOptional, type LivePeer } from '../context/LivePresenceContext';
import '../styles/livePresence.css';

interface RemoteChartCursorsProps {
  /** Abscisses visibles du graphique. */
  xDomain: { min: number; max: number };
  /** Abscisse (dans le mode d'axe de cet éditeur) d'un point survolé ; null s'il n'est pas sur ce graphique. */
  toChartX: (itineraryId: string, distanceM: number) => number | null;
}

const NO_PEERS: readonly LivePeer[] = [];

/**
 * Survol du graphique d'analyse par les autres éditeurs : une ligne à leur
 * couleur, avec leur nom. Le point survolé arrive en (itinéraire, distance) :
 * chacun le voit dans son propre mode d'axe (distance, temps, heure). Rejoué
 * en différé comme leurs curseurs (MotionStore), déplacé dans le DOM à chaque
 * image : le graphique lui-même ne se redessine jamais pour ça.
 */
export function RemoteChartCursors({ xDomain, toChartX }: RemoteChartCursorsProps) {
  const live = useLivePresenceOptional();
  const peers = live?.peers ?? NO_PEERS;
  const store = live?.store ?? null;
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const latestRef = useRef({ xDomain, toChartX });
  const requestRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    latestRef.current = { xDomain, toChartX };
    requestRef.current?.();
  }, [peers, toChartX, xDomain]);

  useEffect(() => {
    if (!store) return undefined;
    let frameId: number | null = null;
    const update = (now: number) => {
      frameId = null;
      const { xDomain: domain, toChartX: convert } = latestRef.current;
      const span = domain.max - domain.min;
      let settled = true;
      for (const [clientId, element] of elementsRef.current) {
        const chart = store.frame(clientId, now)?.chart ?? null;
        if (chart && !chart.settled) settled = false;
        const x = chart?.values && chart.key ? convert(chart.key, chart.values[0]) : null;
        const ratio = x !== null && span > 0 ? (x - domain.min) / span : Number.NaN;
        const visible = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
        if (visible) element.style.left = `${(ratio * 100).toFixed(4)}%`;
        element.classList.toggle('is-visible', visible);
      }
      if (!settled) request();
    };
    const request = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(update);
    };
    requestRef.current = request;
    const unsubscribe = store.subscribe(request);
    request();
    return () => {
      unsubscribe();
      requestRef.current = null;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [store]);

  if (peers.length === 0) return null;
  return (
    <div className="rv-remote-chart-cursors" aria-hidden="true">
      {peers.map((peer) => (
        <div
          key={peer.clientId}
          ref={(element) => {
            if (element) elementsRef.current.set(peer.clientId, element);
            else elementsRef.current.delete(peer.clientId);
          }}
          className="rv-remote-chart-cursor"
          style={{ '--rv-peer-color': peer.color, '--rv-peer-ink': peer.ink } as CSSProperties}
        >
          <span className="rv-remote-chart-cursor__label">{peer.name}</span>
        </div>
      ))}
    </div>
  );
}
