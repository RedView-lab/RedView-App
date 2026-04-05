import 'mapbox-gl/dist/mapbox-gl.css';
import { useRef } from 'react';
import { useMap } from '../hooks/useMap';

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isLoaded } = useMap(containerRef);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100dvh' }}>
      <div
        ref={containerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      {!isLoaded && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(17, 17, 17, 0.85)',
            zIndex: 10,
          }}
        >
          <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
            Chargement du globe...
          </span>
        </div>
      )}
    </div>
  );
}
