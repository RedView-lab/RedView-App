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
      style={{ transform: `translate(${x + 18}px, ${y + 18}px)` }}
    >
      <span className="rvpb-drag-preview__eyebrow">{type === 'folder' ? t('Dossier') : t('Projet')}</span>
      <span className="rvpb-drag-preview__label">{label}</span>
    </div>
  );
}