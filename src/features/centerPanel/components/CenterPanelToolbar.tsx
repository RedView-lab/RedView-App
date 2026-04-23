import type { CSSProperties } from 'react';
import { AssetIcon } from '@/components/AssetIcon';
import { IconChevronDown } from './CenterPanelIcons';

type ToolbarIconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
};

const TOOLBAR_ICON_ASSETS = {
  cursor: '/svgv2/icone/navigation-pointer-01.svg',
  plusCircle: '/svgv2/icone/plus-circle.svg',
  pencil: '/svgv2/icone/edit-05.svg',
  switchHorizontal: '/svgv2/icone/switch-horizontal-01.svg',
  reflectVertical: '/svgv2/icone/reflect-01.svg',
  bezier: '/svgv2/icone/pen-tool-plus.svg',
  slashOctagon: '/svgv2/icone/slash-octagon.svg',
  wrench: '/svgv2/icone/tool-02.svg',
  trash: '/svgv2/icone/trash-03.svg',
  skip: '/svgv2/icone/skip-forward.svg',
  clockRewind: '/svgv2/icone/clock-rewind.svg',
} as const;

function assetIconStyle(direction?: 'forward' | 'backward'): CSSProperties | undefined {
  if (direction !== 'backward') return undefined;
  return { transform: 'scaleX(-1)' };
}

const baseIcon = (size = 16) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
});

const IconUndo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M9 10H5V6" />
    <path d="M5 10l4-4" />
    <path d="M6 10h8a5 5 0 0 1 5 5v3" />
  </svg>
);

const IconRedo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M15 10h4V6" />
    <path d="M19 10l-4-4" />
    <path d="M18 10h-8a5 5 0 0 0-5 5v3" />
  </svg>
);

const IconCursor = ({ size = 18, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.cursor} size={size} {...rest} />
);

const IconPlusCircle = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.plusCircle} size={size} {...rest} />
);

const IconPencilLine = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.pencil} size={size} {...rest} />
);

const IconSwitchHorizontal = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.switchHorizontal} size={size} {...rest} />
);

const IconScissors = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <circle cx="6.5" cy="7" r="2.5" />
    <circle cx="6.5" cy="17" r="2.5" />
    <path d="M9 8.7 19 4" />
    <path d="M9 15.3 19 20" />
    <path d="M11.3 12 19 12" />
  </svg>
);

const IconReflectVertical = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.reflectVertical} size={size} {...rest} />
);

const IconBezier = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.bezier} size={size} {...rest} />
);

const IconSlashOctagon = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.slashOctagon} size={size} {...rest} />
);

const IconWrench = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.wrench} size={size} {...rest} />
);

const IconTrash = ({ size = 14, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.trash} size={size} {...rest} />
);

const IconSkip = ({ size = 16, direction = 'forward', ...rest }: ToolbarIconProps & { direction?: 'forward' | 'backward' }) => (
  <AssetIcon
    src={TOOLBAR_ICON_ASSETS.skip}
    size={size}
    style={assetIconStyle(direction)}
    {...rest}
  />
);

const IconPlay = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="m9 7 7 5-7 5Z" fill="currentColor" stroke="none" />
  </svg>
);

const IconClockRewind = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <AssetIcon src={TOOLBAR_ICON_ASSETS.clockRewind} size={size} {...rest} />
);

function ToolbarIconButton({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button className="rvc-center-toolbar__button" type="button" aria-label={label} title={label}>
      {children}
    </button>
  );
}

export function CenterPanelToolbar() {
  return (
    <section className="rvc-center-toolbar" aria-label="Barre d'outils centrale">
      <div className="rvc-center-toolbar__viewport">
        <div className="rvc-center-toolbar__track" role="toolbar" aria-label="Outils d'édition du parcours">
          <ToolbarIconButton label="Annuler">
            <IconUndo />
          </ToolbarIconButton>

          <ToolbarIconButton label="Rétablir">
            <IconRedo />
          </ToolbarIconButton>

          <div className="rvc-center-toolbar__separator" aria-hidden="true" />

          <ToolbarIconButton label="Sélection">
            <IconCursor size={18} />
          </ToolbarIconButton>

          <button className="rvc-center-toolbar__button rvc-center-toolbar__button--accent" type="button" aria-label="Ajouter" title="Ajouter">
            <IconPlusCircle />
            <span className="rvc-center-toolbar__button-text">Ajouter</span>
            <IconChevronDown size={16} />
          </button>

          <button className="rvc-center-toolbar__button rvc-center-toolbar__button--label" type="button" aria-label="Tracer" title="Tracer">
            <IconPencilLine />
            <span className="rvc-center-toolbar__button-text">Tracer</span>
          </button>

          <div className="rvc-center-toolbar__separator" aria-hidden="true" />

          <ToolbarIconButton label="Inverser">
            <IconSwitchHorizontal />
          </ToolbarIconButton>

          <ToolbarIconButton label="Découper">
            <IconScissors />
          </ToolbarIconButton>

          <ToolbarIconButton label="Symétrie">
            <IconReflectVertical />
          </ToolbarIconButton>

          <ToolbarIconButton label="Courbe de Bézier">
            <IconBezier />
          </ToolbarIconButton>

          <ToolbarIconButton label="Interdire">
            <IconSlashOctagon />
          </ToolbarIconButton>

          <ToolbarIconButton label="Outils">
            <IconWrench />
          </ToolbarIconButton>

          <ToolbarIconButton label="Supprimer">
            <IconTrash />
          </ToolbarIconButton>

          <div className="rvc-center-toolbar__spacer" aria-hidden="true" />

          <div className="rvc-center-toolbar__playback" aria-label="Lecture du parcours">
            <ToolbarIconButton label="Précédent">
              <IconSkip direction="backward" />
            </ToolbarIconButton>

            <button className="rvc-center-toolbar__button rvc-center-toolbar__button--play" type="button" aria-label="Lecture" title="Lecture">
              <IconPlay />
            </button>

            <ToolbarIconButton label="Suivant">
              <IconSkip direction="forward" />
            </ToolbarIconButton>

            <ToolbarIconButton label="Revenir au début">
              <IconClockRewind />
            </ToolbarIconButton>

            <div className="rvc-center-toolbar__metrics" aria-label="Résumé de lecture">
              <span>127.23 km</span>
              <span>02 : 48 : 59</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}