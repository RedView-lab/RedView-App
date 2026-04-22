import type { SVGProps } from 'react';
import { IconChevronDown } from './CenterPanelIcons';

type ToolbarIconProps = SVGProps<SVGSVGElement> & { size?: number };

const baseIcon = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
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
  <svg {...baseIcon(size)} {...rest}>
    <path d="M6 4.5 17.6 15l-4.3.8 1.5 4.2-2.1.8-1.5-4.2-3.1 2.9Z" />
  </svg>
);

const IconPlusCircle = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 8.2v7.6" />
    <path d="M8.2 12h7.6" />
  </svg>
);

const IconPencilLine = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M4 20h4.2l9.9-9.9a2.2 2.2 0 0 0 0-3.1l-1.1-1.1a2.2 2.2 0 0 0-3.1 0L4 15.8Z" />
    <path d="M12.8 7.2l4 4" />
  </svg>
);

const IconSwitchHorizontal = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M5 8h11" />
    <path d="m12.5 4.5 3.5 3.5-3.5 3.5" />
    <path d="M19 16H8" />
    <path d="m11.5 12.5-3.5 3.5 3.5 3.5" />
  </svg>
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
  <svg {...baseIcon(size)} {...rest}>
    <path d="M12 4v16" />
    <path d="M9.2 7.4 5 12l4.2 4.6" />
    <path d="M14.8 7.4 19 12l-4.2 4.6" />
  </svg>
);

const IconBezier = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <circle cx="6" cy="6" r="2" />
    <circle cx="18" cy="18" r="2" />
    <circle cx="18" cy="6" r="2" />
    <path d="M8 6h8" />
    <path d="M18 8v4" />
    <path d="M6 8c0 5.2 6.8 4.8 10.1 6.6" />
  </svg>
);

const IconSlashOctagon = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M9.1 3.8h5.8l5.1 5.1v6.2l-5.1 5.1H9.1L4 15.1V8.9Z" />
    <path d="M8 16 16 8" />
  </svg>
);

const IconWrench = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M14.8 6.1a4.2 4.2 0 0 0-5.5 5.3L4.6 16a2 2 0 0 0 2.8 2.8l4.7-4.7a4.2 4.2 0 0 0 5.3-5.5l-2.6 2.6-2.4-.7-.7-2.4Z" />
  </svg>
);

const IconTrash = ({ size = 14, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M4.5 7h15" />
    <path d="M9.5 4.5h5" />
    <path d="M7.2 7 8 19.2a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9L16.8 7" />
    <path d="M10 10.5v6" />
    <path d="M14 10.5v6" />
  </svg>
);

const IconSkip = ({ size = 16, direction = 'forward', ...rest }: ToolbarIconProps & { direction?: 'forward' | 'backward' }) => (
  <svg {...baseIcon(size)} {...rest}>
    {direction === 'backward' ? (
      <>
        <path d="M17 6v12" />
        <path d="m15 18-8-6 8-6Z" />
      </>
    ) : (
      <>
        <path d="M7 6v12" />
        <path d="m9 6 8 6-8 6Z" />
      </>
    )}
  </svg>
);

const IconPlay = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="m9 7 7 5-7 5Z" fill="currentColor" stroke="none" />
  </svg>
);

const IconClockRewind = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg {...baseIcon(size)} {...rest}>
    <path d="M3.5 11.5A8.5 8.5 0 1 1 6 17.7" />
    <path d="M3.7 6.8v4.7h4.7" />
    <path d="M12 8v4.5l3 1.8" />
  </svg>
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

          <button
            className="rvc-center-toolbar__button rvc-center-toolbar__button--compact-accent"
            type="button"
            aria-label="Analyser"
            title="Analyser"
          >
            <span className="rvc-center-toolbar__button-text">Analyser</span>
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