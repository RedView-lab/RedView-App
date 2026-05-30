import type { ReactNode } from 'react';

export function CopyButtonIcon({ copied }: { copied: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        display: 'block',
        width: 19,
        height: 19,
        color: copied ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.64)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 4,
          left: 2,
          width: 10,
          height: 10,
          borderRadius: 2,
          border: '1.2px solid currentColor',
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: 7,
          width: 10,
          height: 10,
          borderRadius: 2,
          border: '1.2px solid currentColor',
          background: copied ? 'rgba(255,255,255,0.08)' : 'transparent',
        }}
      />
    </span>
  );
}

export function ElevationGlyph() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 10,
        height: 8,
        color: '#ffffff',
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      ▲
    </span>
  );
}

export function PoiPinGlyph() {
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        display: 'block',
        width: 24,
        height: 24,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          width: 16,
          height: 16,
          display: 'block',
          transform: 'rotate(-45deg)',
          border: '1px solid rgba(255,255,255,0.96)',
          borderRadius: '60px 60px 60px 2.667px',
          background: 'linear-gradient(90deg, rgba(0, 0, 0, 0.40) 0%, rgba(0, 0, 0, 0.40) 100%)',
          boxShadow: '0 0 5.333px 2px rgba(0,0,0,0.16)',
        }}
      />
    </span>
  );
}

function MarkerShell({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        display: 'block',
        width: 24,
        height: 24,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: 2,
          width: 20,
          height: 20,
          borderRadius: '90px 90px 90px 8px',
          background: 'rgba(0,0,0,0.6)',
          boxShadow: '0 0 6px rgba(0,0,0,0.12)',
        }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </span>
    </span>
  );
}

export function StartGlyph() {
  return (
    <MarkerShell>
      <span
        style={{
          width: 0,
          height: 0,
          borderTop: '4px solid transparent',
          borderBottom: '4px solid transparent',
          borderLeft: '7px solid #ffffff',
          transform: 'translateX(1px)',
        }}
      />
    </MarkerShell>
  );
}

export function WaypointGlyph() {
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        display: 'block',
        width: 24,
        height: 24,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: 9,
          height: 9,
          borderRadius: '50%',
          border: '1.2px solid rgba(255,255,255,0.96)',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </span>
  );
}

export function FinishGlyph() {
  return (
    <MarkerShell>
      <svg width="14" height="8" viewBox="0 0 14 8" fill="none" aria-hidden>
        <rect x="0" y="0" width="2.666" height="2.666" fill="white" />
        <rect x="0" y="5.334" width="2.666" height="2.666" fill="white" />
        <rect x="5.334" y="0" width="2.666" height="2.666" fill="white" />
        <rect x="5.334" y="5.334" width="2.666" height="2.666" fill="white" />
        <rect x="10.668" y="0" width="2.666" height="2.666" fill="white" />
        <rect x="10.668" y="5.334" width="2.666" height="2.666" fill="white" />
        <rect x="2.666" y="2.666" width="5.334" height="2.666" fill="white" />
      </svg>
    </MarkerShell>
  );
}