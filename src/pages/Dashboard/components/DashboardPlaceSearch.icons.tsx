import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib/routeSlopeLegend';
import { getPoiIconUrl } from '@/features/poi/lib/poi-icons';
import type { PoiCategory } from '@/features/poi/types';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import type { DashboardPoiOption } from './DashboardPlaceSearch.types';

export function SearchIcon() {
  return <SvgV2Icon name="search-sm.svg" size={20} />;
}

/** Case des chips de filtre, reprise dans le menu « POI » pour les sources. */
export function FilterCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`rvd-place-search__filter-checkbox${checked ? ' is-checked' : ''}`}
      aria-hidden="true"
    >
      {checked ? <SvgV2Icon name="check.svg" size={12} /> : null}
    </span>
  );
}

export function PoiOptionMarker({ option }: { option: DashboardPoiOption }) {
  return (
    <img
      className="rvd-place-search__poi-option-marker-image"
      src={getPoiIconUrl(option.id as PoiCategory)}
      alt=""
      draggable="false"
    />
  );
}

/** Glyphes monochromes (trait blanc sans pastille) : peints à l'encre du thème. */
const MONOCHROME_FILTER_ICONS = new Set(['search-filter-pauses.svg']);
/** Glyphe blanc posé sur la pastille rouge des alertes (comme sur la carte et le graphique). */
const ALERT_FILTER_ICONS = new Set(['search-filter-alertes.svg']);

/** Dégradé de l'échelle de pente du tracé (-15 % → 15 %), pastille du chip « Pente ». */
const SLOPE_SWATCH_BACKGROUND = `linear-gradient(90deg, ${ROUTE_SLOPE_LEGEND_BANDS
  .map((band) => band.color)
  .join(', ')})`;

export function SlopeSwatchIcon() {
  return (
    <span
      className="rvd-place-search__filter-slope-swatch"
      aria-hidden="true"
      style={{ background: SLOPE_SWATCH_BACKGROUND }}
    />
  );
}

export function FilterChipIcon({ name }: { name: string }) {
  if (ALERT_FILTER_ICONS.has(name)) {
    return (
      <span className="rvd-place-search__filter-alert-badge" aria-hidden="true">
        <img src={`/svgv2/icone/${name}`} alt="" draggable="false" />
      </span>
    );
  }
  if (MONOCHROME_FILTER_ICONS.has(name)) {
    const mask = `url(/svgv2/icone/${name}) center / contain no-repeat`;
    return (
      <span
        className="rvd-place-search__filter-marker-image"
        aria-hidden="true"
        style={{ backgroundColor: 'var(--rv-text)', WebkitMask: mask, mask }}
      />
    );
  }
  return (
    <img
      className="rvd-place-search__filter-marker-image"
      src={`/svgv2/icone/${name}`}
      alt=""
      draggable="false"
    />
  );
}
