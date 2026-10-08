import type { BasemapId } from '../types';

/*
 * Miniature de chaque fond de carte : le même petit paysage (lac en haut à
 * droite, bois en bas à gauche, une route principale et un chemin) dessiné
 * dans les couleurs du fond, pour que les quatre lignes se lisent comme une
 * famille et ne diffèrent que par le style. Contenu de carte : identique dans
 * les deux thèmes de l'application, comme la carte elle-même. Les couleurs des
 * deux thèmes RedView viennent de `map3d/lib/basemapThemes/palettes.ts`.
 */

const MAIN_ROAD = 'M0 8.6C4.6 7.6 7.8 9 10.4 11.6S15.8 16.6 20 15.6';
const LANE = 'M8 0C8.4 3.8 9.4 8 10.4 11.6C11.1 14.2 11 17.2 10.4 20';
const LAKE = 'M12.6 0H20V7.4C17.6 8 15.4 6.8 14.4 4.8C13.8 3.4 13.2 1.6 12.6 0Z';
const WOOD = 'M0 12.6C2.6 11.8 4.8 13.2 5.8 15.2C6.5 16.8 6.3 18.6 5.6 20H0Z';

function VectorThumb({ land, wood, water, lane, laneCase, road, roadCase }: {
  land: string;
  wood: string;
  water: string;
  lane: string;
  laneCase: string;
  road: string;
  roadCase: string;
}) {
  return (
    <>
      <rect width="20" height="20" fill={land} />
      <path d={WOOD} fill={wood} />
      <path d={LAKE} fill={water} />
      <path d={LANE} stroke={laneCase} strokeWidth="2.2" />
      <path d={LANE} stroke={lane} strokeWidth="1.2" />
      <path d={MAIN_ROAD} stroke={roadCase} strokeWidth="3" />
      <path d={MAIN_ROAD} stroke={road} strokeWidth="1.9" />
    </>
  );
}

function TopographicThumb() {
  return (
    <>
      <rect width="20" height="20" fill="#F2F0E6" />
      <path d={WOOD} fill="#D3E5C4" />
      <path d={LAKE} fill="#A9D2EE" />
      {/* Ombrage sur le versant sous le vent de la crête. */}
      <path
        d="M9.4 4C11.4 5 11.8 7.6 12.8 9.8C13.8 12 15.4 13.4 14.6 15.6C13.4 15.2 12.2 14 10.8 13.2C11.8 11.6 11.4 9.6 10.8 7.8C10.4 6.4 10 5.2 9.4 4Z"
        fill="#5A4A32"
        fillOpacity="0.13"
      />
      <g stroke="#BB9D76" strokeWidth="0.7">
        <path d="M5.6 6.4C6.4 5.2 8.6 5.4 9.2 6.6C9.8 7.8 9.4 9.2 8.2 9.4C6.9 9.6 5 7.6 5.6 6.4Z" />
        <path d="M0 2.8C2.6 0.6 8.4 -0.2 12.4 1.2" />
        <path d="M0 12.4C2.4 13.6 5.4 14.2 7.8 15C10.2 15.8 11.6 17.6 14.4 17.8C16.6 17.9 18 16.2 18.4 13.8C18.7 11.8 17.8 10.2 16.4 9" />
      </g>
      <path
        d="M3.4 5.2C4.8 2.8 9.2 2.6 11 4.6C12.6 6.4 12.4 9 13.6 11C14.4 12.4 14 14 12.6 14.2C10.8 14.4 9.6 12.6 7.6 12C5.4 11.4 2.8 10.6 2.6 8.4C2.5 7.2 2.8 6.2 3.4 5.2Z"
        stroke="#9C7C55"
        strokeWidth="1"
      />
      <path d="M0 17.6C3.6 16.9 6.2 18.2 8.4 20" stroke="#C8BFB2" strokeWidth="1.9" />
      <path d="M0 17.6C3.6 16.9 6.2 18.2 8.4 20" stroke="#FFFFFF" strokeWidth="1" />
    </>
  );
}

function SatelliteThumb() {
  return (
    <>
      <rect width="20" height="20" fill="#5A6440" />
      {/* Mosaïque de champs. */}
      <path d="M0 0H8L7.2 6H0Z" fill="#76804C" />
      <path d="M8 0H12.6L12.2 5.2L7.2 6Z" fill="#938C5C" />
      <path d="M0 6H7.2L6.6 11.2H0Z" fill="#4C5C36" />
      <path d="M7.2 6L12.2 5.2L12.6 10.2L6.6 11.2Z" fill="#82894F" />
      <path d="M12.6 10.2L20 9.4V20H13.4Z" fill="#6B7546" />
      <path d="M6.6 11.2L12.6 10.2L13.4 20H6Z" fill="#8E8A5E" />
      {/* Canopée de la forêt. */}
      <path d="M0 11.2H6.6L6 20H0Z" fill="#2F3E27" />
      <g fill="#3F5232">
        <circle cx="1.6" cy="13" r="1.1" />
        <circle cx="4.4" cy="12.8" r="1" />
        <circle cx="3" cy="15.6" r="1.2" />
        <circle cx="5.2" cy="17" r="0.9" />
        <circle cx="1.4" cy="18.4" r="1" />
        <circle cx="3.8" cy="19.2" r="0.8" />
      </g>
      <path d={LAKE} fill="#26414F" />
      <path d="M12.6 0C13.2 1.6 13.8 3.4 14.4 4.8C15.4 6.8 17.6 8 20 7.4" stroke="#3E6070" strokeWidth="0.6" />
      <path d={MAIN_ROAD} stroke="#ECE6D6" strokeOpacity="0.9" strokeWidth="1.1" />
      <path d={LANE} stroke="#D9D1BC" strokeOpacity="0.55" strokeWidth="0.6" />
    </>
  );
}

function ThumbContent({ id }: { id: BasemapId }) {
  switch (id) {
    case 'dark':
      return (
        <VectorThumb
          land="#232A35"
          wood="#2C3F38"
          water="#16294A"
          lane="#5C6577"
          laneCase="#1A1F28"
          road="#93855A"
          roadCase="#1A1F28"
        />
      );
    case 'topographic':
      return <TopographicThumb />;
    case 'satellite':
      return <SatelliteThumb />;
    default:
      return (
        <VectorThumb
          land="#FBF9F4"
          wood="#D5E8CF"
          water="#A9D0EC"
          lane="#FFFFFF"
          laneCase="#C9C2B8"
          road="#F6DE92"
          roadCase="#BBA475"
        />
      );
  }
}

export function BasemapThumbnail({ id }: { id: BasemapId }) {
  return (
    <svg
      className="rvc-basemaps__preview"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <ThumbContent id={id} />
    </svg>
  );
}
