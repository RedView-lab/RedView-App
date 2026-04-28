import { useCallback, useEffect, useState } from 'react';

import { SvgV2Icon } from '@/components/SvgV2Icon';
import {
  IconDownload,
  IconSettingsCog,
  IconShare,
} from '@/features/itineraryPanel/components/icons';
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

import { AccountPanel } from './account/AccountPanel';
import {
  formatAccountDisplayName,
  formatLastConnection,
  loadAccountProfile,
  signOutAccount,
} from './account/profile';
import type { AccountProfile } from './account/types';
import { PlaceholderPanel } from './PlaceholderPanel';
import { ProjectsPanel } from './ProjectsPanel';
import { SubscriptionPanel } from './SubscriptionPanel';
import {
  accountTierLabel,
  LANDING_URL,
  readBillingContactPreference,
  resolveActivePlanId,
  writeBillingContactPreference,
} from './subscription';
import { TopTabs } from './TopTabs';
import type {
  BillingContactPreference,
  ProjectBrowserOverlayProps,
  OverlayTab,
  SubscriptionPlanId,
  SubscriptionSnapshot,
  SubscriptionState,
} from './types';
import { formatSavedAt } from './utils';

import './styles.css';

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
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>({
    isLoading: false,
    error: null,
    snapshot: null,
  });
  const [accountProfile, setAccountProfile] = useState<AccountProfile | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
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
      if (rows.length > 0) {
        getProjectThumbnailUrls(rows.map((row) => row.id))
          .then((map) => setThumbnails(map))
          .catch((nextError) => console.warn('[ProjectBrowser] thumbnails failed', nextError));
      } else {
        setThumbnails({});
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Impossible de charger les projets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !userId) return;

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
          status: data?.status ?? 'demo',
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
  }, [open, userId]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setAccountLoading(true);
    setAccountError(null);

    void (async () => {
      try {
        const nextProfile = await loadAccountProfile(accountEmail, displayName);
        if (cancelled) return;
        setAccountProfile(nextProfile);
        setAccountLoading(false);
      } catch (nextError) {
        if (cancelled) return;
        setAccountLoading(false);
        setAccountError(
          nextError instanceof Error
            ? nextError.message
            : 'Impossible de charger les informations du compte.',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, accountEmail, displayName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && canClose) onRequestClose();
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
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Échec de la création du projet.');
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
          prev.map((project) =>
            project.id === id
              ? { ...project, name: nextName, updatedAt: new Date().toISOString() }
              : project,
          ),
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Échec du renommage.');
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
        void deleteProjectFitFiles(id);
        void deleteProjectThumbnail(id);
        setProjects((prev) => prev.filter((project) => project.id !== id));
        setThumbnails((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Échec de la suppression.');
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;

    setIsSigningOut(true);
    try {
      await signOutAccount();
      window.location.reload();
    } catch (nextError) {
      console.warn('[ProjectBrowserOverlay] Failed to sign out', nextError);
      setAccountError(
        nextError instanceof Error ? nextError.message : 'Impossible de se déconnecter.',
      );
      setIsSigningOut(false);
    }
  }, [isSigningOut]);

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? projects.filter((project) => project.name.toLowerCase().includes(q))
    : projects;

  const lastEdited = projects[0];
  const openSubscriptionPage = () => {
    window.open(`${LANDING_URL}/pricing`, '_blank', 'noopener,noreferrer');
  };
  const accountDisplayName = accountProfile
    ? formatAccountDisplayName(accountProfile, displayName)
    : displayName || 'Utilisateur';
  const headerMetaLabel =
    activeTab === 'account'
      ? accountLoading
        ? 'Chargement du compte...'
        : formatLastConnection(accountProfile?.lastSignInAt ?? null)
      : lastEdited
        ? `Dernière modification ${formatSavedAt(lastEdited.updatedAt)}`
        : 'Aucun projet enregistré';

  return (
    <div
      className="rvpb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Sélecteur de projet principal"
    >
      <div className={`rvpb-shell${activeTab === 'account' ? ' is-account-tab' : ''}`}>
        <header className="rvpb-header">
          <div className="rvpb-user">
            <div className="rvpb-user__name">{accountDisplayName}</div>
            <div className="rvpb-user__meta">
              <span className="rvpb-user__badge">
                {accountTierLabel(subscriptionState.snapshot, subscriptionState.isLoading)}
              </span>
              <span>{headerMetaLabel}</span>
            </div>
          </div>

          {activeTab === 'account' ? (
            <button type="button" className="rvpb-logout-button" onClick={() => void handleSignOut()}>
              <SvgV2Icon name="switch-horizontal-01.svg" size={16} />
              <span>{isSigningOut ? 'Déconnexion...' : 'Se déconnecter'}</span>
            </button>
          ) : (
            <div className="rvpb-header__actions">
              <button type="button" className="rvpb-icon-button" aria-label="Paramètres du compte">
                <IconSettingsCog size={16} />
              </button>
              <button
                type="button"
                className="rvpb-icon-button"
                aria-label="Télécharger vos projets"
              >
                <IconDownload size={16} />
              </button>
              <button type="button" className="rvpb-icon-button" aria-label="Partager">
                <IconShare size={16} />
              </button>
            </div>
          )}
        </header>

        <div className="rvpb-divider" />

        <TopTabs activeTab={activeTab} onChange={setActiveTab} />

        <div className="rvpb-divider" />

        {activeTab === 'projects' ? (
          <ProjectsPanel
            view={view}
            setView={setView}
            showSearch={showSearch}
            setShowSearch={setShowSearch}
            search={search}
            setSearch={setSearch}
            handleCreate={handleCreate}
            creating={creating}
            error={error}
            loading={loading}
            q={q}
            filtered={filtered}
            thumbnails={thumbnails}
            busyIds={busyIds}
            onOpenProject={onOpenProject}
            handleRename={handleRename}
            handleDelete={handleDelete}
          />
        ) : null}

        {activeTab === 'subscription' ? (
          <SubscriptionPanel
            subscriptionState={subscriptionState}
            selectedPlanId={selectedPlanId}
            setSelectedPlanId={setSelectedPlanId}
            contactPreference={contactPreference}
            setContactPreference={setContactPreference}
            accountEmail={accountEmail}
            openSubscriptionPage={openSubscriptionPage}
          />
        ) : null}

        {activeTab === 'account' ? (
          <AccountPanel
            profile={accountProfile}
            isLoading={accountLoading}
            error={accountError}
            fallbackDisplayName={displayName}
            onProfileUpdated={(nextProfile) => {
              setAccountProfile(nextProfile);
              setAccountError(null);
            }}
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