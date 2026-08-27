import { useMemo } from 'react';
import { POI_CATEGORIES, POI_LABELS, type PoiCategory } from '@/features/poi/types';
import { Select } from '@/features/controlPanel/components/Select';
import { useAppI18n } from '@/shared/i18n';

interface CategorySelectorProps {
  category: PoiCategory | null | undefined;
  onChange: (category: PoiCategory) => void;
  metadataColor: string;
}

export function CategorySelector({
  category,
  onChange,
  metadataColor,
}: CategorySelectorProps) {
  const { t } = useAppI18n();

  const categoryOptions = useMemo(() => {
    return POI_CATEGORIES.map((cat) => ({
      value: cat,
      label: POI_LABELS[cat],
    }));
  }, []);

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 6, width: '100%' }}>
      <span
        style={{
          flex: '0 0 auto',
          fontSize: 12,
          fontWeight: 500,
          lineHeight: 'normal',
          color: metadataColor,
        }}
      >
        POI
      </span>

      <div style={{ minWidth: 0, flex: '1 1 0', pointerEvents: 'auto' }}>
        <Select
          value={category ?? ''}
          options={categoryOptions}
          onChange={(nextVal) => {
            if (nextVal) onChange(nextVal as PoiCategory);
          }}
          placeholder={t('Sélectionner')}
          width="100%"
        />
      </div>
    </div>
  );
}
