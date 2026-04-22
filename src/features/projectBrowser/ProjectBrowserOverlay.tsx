import { useEffect } from 'react';

import {
  IconArrowLeft,
  IconDownload,
  IconLayoutGrid,
  IconList,
  IconMapPin,
  IconPlusCircle,
  IconRoute,
  IconSearch,
  IconSettingsCog,
  IconSettingsSliders,
  IconShare,
  IconStopwatch,
} from '@/features/itineraryPanel/components/icons';

import {
  PROJECT_BROWSER_CARDS,
  PROJECT_BROWSER_PREVIEW_URL,
  type ProjectBrowserCard,
} from './projectBrowserData';
import './styles.css';

interface ProjectBrowserOverlayProps {
  open: boolean;
  displayName: string;
  onOpenProject: (projectId: string) => void;
  onRequestClose: () => void;
}

function ProjectCard({
  card,
  onOpen,
}: {
  card: ProjectBrowserCard;
  onOpen: (projectId: string) => void;
}) {
  return (
    <article className="rvpb-card">
      <div className="rvpb-card__header">
        <div className="rvpb-card__title-stack">
          <h3>{card.title}</h3>
          <div className="rvpb-card__meta">
            <span className="rvpb-card__badge">{card.privacyLabel}</span>
            <span>{card.savedAt}</span>
            <span>{card.sizeLabel}</span>
          </div>
        </div>

        {card.featured ? (
          <div className="rvpb-card__actions">
            <button type="button" className="rvpb-icon-button" aria-label="Paramètres du projet">
              <IconSettingsCog size={16} />
            </button>
            <button type="button" className="rvpb-icon-button" aria-label="Télécharger le projet">
              <IconDownload size={16} />
            </button>
            <button type="button" className="rvpb-icon-button" aria-label="Partager le projet">
              <IconShare size={16} />
            </button>
            <button
              type="button"
              className="rvpb-card__open"
              aria-label={`Ouvrir ${card.title}`}
              onClick={() => onOpen(card.id)}
            >
              <IconArrowLeft size={18} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rvpb-card__open"
            aria-label={`Ouvrir ${card.title}`}
            onClick={() => onOpen(card.id)}
          >
            <IconArrowLeft size={18} />
          </button>
        )}
      </div>

      <button
        type="button"
        className="rvpb-card__preview"
        onClick={() => onOpen(card.id)}
        aria-label={`Entrer dans ${card.title}`}
      >
        <img src={PROJECT_BROWSER_PREVIEW_URL} alt="Aperçu de projet montagne" />
      </button>
    </article>
  );
}

export function ProjectBrowserOverlay({
  open,
  displayName,
  onOpenProject,
  onRequestClose,
}: ProjectBrowserOverlayProps) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRequestClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onRequestClose]);

  if (!open) return null;

  return (
    <div className="rvpb-overlay" role="dialog" aria-modal="true" aria-label="Sélecteur de projet principal">
      <div className="rvpb-shell">
        <header className="rvpb-header">
          <div className="rvpb-user">
            <div className="rvpb-user__name">{displayName || 'Utilisateur'}</div>
            <div className="rvpb-user__meta">
              <span className="rvpb-user__badge">Premium</span>
              <span>Dernière modification 09/04/2026</span>
            </div>
          </div>

          <div className="rvpb-header__actions">
            <button type="button" className="rvpb-icon-button" aria-label="Paramètres du compte">
              <IconSettingsCog size={16} />
            </button>
            <button type="button" className="rvpb-icon-button" aria-label="Télécharger vos projets">
              <IconDownload size={16} />
            </button>
            <button type="button" className="rvpb-icon-button" aria-label="Partager">
              <IconShare size={16} />
            </button>
          </div>
        </header>

        <div className="rvpb-divider" />

        <nav className="rvpb-top-tabs" aria-label="Navigation principale du menu projet">
          <button type="button" className="rvpb-top-tabs__item is-active">
            <IconRoute size={13.333} />
            <span>Projets</span>
          </button>
          <button type="button" className="rvpb-top-tabs__item">
            <IconStopwatch size={16} />
            <span>Compte</span>
          </button>
          <button type="button" className="rvpb-top-tabs__item">
            <IconMapPin size={16} />
            <span>Réglages</span>
          </button>
        </nav>

        <div className="rvpb-divider" />

        <div className="rvpb-toolbar">
          <div className="rvpb-view-toggle" role="tablist" aria-label="Affichage des projets">
            <button type="button" className="rvpb-view-toggle__item is-active" aria-pressed="true">
              <span>Grille</span>
              <IconLayoutGrid size={12} />
            </button>
            <button type="button" className="rvpb-view-toggle__item" aria-pressed="false">
              <span>Liste</span>
              <IconList size={16} />
            </button>
          </div>

          <div className="rvpb-toolbar__actions">
            <button type="button" className="rvpb-square-button" aria-label="Rechercher un projet">
              <IconSearch size={18} />
            </button>
            <button type="button" className="rvpb-square-button" aria-label="Filtrer les projets">
              <IconSettingsSliders size={18} />
            </button>
            <button type="button" className="rvpb-create-button">
              <IconPlusCircle size={20} />
              <span>Créer un projet</span>
            </button>
          </div>
        </div>

        <section className="rvpb-grid-shell" aria-label="Liste des projets">
          {PROJECT_BROWSER_CARDS.map((card) => (
            <ProjectCard key={card.id} card={card} onOpen={onOpenProject} />
          ))}
        </section>
      </div>
    </div>
  );
}