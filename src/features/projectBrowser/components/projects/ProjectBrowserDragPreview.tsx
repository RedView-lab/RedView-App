import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

type ProjectBrowserDragPreviewProps = {
  type: 'project' | 'folder';
  label: string;
  x: number;
  y: number;
};

export function ProjectBrowserDragPreview({
  type,
  label,
  x,
  y,
}: ProjectBrowserDragPreviewProps) {
  const { t } = useAppI18n();

  return (
    <div
      className="rvpb-drag-preview"
      style={{ transform: `translate(${x}px, ${y}px)` }}
    >
      <span className="rvpb-drag-preview__tile">
        {type === 'folder' ? (
          <SvgV2Icon name="folder.svg" size={44} />
        ) : (
          <SvgV2Icon name="map-01.svg" size={44} />
        )}
      </span>
      <span className="rvpb-drag-preview__label" title={label}>
        {label}
      </span>
      <span className="rvpb-drag-preview__eyebrow">
        {type === 'folder' ? t('Dossier') : t('Projet')}
      </span>
    </div>
  );
}
