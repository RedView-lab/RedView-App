import type { CSSProperties } from 'react';
import { SvgV2Icon } from '@/components/SvgV2Icon';
import { IconChevronDown } from './CenterPanelIcons';
import { useAnalysisFlyover } from '../flyover';

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

const IconUndo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="corner-up-left.svg" size={size} {...rest} />
);

const IconRedo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="corner-up-right.svg" size={size} {...rest} />
);

const IconCursor = ({ size = 18, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.cursor} size={size} {...rest} />
);

const IconPlusCircle = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.plusCircle} size={size} {...rest} />
);

const IconPencilLine = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.pencil} size={size} {...rest} />
);

const IconSwitchHorizontal = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.switchHorizontal} size={size} {...rest} />
);

const IconScissors = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="scissors.svg" size={size} {...rest} />
);

const IconReflectVertical = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.reflectVertical} size={size} {...rest} />
);

const IconBezier = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.bezier} size={size} {...rest} />
);

const IconSlashOctagon = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.slashOctagon} size={size} {...rest} />
);

const IconWrench = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.wrench} size={size} {...rest} />
);

const IconTrash = ({ size = 14, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.trash} size={size} {...rest} />
);

const IconSkip = ({ size = 16, direction = 'forward', ...rest }: ToolbarIconProps & { direction?: 'forward' | 'backward' }) => (
  <SvgV2Icon
    name={TOOLBAR_ICON_ASSETS.skip}
    size={size}
    style={assetIconStyle(direction)}
    {...rest}
  />
);

const IconPlay = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="play.svg" size={size} {...rest} />
);

const IconPause = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...rest}
  >
    <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
    <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
  </svg>
);

const IconClockRewind = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.clockRewind} size={size} {...rest} />
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
  const {
    canPlay,
    canSlowDown,
    canSpeedUp,
    distanceLabel,
    isPlaying,
    resetPlayback,
    slowDown,
    speedUp,
    timeLabel,
    togglePlayback,
  } = useAnalysisFlyover();

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
            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Ralentir le flyover"
              title="Ralentir le flyover"
              onClick={slowDown}
              disabled={!canPlay || !canSlowDown}
            >
              <IconSkip direction="backward" />
            </button>

            <button
              className={
                isPlaying
                  ? 'rvc-center-toolbar__button rvc-center-toolbar__button--play rvc-center-toolbar__button--play-active'
                  : 'rvc-center-toolbar__button rvc-center-toolbar__button--play'
              }
              type="button"
              aria-label={isPlaying ? 'Mettre en pause le flyover' : 'Lancer le flyover'}
              title={isPlaying ? 'Mettre en pause le flyover' : 'Lancer le flyover'}
              aria-pressed={isPlaying}
              onClick={togglePlayback}
              disabled={!canPlay}
            >
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Accélérer le flyover"
              title="Accélérer le flyover"
              onClick={speedUp}
              disabled={!canPlay || !canSpeedUp}
            >
              <IconSkip direction="forward" />
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Revenir au début du flyover"
              title="Revenir au début du flyover"
              onClick={resetPlayback}
              disabled={!canPlay}
            >
              <IconClockRewind />
            </button>

            <div className="rvc-center-toolbar__metrics" aria-label="Résumé de lecture">
              <span>{distanceLabel}</span>
              <span>{timeLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}