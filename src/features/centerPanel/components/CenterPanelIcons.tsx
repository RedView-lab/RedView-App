import type { AssetIconProps } from '@/shared/components/AssetIcon';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import {
  IconCheck,
  IconChevronDown,
  IconEye,
} from '@/features/controlPanel/icons';
import { IconSettingsSliders } from '@/features/itineraryPanel/components/icons';

export { IconCheck, IconChevronDown, IconEye, IconSettingsSliders };

export const IconDotsVertical = ({ size = 16, ...rest }: AssetIconProps) => (
  <SvgV2Icon name="dots-vertical.svg" size={size} {...rest} />
);

export const IconSun = ({ size = 14, ...rest }: AssetIconProps) => (
  <SvgV2Icon name="sun.svg" size={size} {...rest} />
);

export const IconMoon = ({ size = 14, ...rest }: AssetIconProps) => (
  <SvgV2Icon name="moon.svg" size={size} {...rest} />
);
