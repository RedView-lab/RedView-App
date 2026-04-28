import { useCallback, useEffect, useRef, useState } from 'react';

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
import { readStoredSupabaseSession } from '@/lib/supabase';

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
import {
  BillingActionModal,
  type BillingModalCompletion,
  type BillingModalState,
} from './BillingActionModal';
import { SubscriptionPanel } from './SubscriptionPanel';
import {
  accountTierLabel,
  hasPaidSubscription,
  readBillingContactPreference,
  resolveActivePlanId,
  writeBillingContactPreference,
} from './subscription';
import {
  applyPaymentMethodSetup,
  cancelManagedSubscription,
  changeSubscriptionPlan,
  createPaymentMethodSetupIntent,
  createSubscriptionIntent,
  fetchBillingOverview,
  persistBillingContactPreference,
  resumeManagedSubscription,
  syncManagedSubscription,
  type BillingOverviewResponse,
} from './billingApi';
import { TopTabs } from './TopTabs';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  ProjectBrowserOverlayProps,
  OverlayTab,
  SubscriptionPlanId,
  SubscriptionState,
} from './types';
import { formatSavedAt } from './utils';

import './styles.css';

type ManagedPlanId = Exclude<SubscriptionPlanId, 'demo'>;

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
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodSummary | null>(null);
  const [billingActionBusy, setBillingActionBusy] = useState(false);
  const [billingActionError, setBillingActionError] = useState<string | null>(null);
  const [billingModal, setBillingModal] = useState<BillingModalState | null>(null);
  const [contactStatusMessage, setContactStatusMessage] = useState<string | null>(null);
  const syncedContactPreferenceRef = useRef<string | null>(null);
  const contactHydratedRef = useRef(false);

  useEffect(() => {
    setContactPreference(readBillingContactPreference(userId));
    syncedContactPreferenceRef.current = null;
    contactHydratedRef.current = false;
  }, [userId]);

  useEffect(() => {
    writeBillingContactPreference(userId, contactPreference);
  }, [contactPreference, userId]);

  useEffect(() => {
    if (!open || !userId || !contactHydratedRef.current) return;

    const serialized = JSON.stringify(contactPreference);
    if (syncedContactPreferenceRef.current === serialized) {
      return;
    }

    setContactStatusMessage('Enregistrement de votre e-mail de facturation…');
    const timeout = window.setTimeout(() => {
      void persistBillingContactPreference(contactPreference)
        .then((nextPreference) => {
          syncedContactPreferenceRef.current = JSON.stringify(nextPreference);
          setContactPreference(nextPreference);
          setContactStatusMessage('E-mail de facturation enregistré.');
        })
        .catch((nextError) => {
          setContactStatusMessage(
            nextError instanceof Error
              ? nextError.message
              : 'Impossible d’enregistrer l’e-mail de facturation.',
          );
        });
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [contactPreference, open, userId]);

  const applyBillingOverview = useCallback((overview: BillingOverviewResponse) => {
    setSubscriptionState({
      isLoading: false,
      error: null,
      snapshot: overview.subscription,
    });
    setSelectedPlanId(resolveActivePlanId(overview.subscription));
    setPaymentMethod(overview.paymentMethod);
    setContactPreference(overview.contactPreference);
    syncedContactPreferenceRef.current = JSON.stringify(overview.contactPreference);
    contactHydratedRef.current = true;
    setContactStatusMessage(null);
    setBillingActionError(null);
  }, []);

  const refreshBillingOverview = useCallback(async () => {
    const overview = await fetchBillingOverview();
    applyBillingOverview(overview);
  }, [applyBillingOverview]);

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
        const overview = await fetchBillingOverview();

        if (cancelled) return;

        applyBillingOverview(overview);
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
        setPaymentMethod(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyBillingOverview, open, userId]);

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
  const handlePlanSelection = useCallback(
    async (requestedPlanId: ManagedPlanId) => {
      setBillingActionBusy(true);
      setBillingActionError(null);

      try {
        const result = hasPaidSubscription(subscriptionState.snapshot)
          ? await changeSubscriptionPlan(requestedPlanId)
          : await createSubscriptionIntent(requestedPlanId);

        if (result.requiresPaymentConfirmation && result.clientSecret) {
          setBillingModal({
            mode: 'subscription',
            clientSecret: result.clientSecret,
            subscriptionId: result.subscriptionId,
            planId: requestedPlanId,
            title: hasPaidSubscription(subscriptionState.snapshot)
              ? 'Confirmer le changement de plan'
              : 'Finaliser votre abonnement',
            description: hasPaidSubscription(subscriptionState.snapshot)
              ? 'Validez ici le paiement ou le prorata éventuel sans quitter RedView.'
              : 'Saisissez votre moyen de paiement Stripe directement dans RedView pour activer cette offre.',
            submitLabel: hasPaidSubscription(subscriptionState.snapshot)
              ? 'Confirmer le changement'
              : 'Activer l’abonnement',
          });
          return;
        }

        await refreshBillingOverview();
      } catch (nextError) {
        setBillingActionError(
          nextError instanceof Error
            ? nextError.message
            : 'Impossible de lancer cette action de facturation.',
        );
      } finally {
        setBillingActionBusy(false);
      }
    },
    [refreshBillingOverview, subscriptionState.snapshot],
  );

  const handleManagedSubscriptionToggle = useCallback(async () => {
    if (!hasPaidSubscription(subscriptionState.snapshot)) {
      return;
    }

    setBillingActionBusy(true);
    setBillingActionError(null);

    try {
      if (subscriptionState.snapshot?.cancelAtPeriodEnd) {
        await resumeManagedSubscription();
      } else {
        await cancelManagedSubscription();
      }

      await refreshBillingOverview();
    } catch (nextError) {
      setBillingActionError(
        nextError instanceof Error
          ? nextError.message
          : 'Impossible de mettre à jour le renouvellement automatique.',
      );
    } finally {
      setBillingActionBusy(false);
    }
  }, [refreshBillingOverview, subscriptionState.snapshot]);

  const handlePaymentMethodAction = useCallback(async () => {
    if (!hasPaidSubscription(subscriptionState.snapshot)) {
      const targetPlanId: ManagedPlanId =
        selectedPlanId !== 'demo' ? selectedPlanId : 'proMonthly';
      await handlePlanSelection(targetPlanId);
      return;
    }

    setBillingActionBusy(true);
    setBillingActionError(null);

    try {
      const result = await createPaymentMethodSetupIntent();
      setBillingModal({
        mode: 'payment-method',
        clientSecret: result.clientSecret,
        title: 'Mettre à jour votre moyen de paiement',
        description:
          'Ajoutez ou remplacez votre carte sans sortir de RedView. Les prochains prélèvements utiliseront ce moyen de paiement.',
        submitLabel: 'Enregistrer cette carte',
      });
    } catch (nextError) {
      setBillingActionError(
        nextError instanceof Error
          ? nextError.message
          : 'Impossible d’ouvrir le formulaire de carte.',
      );
    } finally {
      setBillingActionBusy(false);
    }
  }, [handlePlanSelection, selectedPlanId, subscriptionState.snapshot]);

  const handleBillingModalComplete = useCallback(
    async (completion: BillingModalCompletion) => {
      if (completion.mode === 'payment-method') {
        const overview = await applyPaymentMethodSetup(completion.setupIntentId);
        applyBillingOverview(overview);
        setBillingModal(null);
        return;
      }

      await syncManagedSubscription(completion.subscriptionId);
      await refreshBillingOverview();
      setBillingModal(null);
    },
    [applyBillingOverview, refreshBillingOverview],
  );

  const closeBillingModal = useCallback(() => {
    setBillingModal(null);
  }, []);

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
            paymentMethod={paymentMethod}
            billingActionBusy={billingActionBusy}
            billingActionError={billingActionError}
            contactStatusMessage={contactStatusMessage}
            onSelectPlan={handlePlanSelection}
            onToggleManagedSubscription={handleManagedSubscriptionToggle}
            onManagePaymentMethod={handlePaymentMethodAction}
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

        {billingModal ? (
          <BillingActionModal
            flow={billingModal}
            onClose={closeBillingModal}
            onComplete={handleBillingModalComplete}
          />
        ) : null}
      </div>
    </div>
  );
}