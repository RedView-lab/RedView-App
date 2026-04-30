import type { CSSProperties } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

type ToolbarIconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
};

const TOOLBAR_ICON_ASSETS = {
  cursor: 'navigation-pointer-01.svg',
  plusCircle: 'plus-circle.svg',
  pencil: 'edit-05.svg',
  switchHorizontal: 'switch-horizontal-01.svg',
  reflectVertical: 'reflect-01.svg',
  bezier: 'pen-tool-plus.svg',
  slashOctagon: 'slash-octagon.svg',
  wrench: 'tool-02.svg',
  trash: 'trash-03.svg',
  skip: 'skip-forward.svg',
  clockRewind: 'clock-rewind.svg',
} as const;

function assetIconStyle(direction?: 'forward' | 'backward'): CSSProperties | undefined {
  if (direction !== 'backward') return undefined;
  return { transform: 'scaleX(-1)' };
}

export const IconUndo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="corner-up-left.svg" size={size} {...rest} />
);

export const IconRedo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="corner-up-right.svg" size={size} {...rest} />
);

export const IconCursor = ({ size = 18, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.cursor} size={size} {...rest} />
);

export const IconPlusCircle = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.plusCircle} size={size} {...rest} />
);

export const IconPencilLine = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.pencil} size={size} {...rest} />
);

export const IconSwitchHorizontal = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.switchHorizontal} size={size} {...rest} />
);

export const IconScissors = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="scissors.svg" size={size} {...rest} />
);

export const IconReflectVertical = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.reflectVertical} size={size} {...rest} />
);

export const IconBezier = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.bezier} size={size} {...rest} />
);

export const IconSlashOctagon = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.slashOctagon} size={size} {...rest} />
);

export const IconWrench = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.wrench} size={size} {...rest} />
);

export const IconTrash = ({ size = 14, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.trash} size={size} {...rest} />
);

export const IconSkip = ({
  size = 16,
  direction = 'forward',
  ...rest
}: ToolbarIconProps & { direction?: 'forward' | 'backward' }) => (
  <SvgV2Icon
    name={TOOLBAR_ICON_ASSETS.skip}
    size={size}
    style={assetIconStyle(direction)}
    {...rest}
  />
);

export const IconPlay = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="play.svg" size={size} {...rest} />
);

export const IconPause = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...rest}
  >
    <rect x="4.25" y="3" width="2.5" height="10" rx="0.9" fill="currentColor" />
    <rect x="9.25" y="3" width="2.5" height="10" rx="0.9" fill="currentColor" />
  </svg>
);

export const IconClockRewind = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.clockRewind} size={size} {...rest} />
);