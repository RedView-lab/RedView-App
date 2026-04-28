import { useCallback, useEffect, useRef, useState } from 'react';

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
  IconTrash,
} from '@/features/itineraryPanel/components/icons';
import { SvgV2Icon } from '@/components/SvgV2Icon';

import {
  createProject,
  deleteProject,
  deleteProjectFitFiles,
  deleteProjectThumbnail,
  getProjectThumbnailUrls,
  listProjects,
  renameProject,
  type ProjectSummary,
} from '@/lib/projects';
import { readStoredSupabaseSession, supabase } from '@/lib/supabase';

import './styles.css';

interface ProjectBrowserOverlayProps {
  open: boolean;
  displayName: string;
  /** Called once a project has been opened (existing or freshly created). */
  onOpenProject: (projectId: string) => void;
  /** Close request from the user (Escape / outside click). Ignored when `canClose` is false. */
  onRequestClose: () => void;
  /** When false, the overlay refuses to close — used to force selection on first login. */
  canClose?: boolean;
}

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} à ${hh}:${mn}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes}o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}ko`;
  return `${Math.round(bytes / (1024 * 1024))}mo`;
}

function privacyLabel(p: ProjectSummary['privacy']): string {
  return p === 'public' ? 'Public' : 'Privé';
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

type OverlayTab = 'projects' | 'account' | 'subscription' | 'settings';
type SubscriptionPlanId = 'explorer' | 'proCommit' | 'proMonthly';

type SubscriptionSnapshot = {
  isSubscribed: boolean;
  status: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

type BillingContactPreference = {
  mode: 'account' | 'alternative';
  alternativeEmail: string;
};

type SubscriptionPlan = {
  id: SubscriptionPlanId;
  name: string;
  priceLabel: string;
  tags: string[];
  iconBadges: Array<{
    icon: string;
    tone: 'gold' | 'blue' | 'green' | 'gray';
  }>;
  description: string;
};

const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000';

const PLAN_PRICE_IDS: Partial<Record<SubscriptionPlanId, string>> = {
  explorer: import.meta.env.VITE_STRIPE_PRICE_ID_EXPLORER,
  proCommit: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_COMMIT,
  proMonthly: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_MONTHLY,
};

const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'explorer',
    name: 'Abonnement Explorer',
    priceLabel: '9.99€/mois',
    tags: ['Sans engagement', '-25%'],
    iconBadges: [
      { icon: 'currency-euro.svg', tone: 'gold' },
      { icon: 'layers-three-02.svg', tone: 'blue' },
    ],
    description: 'Accès léger pour consulter vos projets et préparer vos prochaines sorties.',
  },
  {
    id: 'proCommit',
    name: 'Abonnement Pro',
    priceLabel: '14.99€/mois',
    tags: ['Engagement de 6 mois', '-25%'],
    iconBadges: [
      { icon: 'currency-euro.svg', tone: 'gold' },
      { icon: 'layers-three-02.svg', tone: 'blue' },
      { icon: 'marker-pin-04.svg', tone: 'green' },
      { icon: 'clock-rewind.svg', tone: 'gray' },
    ],
    description: 'Le meilleur tarif pour un usage terrain intensif avec engagement.',
  },
  {
    id: 'proMonthly',
    name: 'Abonnement Pro',
    priceLabel: '19.99€/mois',
    tags: ['Sans engagement', '-25%'],
    iconBadges: [
      { icon: 'currency-euro.svg', tone: 'gold' },
      { icon: 'layers-three-02.svg', tone: 'blue' },
      { icon: 'marker-pin-04.svg', tone: 'green' },
      { icon: 'clock-rewind.svg', tone: 'gray' },
    ],
    description: 'Toute la stack RedView Pro avec une sortie possible à tout moment.',
  },
];

const DEFAULT_CONTACT_PREFERENCE: BillingContactPreference = {
  mode: 'account',
  alternativeEmail: '',
};

function getBillingContactStorageKey(userId: string | null | undefined): string | null {
  return userId ? `redview:billing-contact:${userId}` : null;
}

function readBillingContactPreference(userId: string | null | undefined): BillingContactPreference {
  const key = getBillingContactStorageKey(userId);
  if (!key) return DEFAULT_CONTACT_PREFERENCE;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_CONTACT_PREFERENCE;
    const parsed = JSON.parse(raw) as Partial<BillingContactPreference>;
    return {
      mode: parsed.mode === 'alternative' ? 'alternative' : 'account',
      alternativeEmail:
        typeof parsed.alternativeEmail === 'string' ? parsed.alternativeEmail : '',
    };
  } catch {
    return DEFAULT_CONTACT_PREFERENCE;
  }
}

function writeBillingContactPreference(
  userId: string | null | undefined,
  preference: BillingContactPreference,
) {
  const key = getBillingContactStorageKey(userId);
  if (!key) return;

  try {
    window.localStorage.setItem(key, JSON.stringify(preference));
  } catch {
    // Best effort only.
  }
}

function resolveActivePlanId(snapshot: SubscriptionSnapshot | null): SubscriptionPlanId {
  if (!snapshot?.isSubscribed) return 'proMonthly';

  const matchedPlan = (Object.entries(PLAN_PRICE_IDS) as Array<[SubscriptionPlanId, string | undefined]>).find(
    ([, priceId]) => priceId && snapshot.priceId === priceId,
  );

  return matchedPlan?.[0] ?? 'proMonthly';
}

function buildSubscriptionHeadline(snapshot: SubscriptionSnapshot | null): string {
  if (!snapshot?.isSubscribed) {
    return 'Aucun abonnement actif sur ce compte. Ouvrez RedView Web pour souscrire ou réactiver votre plan.';
  }

  if (snapshot.cancelAtPeriodEnd) {
    return `Votre abonnement se terminera le ${formatShortDate(snapshot.currentPeriodEnd)}.`;
  }

  if (snapshot.currentPeriodEnd) {
    return `Votre abonnement se renouvelle automatiquement le ${formatShortDate(snapshot.currentPeriodEnd)}.`;
  }

  return 'Votre abonnement RedView Pro est actif.';
}

function statusLabel(snapshot: SubscriptionSnapshot | null): string {
  if (!snapshot?.status) return 'Statut indisponible';
  if (snapshot.status === 'active') return 'Actif';
  if (snapshot.status === 'trialing') return 'Essai';
  return snapshot.status;
}

type SubscriptionPlanCardProps = {
  plan: SubscriptionPlan;
  selected: boolean;
  active: boolean;
  onSelect: (planId: SubscriptionPlanId) => void;
  ctaLabel?: string;
  ctaTone?: 'danger' | 'neutral';
  onCtaClick?: () => void;
  ctaHelper?: string;
};

function SubscriptionPlanCard({
  plan,
  selected,
  active,
  onSelect,
  ctaLabel,
  ctaTone = 'neutral',
  onCtaClick,
  ctaHelper,
}: SubscriptionPlanCardProps) {
  return (
    <article
      className={`rvpb-subscription-card${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
      onClick={() => onSelect(plan.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(plan.id);
        }
      }}
      aria-pressed={selected}
    >
      <div className="rvpb-subscription-card__top">
        <span className={`rvpb-radio${selected ? ' is-selected' : ''}`} aria-hidden="true" />
        <div className="rvpb-subscription-card__copy">
          <div className="rvpb-subscription-card__title-row">
            <strong>{plan.name}</strong>
            <span>{plan.priceLabel}</span>
          </div>
          <div className="rvpb-subscription-card__chips">
            {plan.tags.map((tag) => (
              <span key={tag} className="rvpb-chip">
                {tag}
              </span>
            ))}
            {plan.iconBadges.map((badge) => (
              <span key={`${plan.id}-${badge.icon}`} className={`rvpb-icon-chip is-${badge.tone}`}>
                <SvgV2Icon name={badge.icon} size={14} />
              </span>
            ))}
          </div>
          <p className="rvpb-subscription-card__description">{plan.description}</p>
        </div>
      </div>

      {ctaLabel ? (
        <div className="rvpb-subscription-card__footer">
          <button
            type="button"
            className={`rvpb-inline-cta${ctaTone === 'danger' ? ' is-danger' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onCtaClick?.();
            }}
          >
            {ctaLabel}
          </button>
          {ctaHelper ? <span className="rvpb-inline-note">{ctaHelper}</span> : null}
        </div>
      ) : null}
    </article>
  );
}

function PlaceholderPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="rvpb-panel-placeholder" aria-label={title}>
      <div className="rvpb-panel-placeholder__icon">
        <SvgV2Icon name="settings-04.svg" size={20} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <a href={`${LANDING_URL}/pricing`} className="rvpb-panel-placeholder__link">
        Ouvrir RedView Web
      </a>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

interface ProjectCardProps {
  project: ProjectSummary;
  thumbnailUrl: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, nextName: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  busy: boolean;
}

function ProjectCard({ project, thumbnailUrl, onOpen, onRename, onDelete, busy }: ProjectCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commitRename = async () => {
    const next = draft.trim();
    if (!next || next === project.name) {
      setRenaming(false);
      setDraft(project.name);
      return;
    }
    try {
      await onRename(project.id, next);
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    const ok = window.confirm(`Supprimer définitivement « ${project.name} » ?`);
    if (!ok) return;
    await onDelete(project.id);
  };

  return (
    <article className="rvpb-card">
      <div className="rvpb-card__header">
        <div className="rvpb-card__title-stack">
          {renaming ? (
            <input
              ref={inputRef}
              className="rvpb-card__rename-input"
              value={draft}
              autoFocus
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') {
                  setRenaming(false);
                  setDraft(project.name);
                }
              }}
            />
          ) : (
            <h3
              onDoubleClick={() => setRenaming(true)}
              title="Double-cliquer pour renommer"
            >
              {project.name}
            </h3>
          )}
          <div className="rvpb-card__meta">
            <span className="rvpb-card__badge">{privacyLabel(project.privacy)}</span>
            <span>{formatSavedAt(project.updatedAt)}</span>
            <span>{formatSize(project.sizeBytes)}</span>
          </div>
        </div>

        <div className="rvpb-card__actions">
          <button
            type="button"
            className="rvpb-icon-button"
            aria-label="Renommer le projet"
            disabled={busy}
            onClick={() => setRenaming(true)}
          >
            <IconSettingsCog size={16} />
          </button>
          <button
            type="button"
            className="rvpb-icon-button"
            aria-label="Supprimer le projet"
            disabled={busy}
            onClick={handleDelete}
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            className="rvpb-card__open"
            aria-label={`Ouvrir ${project.name}`}
            disabled={busy}
            onClick={() => onOpen(project.id)}
          >
            <IconArrowLeft size={18} />
          </button>
        </div>
      </div>

      <button
        type="button"
        className="rvpb-card__preview"
        onClick={() => onOpen(project.id)}
        disabled={busy}
        aria-label={`Entrer dans ${project.name}`}
      >
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="Aperçu de projet" />
        ) : (
          <div className="rvpb-card__preview-placeholder" aria-hidden="true" />
        )}
      </button>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

export function ProjectBrowserOverlay({
  open,
  displayName,
  onOpenProject,
  onRequestClose,
  canClose = true,
}: ProjectBrowserOverlayProps) {
  const storedSession = readStoredSupabaseSession();
  const userId = storedSession?.user.id ?? null;
  const accountEmail = storedSession?.user.email ?? '';
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [showSearch, setShowSearch] = useState(false);
  const [activeTab, setActiveTab] = useState<OverlayTab>('projects');
  const [subscriptionState, setSubscriptionState] = useState<{
    isLoading: boolean;
    error: string | null;
    snapshot: SubscriptionSnapshot | null;
  }>({
    isLoading: false,
    error: null,
    snapshot: null,
  });
  const [selectedPlanId, setSelectedPlanId] = useState<SubscriptionPlanId>('proMonthly');
  const [contactPreference, setContactPreference] = useState<BillingContactPreference>(() =>
    readBillingContactPreference(userId),
  );

  useEffect(() => {
    setContactPreference(readBillingContactPreference(userId));
  }, [userId]);

  useEffect(() => {
    writeBillingContactPreference(userId, contactPreference);
  }, [contactPreference, userId]);

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listProjects();
      setProjects(rows);
      // Fire-and-forget thumbnail resolution; failures don't block the list.
      if (rows.length > 0) {
        getProjectThumbnailUrls(rows.map((r) => r.id))
          .then((map) => setThumbnails(map))
          .catch((e) => console.warn('[ProjectBrowser] thumbnails failed', e));
      } else {
        setThumbnails({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de charger les projets.');
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load whenever the overlay opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || activeTab !== 'subscription' || !userId) return;

    let cancelled = false;
    setSubscriptionState((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
    }));

    void (async () => {
      try {
        const { data, error: nextError } = await supabase
          .from('user_subscription_status')
          .select('is_subscribed, status, price_id, current_period_end, cancel_at_period_end')
          .eq('user_id', userId)
          .maybeSingle();

        if (cancelled) return;
        if (nextError) throw nextError;

        const snapshot: SubscriptionSnapshot = {
          isSubscribed: data?.is_subscribed ?? false,
          status: data?.status ?? null,
          priceId: data?.price_id ?? null,
          currentPeriodEnd: data?.current_period_end ?? null,
          cancelAtPeriodEnd: data?.cancel_at_period_end ?? false,
        };

        setSubscriptionState({
          isLoading: false,
          error: null,
          snapshot,
        });
        setSelectedPlanId(resolveActivePlanId(snapshot));
      } catch (nextError) {
        if (cancelled) return;
        setSubscriptionState({
          isLoading: false,
          error:
            nextError instanceof Error
              ? nextError.message
              : 'Impossible de charger les informations d’abonnement.',
          snapshot: null,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab, open, userId]);

  // Escape closes — but only when allowed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canClose) onRequestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onRequestClose, canClose]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const row = await createProject();
      // Optimistic prepend so the card is visible if the user backs out.
      setProjects((prev) => [
        {
          id: row.id,
          name: row.name,
          privacy: row.privacy,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        ...prev,
      ]);
      onOpenProject(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Échec de la création du projet.');
    } finally {
      setCreating(false);
    }
  }, [creating, onOpenProject]);

  const handleRename = useCallback(
    async (id: string, nextName: string) => {
      setBusy(id, true);
      try {
        await renameProject(id, nextName);
        setProjects((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, name: nextName, updatedAt: new Date().toISOString() }
              : p,
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Échec du renommage.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(id, true);
      try {
        await deleteProject(id);
        // Best-effort thumbnail cleanup so storage doesn't fill with orphans.
        void deleteProjectFitFiles(id);
        void deleteProjectThumbnail(id);
        setProjects((prev) => prev.filter((p) => p.id !== id));
        setThumbnails((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Échec de la suppression.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;

  const lastEdited = projects[0];
  const selectedPlan = SUBSCRIPTION_PLANS.find((plan) => plan.id === selectedPlanId) ?? SUBSCRIPTION_PLANS[2];
  const activePlanId = resolveActivePlanId(subscriptionState.snapshot);
  const openSubscriptionPage = () => {
    window.open(`${LANDING_URL}/pricing`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="rvpb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Sélecteur de projet principal"
    >
      <div className="rvpb-shell">
        <header className="rvpb-header">
          <div className="rvpb-user">
            <div className="rvpb-user__name">{displayName || 'Utilisateur'}</div>
            <div className="rvpb-user__meta">
              <span className="rvpb-user__badge">Premium</span>
              <span>
                {lastEdited
                  ? `Dernière modification ${formatSavedAt(lastEdited.updatedAt)}`
                  : 'Aucun projet enregistré'}
              </span>
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
          <button
            type="button"
            className={`rvpb-top-tabs__item${activeTab === 'projects' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <IconRoute size={13.333} />
            <span>Projets</span>
          </button>
          <button
            type="button"
            className={`rvpb-top-tabs__item${activeTab === 'account' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('account')}
          >
            <IconStopwatch size={16} />
            <span>Compte</span>
          </button>
          <button
            type="button"
            className={`rvpb-top-tabs__item${activeTab === 'subscription' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('subscription')}
          >
            <SvgV2Icon name="user-circle.svg" size={16} />
            <span>Abonnement</span>
          </button>
          <button
            type="button"
            className={`rvpb-top-tabs__item${activeTab === 'settings' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <IconMapPin size={16} />
            <span>Réglages</span>
          </button>
        </nav>

        <div className="rvpb-divider" />

        {activeTab === 'projects' ? (
          <>
            <div className="rvpb-toolbar">
              <div className="rvpb-view-toggle" role="tablist" aria-label="Affichage des projets">
                <button
                  type="button"
                  className={`rvpb-view-toggle__item${view === 'grid' ? ' is-active' : ''}`}
                  aria-pressed={view === 'grid'}
                  onClick={() => setView('grid')}
                >
                  <span>Grille</span>
                  <IconLayoutGrid size={12} />
                </button>
                <button
                  type="button"
                  className={`rvpb-view-toggle__item${view === 'list' ? ' is-active' : ''}`}
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                >
                  <span>Liste</span>
                  <IconList size={16} />
                </button>
              </div>

              <div className="rvpb-toolbar__actions">
                {showSearch ? (
                  <input
                    className="rvpb-search-input"
                    autoFocus
                    placeholder="Rechercher…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onBlur={() => {
                      if (!search) setShowSearch(false);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="rvpb-square-button"
                    aria-label="Rechercher un projet"
                    onClick={() => setShowSearch(true)}
                  >
                    <IconSearch size={18} />
                  </button>
                )}
                <button type="button" className="rvpb-square-button" aria-label="Filtrer les projets">
                  <IconSettingsSliders size={18} />
                </button>
                <button
                  type="button"
                  className="rvpb-create-button"
                  onClick={handleCreate}
                  disabled={creating}
                >
                  <IconPlusCircle size={20} />
                  <span>{creating ? 'Création…' : 'Créer un projet'}</span>
                </button>
              </div>
            </div>

            {error ? (
              <div className="rvpb-error" role="alert">
                {error}
              </div>
            ) : null}

            <section
              className={`rvpb-grid-shell${view === 'list' ? ' is-list' : ''}`}
              aria-label="Liste des projets"
            >
              {loading && projects.length === 0 ? (
                <div className="rvpb-empty">Chargement…</div>
              ) : filtered.length === 0 ? (
                <div className="rvpb-empty">
                  {q
                    ? 'Aucun projet ne correspond à votre recherche.'
                    : 'Vous n’avez pas encore de projet. Cliquez sur « Créer un projet » pour commencer.'}
                </div>
              ) : (
                filtered.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    thumbnailUrl={thumbnails[p.id] ?? null}
                    busy={busyIds.has(p.id)}
                    onOpen={onOpenProject}
                    onRename={handleRename}
                    onDelete={handleDelete}
                  />
                ))
              )}
            </section>
          </>
        ) : null}

        {activeTab === 'subscription' ? (
          <section className="rvpb-subscription-panel" aria-label="Gestion de l’abonnement">
            {subscriptionState.error ? (
              <div className="rvpb-error" role="alert">
                {subscriptionState.error}
              </div>
            ) : null}

            <div className="rvpb-subscription-section">
              <div className="rvpb-subscription-section__label">
                <h2>Abonnement actuel</h2>
                <p>
                  {subscriptionState.isLoading
                    ? 'Chargement de votre état d’abonnement…'
                    : buildSubscriptionHeadline(subscriptionState.snapshot)}
                </p>
              </div>

              <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
                {SUBSCRIPTION_PLANS.map((plan) => {
                  const isActivePlan = subscriptionState.snapshot?.isSubscribed && activePlanId === plan.id;
                  const isSelectedPlan = selectedPlan.id === plan.id;

                  return (
                    <SubscriptionPlanCard
                      key={plan.id}
                      plan={plan}
                      selected={isSelectedPlan}
                      active={Boolean(isActivePlan)}
                      onSelect={setSelectedPlanId}
                      ctaLabel={
                        isActivePlan
                          ? subscriptionState.snapshot?.cancelAtPeriodEnd
                            ? 'Gérer'
                            : 'Interrompre'
                          : isSelectedPlan
                            ? 'Choisir sur RedView Web'
                            : undefined
                      }
                      ctaTone={isActivePlan ? 'danger' : 'neutral'}
                      onCtaClick={openSubscriptionPage}
                      ctaHelper={
                        isActivePlan
                          ? subscriptionState.snapshot?.cancelAtPeriodEnd
                            ? `Fin prévue le ${formatShortDate(subscriptionState.snapshot.currentPeriodEnd)}.`
                            : `Statut ${statusLabel(subscriptionState.snapshot).toLowerCase()}.`
                          : isSelectedPlan
                            ? 'Le changement de plan se fait depuis la page d’abonnement RedView Web.'
                            : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>

            <div className="rvpb-divider" />

            <div className="rvpb-subscription-section">
              <div className="rvpb-subscription-section__label">
                <h2>Informations de paiement</h2>
              </div>

              <div className="rvpb-subscription-section__content">
                <div className="rvpb-payment-card">
                  <div className="rvpb-payment-card__icon">
                    <SvgV2Icon name="credit-card-02.svg" size={18} />
                  </div>
                  <div className="rvpb-payment-card__copy">
                    <strong>Facturation gérée dans Stripe</strong>
                    <span>
                      Ouvrez le portail sécurisé pour ajouter ou modifier votre moyen de paiement.
                    </span>
                    <div className="rvpb-link-row">
                      <button type="button" className="rvpb-text-link" onClick={openSubscriptionPage}>
                        Ouvrir la page d’abonnement
                      </button>
                    </div>
                  </div>
                </div>

                <button type="button" className="rvpb-add-row" onClick={openSubscriptionPage}>
                  <SvgV2Icon name="plus.svg" size={16} />
                  <span>Ajouter ou modifier un moyen de paiement</span>
                </button>
              </div>
            </div>

            <div className="rvpb-divider" />

            <div className="rvpb-subscription-section">
              <div className="rvpb-subscription-section__label">
                <h2>E-mail de contact</h2>
              </div>

              <div className="rvpb-subscription-section__content rvpb-subscription-section__content--stacked">
                <label className="rvpb-contact-option">
                  <input
                    type="radio"
                    name="billing-contact"
                    checked={contactPreference.mode === 'account'}
                    onChange={() =>
                      setContactPreference((prev) => ({
                        ...prev,
                        mode: 'account',
                      }))
                    }
                  />
                  <span className="rvpb-radio-faux" aria-hidden="true" />
                  <span className="rvpb-contact-option__copy">
                    <strong>Envoyer sur mon e-mail de compte</strong>
                    <span>{accountEmail || 'Adresse indisponible'}</span>
                  </span>
                </label>

                <div className="rvpb-contact-group">
                  <label className="rvpb-contact-option">
                    <input
                      type="radio"
                      name="billing-contact"
                      checked={contactPreference.mode === 'alternative'}
                      onChange={() =>
                        setContactPreference((prev) => ({
                          ...prev,
                          mode: 'alternative',
                        }))
                      }
                    />
                    <span className="rvpb-radio-faux" aria-hidden="true" />
                    <span className="rvpb-contact-option__copy">
                      <strong>Envoyer sur un e-mail alternatif</strong>
                    </span>
                  </label>

                  <label className="rvpb-input-wrap">
                    <span className="rvpb-input-icon">
                      <SvgV2Icon name="mail-02.svg" size={16} />
                    </span>
                    <input
                      type="email"
                      value={contactPreference.alternativeEmail}
                      placeholder="billing@votre-domaine.com"
                      onChange={(event) =>
                        setContactPreference({
                          mode: 'alternative',
                          alternativeEmail: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'account' ? (
          <PlaceholderPanel
            title="Compte"
            description="La vue compte n’est pas encore branchée dans cette overlay. La section Abonnement est désormais disponible et la gestion Stripe reste centralisée sur RedView Web."
          />
        ) : null}

        {activeTab === 'settings' ? (
          <PlaceholderPanel
            title="Réglages"
            description="Les réglages globaux de ce tableau de bord restent à connecter. Le shell Figma est désormais prêt à accueillir cette page sans toucher à la grille projets."
          />
        ) : null}
      </div>
    </div>
  );
}
