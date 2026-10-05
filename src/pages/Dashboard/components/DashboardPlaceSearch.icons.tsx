import { getPoiIconUrl } from '@/features/poi/lib/poi-icons';
import type { PoiCategory } from '@/features/poi/types';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import type { DashboardPoiOption } from './DashboardPlaceSearch.types';

export function SearchIcon() {
  return <SvgV2Icon name="search-sm.svg" size={20} />;
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

export function FilterChipIcon({ name }: { name: string }) {
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
