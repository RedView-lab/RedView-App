import { useAppI18n } from '@/shared/i18n';
import { MenuActionRow } from './MenuActionRow';
import {
  FinishGlyph,
  PoiPinGlyph,
  StartGlyph,
  TrashGlyph,
  WaypointGlyph,
} from './icons';
import type { MapContextMenuActionId } from './types';

interface MapContextMenuActionsProps {
  onAction: (actionId: MapContextMenuActionId) => void;
  hasForbiddenZone?: boolean;
  hasStartPoint?: boolean;
}

export function MapContextMenuActions({
  onAction,
  hasForbiddenZone,
  hasStartPoint = false,
}: MapContextMenuActionsProps) {
  const { t } = useAppI18n();

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0 }}>
      <MenuActionRow
        label={t('Créer un POI')}
        icon={<PoiPinGlyph />}
        onClick={() => onAction('create-poi')}
      />
      <MenuActionRow
        label={t('Démarrer ici')}
        icon={<StartGlyph />}
        onClick={() => onAction('set-start')}
      />
      {hasStartPoint ? (
        <>
          <MenuActionRow
            label={t('Ajouter une étape')}
            icon={<WaypointGlyph />}
            onClick={() => onAction('add-waypoint')}
          />
          <MenuActionRow
            label={t('Finir ici')}
            icon={<FinishGlyph />}
            onClick={() => onAction('set-finish')}
          />
        </>
      ) : null}
      {hasForbiddenZone ? (
        <MenuActionRow
          label={t('Supprimer la zone interdite')}
          icon={<TrashGlyph />}
          onClick={() => onAction('delete-forbidden-zone')}
        />
      ) : null}
    </div>
  );
}
