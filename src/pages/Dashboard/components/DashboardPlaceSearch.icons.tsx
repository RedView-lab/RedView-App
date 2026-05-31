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

export function PoiTriggerIcon() {
  return <SvgV2Icon name="poi-pin.svg" size={20} />;
}