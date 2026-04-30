import { useCallback, useEffect, useRef, useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import {
  IconDownload,
  IconSettingsCog,
  IconShare,
} from '@/features/itineraryPanel/components/icons';
import { readStoredSupabaseSession } from '@/shared/services/supabase';

import {
  AccountPanel,
  formatAccountDisplayName,
  formatLastConnection,
  loadAccountProfile,
  signOutAccount,
  type AccountProfile,
} from '../account';
import { PlaceholderPanel } from './PlaceholderPanel';
import { ProjectsPanel } from './ProjectsPanel';
import {
  BillingActionModal,
  type BillingModalCompletion,
  type BillingModalState,
} from './BillingActionModal';
import { logBillingUi, logBillingUiError } from '../lib/debug';
import { SubscriptionPanel } from './SubscriptionPanel';
import {
  accountTierLabel,
  hasPaidSubscription,
  readBillingContactPreference,
  resolveActivePlanId,
  writeBillingContactPreference,
} from '../lib/subscription';
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
} from '../lib/billingApi';
import { TopTabs } from './TopTabs';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  ProjectBrowserOverlayProps,
  OverlayTab,
  SubscriptionPlanId,
  SubscriptionState,
} from '../types';
import { formatSavedAt } from '../lib/utils';
import { useProjectBrowserProjects } from '../hooks/useProjectBrowserProjects';

import '../styles/index.css';

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
  const {
    projects,
    thumbnails,
    loading,
    error,
    busyIds,
    creating,
    search,
    setSearch,
    view,
    setView,
    showSearch,
    setShowSearch,
    handleCreate,
    handleRename,
    handleDelete,
    q,
    filtered,
  } = useProjectBrowserProjects({
    open,
    onOpenProject,
  });

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

  const lastEdited = projects[0];
  const handlePlanSelection = useCallback(
    async (requestedPlanId: ManagedPlanId) => {
      logBillingUi('handle-plan-selection-start', {
        requestedPlanId,
        currentStatus: subscriptionState.snapshot?.status ?? null,
        currentPriceId: subscriptionState.snapshot?.priceId ?? null,
        hasPaidSubscription: hasPaidSubscription(subscriptionState.snapshot),
      });

      setBillingActionBusy(true);
      setBillingActionError(null);

      try {
        const result = hasPaidSubscription(subscriptionState.snapshot)
          ? await changeSubscriptionPlan(requestedPlanId)
          : await createSubscriptionIntent(requestedPlanId);

        logBillingUi('handle-plan-selection-result', {
          requestedPlanId,
          subscriptionId: result.subscriptionId,
          subscriptionStatus: result.subscription.status,
          hasClientSecret: Boolean(result.clientSecret),
          requiresPaymentConfirmation: result.requiresPaymentConfirmation,
        });

        if (result.clientSecret) {
          logBillingUi('handle-plan-selection-open-modal', {
            requestedPlanId,
            subscriptionId: result.subscriptionId,
            mode: 'subscription',
          });
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

        logBillingUi('handle-plan-selection-refresh-overview', {
          requestedPlanId,
          reason: 'missing-client-secret',
        });
        await refreshBillingOverview();
      } catch (nextError) {
        logBillingUiError('handle-plan-selection-error', nextError, {
          requestedPlanId,
        });
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
        logBillingUi('handle-payment-method-result', {
          hasClientSecret: Boolean(result.clientSecret),
        });
      setBillingModal({
        mode: 'payment-method',
        clientSecret: result.clientSecret,
        title: 'Mettre à jour votre moyen de paiement',
        description:
          'Ajoutez ou remplacez votre carte sans sortir de RedView. Les prochains prélèvements utiliseront ce moyen de paiement.',
        submitLabel: 'Enregistrer cette carte',
      });
    } catch (nextError) {
        logBillingUiError('handle-payment-method-error', nextError);
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
      logBillingUi('billing-modal-complete', completion.mode === 'payment-method'
        ? {
            mode: completion.mode,
            setupIntentId: completion.setupIntentId,
          }
        : {
            mode: completion.mode,
            subscriptionId: completion.subscriptionId,
          });

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
    logBillingUi('billing-modal-close');
    setBillingModal(null);
  }, []);

  if (!open) return null;

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