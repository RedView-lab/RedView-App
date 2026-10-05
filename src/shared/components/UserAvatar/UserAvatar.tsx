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
  /** Anneau de la couleur du fond (pastilles qui se chevauchent). */
  ringed?: boolean;
  title?: string;
};

export function UserAvatar({ userId, name, size = 24, ringed = false, title }: UserAvatarProps) {
  const color = userAvatarColor(userId);
  const style = {
    '--rv-avatar-size': `${size}px`,
    background: color,
    // Initiales : blanches sur les couleurs vives, encre du thème clair sur jaune / orange.
    color: LIGHT_COLORS.has(color) ? 'rgb(17 17 20)' : 'var(--rv-on-accent)',
  } as CSSProperties;
  return (
    <span className={`rv-avatar${ringed ? ' rv-avatar--ringed' : ''}`} style={style} title={title ?? name} aria-label={name}>
      {initialOf(name)}
    </span>
  );
}
