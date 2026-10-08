// ============================================
// Outils du viewer LiDAR — glyphes d'outils de 16 px (même trait que les icônes de menu de l'app)
// ============================================

import type { ReactNode } from 'react';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.333"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function DistanceGlyph() {
  return (
    <Glyph>
      <path d="M2 11.5L11.5 2L14 4.5L4.5 14L2 11.5Z" />
      <path d="M5 8.5L6.5 10M7.5 6L9 7.5M10 3.5L11.5 5" />
    </Glyph>
  );
}

export function HeightGlyph() {
  return (
    <Glyph>
      <path d="M2.5 13.5H13.5V2.5L2.5 13.5Z" />
      <path d="M10.5 13.5C10.5 12 10 11 9 10.5" />
    </Glyph>
  );
}

export function AreaGlyph() {
  return (
    <Glyph>
      <path d="M3 4.5L9.5 2.5L13.5 7L11 13.5L3.5 11.5L3 4.5Z" />
    </Glyph>
  );
}

export function ProfileGlyph() {
  return (
    <Glyph>
      <path d="M1.5 12.5L5 7L7.5 9.5L10.5 4L14.5 12.5" />
      <path d="M1.5 14.5H14.5" />
    </Glyph>
  );
}

export function FallLineGlyph() {
  return (
    <Glyph>
      <path d="M3 2.5C4 6 8.5 6.5 9.5 10.5L10.2 13" />
      <path d="M7.8 11.6L10.2 13.5L12 11" />
    </Glyph>
  );
}

export function AvalancheGlyph() {
  return (
    <Glyph>
      <path d="M8 2.5L14 13H2L8 2.5Z" />
      <path d="M8 6.5V9.2" />
      <path d="M8 11.2V11.3" />
    </Glyph>
  );
}

export function ViewshedGlyph() {
  return (
    <Glyph>
      <path d="M1.5 8C3 5 5.3 3.5 8 3.5C10.7 3.5 13 5 14.5 8C13 11 10.7 12.5 8 12.5C5.3 12.5 3 11 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </Glyph>
  );
}

export function PinGlyph() {
  return (
    <Glyph>
      <path d="M8 14C8 14 12.5 9.8 12.5 6.5C12.5 4 10.5 2 8 2C5.5 2 3.5 4 3.5 6.5C3.5 9.8 8 14 8 14Z" />
      <circle cx="8" cy="6.5" r="1.5" />
    </Glyph>
  );
}

export function CenterGlyph() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1.5V4M8 12V14.5M1.5 8H4M12 8H14.5" />
    </Glyph>
  );
}

export function FaceSlopeGlyph() {
  return (
    <Glyph>
      <path d="M1.5 13.5L9.5 4.5L14.5 13.5H1.5Z" />
      <path d="M4 3L6.5 5.5M6.5 5.5V3.3M6.5 5.5H4.3" />
    </Glyph>
  );
}

export function PointsGlyph() {
  return (
    <Glyph>
      <circle cx="4" cy="11" r="0.9" fill="currentColor" />
      <circle cx="7.5" cy="6" r="0.9" fill="currentColor" />
      <circle cx="11.5" cy="9" r="0.9" fill="currentColor" />
      <circle cx="9" cy="12.5" r="0.9" fill="currentColor" />
      <circle cx="12" cy="4" r="0.9" fill="currentColor" />
      <circle cx="4.5" cy="4.5" r="0.9" fill="currentColor" />
    </Glyph>
  );
}

export function TerrainGlyph() {
  return (
    <Glyph>
      <path d="M1.5 13L6 5.5L8.5 9.5L10.5 7L14.5 13H1.5Z" />
    </Glyph>
  );
}

export function CloseGlyph() {
  return (
    <Glyph>
      <path d="M4 4L12 12M12 4L4 12" />
    </Glyph>
  );
}

export function MeasureGlyph() {
  return (
    <Glyph>
      <path d="M1.5 6H14.5V10.5H1.5V6Z" />
      <path d="M4 6V8M6.5 6V8.8M9 6V8M11.5 6V8.8" />
    </Glyph>
  );
}

export function TerrainAnalysisGlyph() {
  return (
    <Glyph>
      <path d="M1.5 13L5.5 6.5L8 10L9.5 8" />
      <circle cx="11.5" cy="6" r="2.5" />
      <path d="M13.3 7.8L14.8 9.3" />
      <path d="M1.5 13H14.5" />
    </Glyph>
  );
}

/** Œil dans un arc de 360° : le tour d'horizon à la première personne. */
export function LookAroundGlyph() {
  return (
    <Glyph>
      <path d="M3.5 9.5C4.5 7.6 6.1 6.5 8 6.5C9.9 6.5 11.5 7.6 12.5 9.5C11.5 11.4 9.9 12.5 8 12.5C6.1 12.5 4.5 11.4 3.5 9.5Z" />
      <circle cx="8" cy="9.5" r="1.2" />
      <path d="M2 6.2C3.4 3.7 5.6 2.5 8 2.5C10.4 2.5 12.6 3.7 14 6.2" />
      <path d="M12.3 5.9L14 6.2L14.4 4.5" />
    </Glyph>
  );
}

export function ChevronGlyph() {
  return (
    <Glyph>
      <path d="M6 3.5L10.5 8L6 12.5" />
    </Glyph>
  );
}
