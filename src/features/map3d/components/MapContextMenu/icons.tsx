const RIGHT_CLICK_ICON_BASE = '/right-click-icons';

/**
 * Icône du menu clic droit. Les glyphes monochromes sont des masques peints à
 * l'encre du thème (`--rv-text`, le blanc des fichiers en sombre) ; `multicolor` garde l'image telle quelle
 * (pastilles départ / étape / arrivée, copies des marqueurs de la carte).
 */
function RightClickImageIcon({
  src,
  width,
  height,
  frame = Math.max(width, height),
  opacity,
  multicolor = false,
}: {
  src: string;
  width: number;
  height: number;
  frame?: number;
  opacity?: number;
  multicolor?: boolean;
}) {
  const url = `${RIGHT_CLICK_ICON_BASE}/${src}`;
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: frame,
        height: frame,
        flex: '0 0 auto',
        opacity,
      }}
    >
      {multicolor ? (
        <img
          alt=""
          aria-hidden
          src={url}
          style={{
            display: 'block',
            width,
            height,
            objectFit: 'contain',
          }}
        />
      ) : (
        <span
          style={{
            display: 'block',
            width,
            height,
            backgroundColor: 'var(--rv-text)',
            WebkitMask: `url(${url}) center / contain no-repeat`,
            mask: `url(${url}) center / contain no-repeat`,
          }}
        />
      )}
    </span>
  );
}

export function CopyButtonIcon({ copied }: { copied: boolean }) {
  return <RightClickImageIcon src="copy-05.svg" width={16} height={16} frame={19} opacity={copied ? 1 : 0.64} />;
}

export function ElevationGlyph() {
  return <RightClickImageIcon src="altitude.svg" width={10} height={8} frame={10} opacity={0.64} />;
}

export function SlopeGlyph() {
  return <RightClickImageIcon src="slope.svg" width={16} height={16} opacity={0.64} />;
}

export function GlobeGlyph() {
  return <RightClickImageIcon src="globe-06.svg" width={16} height={16} />;
}

export function SurfaceGlyph({ color = '#FF2A1F' }: { color?: string }) {
  return (
    <svg width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden>
      <rect y="2" width="12" height="4" rx="2" fill={color} />
    </svg>
  );
}

export function ClockGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.667" stroke="currentColor" strokeWidth="1.333" />
      <path d="M8 4.667V8L10.667 9.333" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SunGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.667 10.667H13.333" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <path d="M4.667 10.667C4.667 8.826 6.159 7.333 8 7.333C9.841 7.333 11.333 8.826 11.333 10.667" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <path d="M8 2.667V4" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <path d="M3.757 4.424L4.7 5.367" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <path d="M12.243 4.424L11.3 5.367" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <path d="M2.667 8H4" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <path d="M12 8H13.333" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
    </svg>
  );
}

export function ThermometerGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6.667 3.333C6.667 2.597 7.264 2 8 2C8.736 2 9.333 2.597 9.333 3.333V8.095C10.131 8.557 10.667 9.42 10.667 10.4C10.667 11.873 9.473 13.067 8 13.067C6.527 13.067 5.333 11.873 5.333 10.4C5.333 9.42 5.869 8.557 6.667 8.095V3.333Z" stroke="currentColor" strokeWidth="1.333" />
      <path d="M8 9.333V4.667" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
      <circle cx="8" cy="10.4" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function WindGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 6H9.333C10.438 6 11.333 5.105 11.333 4C11.333 2.895 10.438 2 9.333 2C8.496 2 7.78 2.514 7.483 3.244" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 10H11.333C12.438 10 13.333 10.895 13.333 12C13.333 13.105 12.438 14 11.333 14C10.496 14 9.78 13.486 9.483 12.756" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 8H14" stroke="currentColor" strokeWidth="1.333" strokeLinecap="round" />
    </svg>
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

export function StartGlyph() {
  return <RightClickImageIcon src="start.svg" width={24} height={24} frame={24} multicolor />;
}

export function WaypointGlyph() {
  return <RightClickImageIcon src="ajouteruneetape.svg" width={24} height={24} frame={24} multicolor />;
}

export function FinishGlyph() {
  return <RightClickImageIcon src="finish.svg" width={24} height={24} frame={24} multicolor />;
}

export function TrashGlyph() {
  return <RightClickImageIcon src="trash-01.svg" width={14} height={15} frame={24} />;
}
/** Commenter ici (bulle de commentaire, features/comments). */
export function CommentGlyph() {
  return (
    <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, flex: '0 0 auto' }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M2 5.2C2 4.08 2 3.52 2.218 3.092C2.41 2.716 2.716 2.41 3.092 2.218C3.52 2 4.08 2 5.2 2H10.8C11.92 2 12.48 2 12.908 2.218C13.284 2.41 13.59 2.716 13.782 3.092C14 3.52 14 4.08 14 5.2V9C14 9.932 14 10.398 13.848 10.765C13.645 11.255 13.255 11.645 12.765 11.848C12.398 12 11.932 12 11 12C10.674 12 10.511 12 10.36 12.036C10.159 12.083 9.971 12.177 9.812 12.31C9.693 12.409 9.595 12.539 9.4 12.8L8.427 14.098C8.282 14.291 8.21 14.387 8.121 14.422C8.043 14.452 7.957 14.452 7.879 14.422C7.79 14.387 7.718 14.291 7.573 14.098L6.6 12.8C6.405 12.539 6.307 12.409 6.188 12.31C6.029 12.177 5.841 12.083 5.64 12.036C5.489 12 5.326 12 5 12C4.068 12 3.602 12 3.235 11.848C2.745 11.645 2.355 11.255 2.152 10.765C2 10.398 2 9.932 2 9V5.2Z"
          stroke="currentColor"
          strokeWidth="1.333"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
