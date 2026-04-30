import type { AssetIconProps } from '@/shared/components/AssetIcon';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

/** Figma I1710:47397;1710:47194 — chevron-left, 20×20 viewBox bounds. */
export const IconChevronLeft = ({ size = 20, ...p }: AssetIconProps) => (
  <SvgV2Icon name="chevron-left.svg" size={size} {...p} />
);

/** Figma I1710:47397;1710:47196 — chevron-right. */
export const IconChevronRight = ({ size = 20, ...p }: AssetIconProps) => (
  <SvgV2Icon name="chevron-right.svg" size={size} {...p} />
);
