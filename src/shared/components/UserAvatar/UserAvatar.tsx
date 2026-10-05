import type { CSSProperties } from 'react';

import './UserAvatar.css';

/**
 * Pastille d'un utilisateur (co-édition) : initiales sur une couleur stable
 * par utilisateur, prise dans la palette des itinéraires
 * (itineraryPanel/lib/project/defaultState.ts, ITINERARY_COLORS).
 */
const AVATAR_COLORS = ['#c50000', '#ff8a3d', '#ffd13a', '#5ab95a', '#3d8bff', '#9b59ff'] as const;
/** Couleurs claires de la palette : initiales foncées (lisibles). */
const LIGHT_COLORS = new Set<string>(['#ffd13a', '#ff8a3d']);
/**
 * Demi-hauteur des capitales de Rethink Sans (sCapHeight 700 / 1000) : la
 * ligne de base posée à mi-hauteur + 0,35 em centre la lettre exactement.
 */
const HALF_CAP_HEIGHT_EM = 0.35;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

function userAvatarColor(userId: string): string {
  return AVATAR_COLORS[hashString(userId) % AVATAR_COLORS.length];
}

/** Initiale du nom (ou de l'e-mail), comme les pastilles de Figma. */
function initialOf(name: string): string {
  const first = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return (first ?? '?').toLocaleUpperCase();
}

type UserAvatarProps = {
  userId: string;
  /** Nom affiché (ou e-mail). */
  name: string;
  size?: 20 | 24 | 28;
  title?: string;
};

export function UserAvatar({ userId, name, size = 24, title }: UserAvatarProps) {
  const color = userAvatarColor(userId);
  const style = {
    '--rv-avatar-size': `${size}px`,
    background: color,
    // Initiales : blanches sur les couleurs vives, encre du thème clair sur jaune / orange.
    color: LIGHT_COLORS.has(color) ? 'rgb(17 17 20)' : 'var(--rv-on-accent)',
  } as CSSProperties;
  // Lettre en SVG : une boîte de ligne HTML de 11 px dans un rond de 28 px
  // tombe sur un demi-pixel et se décale à l'arrondi ; le texte SVG est placé
  // au sous-pixel, centré sur la chasse et la hauteur de capitale.
  return (
    <span className={`rv-avatar rv-avatar--${size}`} style={style} title={title ?? name} role="img" aria-label={name}>
      <svg className="rv-avatar__glyph" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <text x={size / 2} y={size / 2} dy={`${HALF_CAP_HEIGHT_EM}em`} textAnchor="middle" fill="currentColor">
          {initialOf(name)}
        </text>
      </svg>
    </span>
  );
}

type UserAvatarStackProps = {
  people: readonly { userId: string; name: string }[];
  /**
   * Places de la pile. Au-delà, la dernière devient « +N » ; jamais « +1 » :
   * une pastille de plus tient dans la même place et dit qui c'est.
   */
  max: number;
  className?: string;
};

/** Pastilles empilées et découpées (Figma) : `max` places au plus, la dernière en « +N » si besoin. */
export function UserAvatarStack({ people, max, className }: UserAvatarStackProps) {
  const visibleCount = people.length <= max ? people.length : Math.max(1, max - 1);
  const visible = people.slice(0, visibleCount);
  const hidden = people.slice(visibleCount);
  return (
    <span className={`rv-avatar-stack${className ? ` ${className}` : ''}`}>
      {visible.map((person) => (
        <UserAvatar key={person.userId} userId={person.userId} name={person.name} />
      ))}
      {hidden.length > 0 ? (
        <span className="rv-avatar-stack__more" title={hidden.map((person) => person.name).join(', ')}>
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
