import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

/** Icônes des commentaires : jeu svgv2 (masques peints en `currentColor`) + trois glyphes absents du jeu. */

type IconProps = { size?: number };

export const IconComment = ({ size = 16 }: IconProps) => <SvgV2Icon name="annotation.svg" size={size} />;
export const IconResolve = ({ size = 16 }: IconProps) => <SvgV2Icon name="check-circle.svg" size={size} />;
export const IconMore = ({ size = 16 }: IconProps) => <SvgV2Icon name="dots-vertical.svg" size={size} />;
export const IconClose = ({ size = 16 }: IconProps) => <SvgV2Icon name="x-close.svg" size={size} />;
export const IconPrevious = ({ size = 16 }: IconProps) => <SvgV2Icon name="chevron-left.svg" size={size} />;
export const IconNext = ({ size = 16 }: IconProps) => <SvgV2Icon name="chevron-right.svg" size={size} />;
export const IconChevronDown = ({ size = 16 }: IconProps) => <SvgV2Icon name="chevron-down.svg" size={size} />;
export const IconSearch = ({ size = 16 }: IconProps) => <SvgV2Icon name="search-sm.svg" size={size} />;
export const IconSort = ({ size = 16 }: IconProps) => <SvgV2Icon name="switch-vertical-01.svg" size={size} />;

/** Envoyer : flèche vers le haut (comme le bouton d'envoi de Figma). */
export const IconSend = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 12.5v-9M4 7.5l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Ajouter une réaction / un emoji. */
export const IconSmile = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.6 9.4c.6.8 1.4 1.2 2.4 1.2s1.8-.4 2.4-1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="6" cy="6.6" r=".85" fill="currentColor" />
    <circle cx="10" cy="6.6" r=".85" fill="currentColor" />
  </svg>
);

/** Mentionner quelqu'un. */
export const IconAt = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M10.6 5.6v3.3c0 .9.6 1.5 1.4 1.5.9 0 1.5-.8 1.5-2.4A5.5 5.5 0 1 0 11 12.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/** Zone commentée (rectangle pointillé). */
export const IconZone = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 1.6" />
  </svg>
);
