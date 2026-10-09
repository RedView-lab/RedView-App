import { useId } from 'react';

import { NewTabHint } from '@/shared/components/NewTabHint';
import { useAppI18n } from '@/shared/i18n';
import { DATA_SOURCE_GROUPS } from '../lib/dataSources';

/** Écrit au build par Vite (`build.license` de vite.config.ts) : licences des dépendances du bundle. */
const THIRD_PARTY_LICENSES_URL = '/third-party-licenses.txt';

/** « Sources des données » : attributions et licences des données et services tiers. */
export function DataSourcesSection() {
  const { t } = useAppI18n();
  const titleId = useId();

  return (
    <section className="rvpb-settings-sources" aria-labelledby={titleId}>
      <h2 id={titleId} className="rvpb-settings-sources__title">
        {t('Sources des données')}
      </h2>
      <p className="rvpb-settings-sources__intro">
        {t('RedView s’appuie sur des données ouvertes et des services tiers. Merci à celles et ceux qui les produisent.')}
      </p>
      {DATA_SOURCE_GROUPS.map((group) => (
        <div key={group.title} className="rvpb-settings-sources__group">
          <h3 className="rvpb-settings-sources__group-title">{t(group.title)}</h3>
          <ul className="rvpb-settings-sources__list">
            {group.sources.map((source) => (
              <li key={source.name} className="rvpb-settings-sources__item">
                <div className="rvpb-settings-sources__text">
                  <span className="rvpb-settings-sources__name">{source.name}</span>
                  <span className="rvpb-settings-sources__description">{t(source.description)}</span>
                </div>
                <a className="rvpb-settings-sources__license" href={source.href} target="_blank" rel="noreferrer">
                  {t(source.licenseLabel)}
                  <NewTabHint />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <a className="rvpb-settings-sources__software" href={THIRD_PARTY_LICENSES_URL} target="_blank" rel="noreferrer">
        {t('Licences des bibliothèques logicielles incluses dans RedView')}
        <NewTabHint />
      </a>
    </section>
  );
}
