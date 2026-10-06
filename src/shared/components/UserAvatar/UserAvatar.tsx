import type { CSSProperties } from 'react';

import { userAvatarColor, userAvatarInk } from './avatarColor';
import './UserAvatar.css';

/**
 * Pastille d'un utilisateur (co-édition) : initiales sur une couleur stable
 * par utilisateur (avatarColor.ts).
 */
/**
 * Demi-hauteur des capitales de Rethink Sans (sCapHeight 700 / 1000) : la
 * ligne de base posée à mi-hauteur + 0,35 em centre la lettre exactement.
 */
const HALF_CAP_HEIGHT_EM = 0.35;

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
    color: userAvatarInk(color),
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

export interface StackPerson {
  userId: string;
  name: string;
  /** Anneau : `followed` (je le suis, plein), `presenting` (il présente sa vue, pointillé). */
  ring?: 'followed' | 'presenting' | null;
  /** Infobulle (sinon le nom). */
  title?: string;
}

type UserAvatarStackProps = {
  people: readonly StackPerson[];
  /**
   * Places de la pile. Au-delà, la dernière devient « +N » ; jamais « +1 » :
   * une pastille de plus tient dans la même place et dit qui c'est.
   */
  max: number;
  className?: string;
  /** Pastilles cliquables (suivre un éditeur, comme Figma) : reçoit la personne et son bouton. */
  onPersonClick?: (person: StackPerson, anchor: HTMLElement) => void;
  /** « +N » cliquable : reçoit les personnes masquées et le bouton. */
  onMoreClick?: (hidden: readonly StackPerson[], anchor: HTMLElement) => void;
};

/** Pastilles empilées et découpées (Figma) : `max` places au plus, la dernière en « +N » si besoin. */
export function UserAvatarStack({ people, max, className, onPersonClick, onMoreClick }: UserAvatarStackProps) {
  const visibleCount = people.length <= max ? people.length : Math.max(1, max - 1);
  const visible = people.slice(0, visibleCount);
  const hidden = people.slice(visibleCount);
  const moreTitle = hidden.map((person) => person.name).join(', ');
  return (
    <span className={`rv-avatar-stack${className ? ` ${className}` : ''}`}>
      {visible.map((person) => {
        const ringClass = person.ring ? ` rv-avatar-stack__person--${person.ring}` : '';
        if (!onPersonClick) {
          return (
            <span key={person.userId} className={`rv-avatar-stack__person${ringClass}`}>
              <UserAvatar userId={person.userId} name={person.name} title={person.title} />
            </span>
          );
        }
        return (
          <button
            key={person.userId}
            type="button"
            className={`rv-avatar-stack__person rv-avatar-stack__person--button${ringClass}`}
            aria-pressed={person.ring === 'followed'}
            aria-label={person.title ?? person.name}
            title={person.title ?? person.name}
            onClick={(event) => onPersonClick(person, event.currentTarget)}
          >
            <UserAvatar userId={person.userId} name={person.name} title={person.title} />
          </button>
        );
      })}
      {hidden.length > 0 ? (
        onMoreClick ? (
          <button
            type="button"
            className="rv-avatar-stack__more rv-avatar-stack__more--button"
            title={moreTitle}
            aria-label={moreTitle}
            aria-haspopup="menu"
            onClick={(event) => onMoreClick(hidden, event.currentTarget)}
          >
            +{hidden.length}
          </button>
        ) : (
          <span className="rv-avatar-stack__more" title={moreTitle}>
            +{hidden.length}
          </span>
        )
      ) : null}
    </span>
  );
}
