import { useAppI18n } from '@/shared/i18n';

interface ComingSoonProps {
  title: string;
  description?: string;
}

export function ComingSoonSection({ title, description }: ComingSoonProps) {
  const { t } = useAppI18n();
  return (
    <div className="rvi-params">
      <div className="rvi-divider" />
      <h3 className="rvi-section-title">{t(title)}</h3>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.6, fontWeight: 500 }}>
        {description ? t(description) : t('Bientôt disponible.')}
      </p>
    </div>
  );
}
