import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppI18n } from '@/shared/i18n';
import { readStoredSupabaseSession } from '@/shared/services/supabase';

import {
  formatAccountDisplayName,
  formatLastConnection,
  loadAccountProfile,
  signOutAccount,
  type AccountProfile,
} from '../../../account';
import {
  accountTierLabel,
  hasPaidSubscription,
  isDemoPlan,
  LANDING_URL,
  readBillingContactPreference,
  resolveActivePlanId,
  writeBillingContactPreference,
} from '../../../lib';
import {
  applyPaymentMethodSetup,
  cancelManagedSubscription,
  changeSubscriptionPlan,
  createPaymentMethodSetupIntent,
  createSubscriptionIntent,
  fetchBillingOverview,
  persistBillingContactPreference,
  resumeManagedSubscription,
  setDefaultBillingPaymentMethod,
  syncManagedSubscription,
  type BillingOverviewResponse,
} from '../../../lib';
import { logBillingUi, logBillingUiError } from '../../../lib';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  ProjectBrowserOverlayProps,
  OverlayTab,
  SubscriptionPlanId,
  SubscriptionState,
} from '../../../types';
import { useProjectBrowserProjects } from '../../../hooks/useProjectBrowserProjects';
import type {
  BillingModalCompletion,
  BillingModalState,
} from '../../../billing/components/BillingActionModal/BillingActionModal';

type ManagedPlanId = Exclude<SubscriptionPlanId, 'demo'>;

const PROJECT_BROWSER_ACTIVE_TAB_STORAGE_KEY = 'redview:project-browser:active-tab';

function getProjectBrowserActiveTabStorageKey(userId: string | null): string {
  return userId
    ? `${PROJECT_BROWSER_ACTIVE_TAB_STORAGE_KEY}:${userId}`
    : PROJECT_BROWSER_ACTIVE_TAB_STORAGE_KEY;
}

function readStoredActiveTab(userId: string | null): OverlayTab | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.sessionStorage.getItem(getProjectBrowserActiveTabStorageKey(userId));
    if (raw === 'projects' || raw === 'account' || raw === 'subscription' || raw === 'settings') {
      return raw;
    }
  } catch {
    /* ignore storage failures */
  }

  return null;
}

function writeStoredActiveTab(userId: string | null, tab: OverlayTab): void {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(getProjectBrowserActiveTabStorageKey(userId), tab);
  } catch {
    /* ignore storage failures */
  }
}

export function useProjectBrowserOverlayState({
  open,
  displayName,
  onOpenProject,
  onRequestClose,
  canClose = true,
}: ProjectBrowserOverlayProps) {
  const { t } = useAppI18n();
  const storedSession = readStoredSupabaseSession();
  const userId = storedSession?.user.id ?? null;
  const accountEmail = storedSession?.user.email ?? '';
  const [activeTab, setActiveTab] = useState<OverlayTab>(() => readStoredActiveTab(userId) ?? 'projects');
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
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodSummary[]>([]);
  const [billingActionBusy, setBillingActionBusy] = useState(false);
  const [billingActionError, setBillingActionError] = useState<string | null>(null);
  const [billingModal, setBillingModal] = useState<BillingModalState | null>(null);
  const [contactStatusMessage, setContactStatusMessage] = useState<string | null>(null);
  const syncedContactPreferenceRef = useRef<string | null>(null);
  const contactHydratedRef = useRef(false);
  const hasManualPlanSelectionRef = useRef(false);
  const projects = useProjectBrowserProjects({
    open,
    onOpenProject,
  });

  useEffect(() => {
    setActiveTab(readStoredActiveTab(userId) ?? 'projects');
  }, [userId]);

  useEffect(() => {
    writeStoredActiveTab(userId, activeTab);
  }, [activeTab, userId]);

  useEffect(() => {
    setContactPreference(readBillingContactPreference(userId));
    syncedContactPreferenceRef.current = null;
    contactHydratedRef.current = false;
    hasManualPlanSelectionRef.current = false;
  }, [userId]);

  useEffect(() => {
    if (open) {
      hasManualPlanSelectionRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    writeBillingContactPreference(userId, contactPreference);
  }, [contactPreference, userId]);

  useEffect(() => {
    if (!open || !userId || !contactHydratedRef.current) return;

    const serialized = JSON.stringify(contactPreference);
    if (syncedContactPreferenceRef.current === serialized) {
      return;
    }

    setContactStatusMessage(t('Enregistrement de votre e-mail de facturation…'));
    const timeout = window.setTimeout(() => {
      void persistBillingContactPreference(contactPreference)
        .then((nextPreference) => {
          syncedContactPreferenceRef.current = JSON.stringify(nextPreference);
          setContactPreference(nextPreference);
          setContactStatusMessage(t('E-mail de facturation enregistré.'));
        })
        .catch((nextError) => {
          setContactStatusMessage(
            nextError instanceof Error
              ? t(nextError.message)
              : t('Impossible d’enregistrer l’e-mail de facturation.'),
          );
        });
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [contactPreference, open, t, userId]);

  const applyBillingOverview = useCallback((overview: BillingOverviewResponse) => {
    const activePlanId = resolveActivePlanId(overview.subscription);

    setSubscriptionState({
      isLoading: false,
      error: null,
      snapshot: overview.subscription,
    });
    setSelectedPlanId((current) => (hasManualPlanSelectionRef.current ? current : activePlanId));
    setPaymentMethod(overview.paymentMethod);
    setPaymentMethods(overview.paymentMethods);
    setContactPreference(overview.contactPreference);
    syncedContactPreferenceRef.current = JSON.stringify(overview.contactPreference);
    contactHydratedRef.current = true;
    setContactStatusMessage(null);
    setBillingActionError(null);
  }, []);

  const handleSelectedPlanIdChange = useCallback((planId: SubscriptionPlanId) => {
    hasManualPlanSelectionRef.current = true;
    setSelectedPlanId(planId);
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
              ? t(nextError.message)
              : t('Impossible de charger les informations d’abonnement.'),
          snapshot: null,
        });
        setPaymentMethod(null);
        setPaymentMethods([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyBillingOverview, open, t, userId]);

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
            ? t(nextError.message)
            : t('Impossible de charger les informations du compte.'),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, accountEmail, displayName, t]);

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
        nextError instanceof Error ? t(nextError.message) : t('Impossible de se déconnecter.'),
      );
      setIsSigningOut(false);
    }
  }, [isSigningOut, t]);

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
              : 'Choisissez votre mode de paiement pour vous abonner.',
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
            ? t(nextError.message)
            : t('Impossible de lancer cette action de facturation.'),
        );
      } finally {
        setBillingActionBusy(false);
      }
    },
    [refreshBillingOverview, subscriptionState.snapshot, t],
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
          ? t(nextError.message)
          : t('Impossible de mettre à jour le renouvellement automatique.'),
      );
    } finally {
      setBillingActionBusy(false);
    }
  }, [refreshBillingOverview, subscriptionState.snapshot, t]);

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
          ? t(nextError.message)
          : t('Impossible d’ouvrir le formulaire de carte.'),
      );
    } finally {
      setBillingActionBusy(false);
    }
  }, [handlePlanSelection, selectedPlanId, subscriptionState.snapshot, t]);

  const handleBillingModalComplete = useCallback(
    async (completion: BillingModalCompletion) => {
      logBillingUi(
        'billing-modal-complete',
        completion.mode === 'payment-method'
          ? {
              mode: completion.mode,
              setupIntentId: completion.setupIntentId,
            }
          : {
              mode: completion.mode,
              subscriptionId: completion.subscriptionId,
            },
      );

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

  const handleSetDefaultPaymentMethod = useCallback(
    async (paymentMethodId: string) => {
      setBillingActionBusy(true);
      setBillingActionError(null);

      try {
        const overview = await setDefaultBillingPaymentMethod(paymentMethodId);
        applyBillingOverview(overview);
      } catch (nextError) {
        setBillingActionError(
          nextError instanceof Error
            ? t(nextError.message)
            : t('Impossible de définir ce moyen de paiement par défaut.'),
        );
      } finally {
        setBillingActionBusy(false);
      }
    },
    [applyBillingOverview, t],
  );

  const closeBillingModal = useCallback(() => {
    logBillingUi('billing-modal-close');
    setBillingModal(null);
  }, []);

  const accountDisplayName = accountProfile
    ? formatAccountDisplayName(accountProfile, displayName)
    : displayName || t('Utilisateur');
  const headerMetaLabel = accountLoading
    ? t('Chargement du compte...')
    : formatLastConnection(accountProfile?.lastSignInAt ?? null);
  const tierLabel = accountTierLabel(subscriptionState.snapshot, subscriptionState.isLoading);
  const showDemoRail = Boolean(subscriptionState.snapshot) && isDemoPlan(subscriptionState.snapshot);
  const offersUrl = `${LANDING_URL.replace(/\/$/, '')}/#offres`;

  return {
    accountDisplayName,
    accountEmail,
    accountError,
    accountLoading,
    accountProfile,
    activeTab,
    billingActionBusy,
    billingActionError,
    billingModal,
    breadcrumbs: projects.breadcrumbs,
    busyIds: projects.busyIds,
    contactPreference,
    contactStatusMessage,
    creatingFolder: projects.creatingFolder,
    creatingProject: projects.creatingProject,
    currentFolderId: projects.currentFolderId,
    dragPreview: projects.dragPreview,
    draggedItem: projects.draggedItem,
    dropTarget: projects.dropTarget,
    error: projects.error,
    folders: projects.folders,
    handleBillingModalComplete,
    handleCreateFolder: projects.handleCreateFolder,
    handleCreateProject: projects.handleCreateProject,
    handleDeleteFolder: projects.handleDeleteFolder,
    handleDeleteProject: projects.handleDeleteProject,
    handleDragEnd: projects.handleDragEnd,
    handleDragEnterTarget: projects.handleDragEnterTarget,
    handleDragLeaveTarget: projects.handleDragLeaveTarget,
    handleDragMove: projects.handleDragMove,
    handleDragStart: projects.handleDragStart,
    handleDropIntoFolder: projects.handleDropIntoFolder,
    handleDropToRoot: projects.handleDropToRoot,
    handleDuplicateProject: projects.handleDuplicateProject,
    handleManagedSubscriptionToggle,
    handleMoveFolder: projects.handleMoveFolder,
    handleMoveProject: projects.handleMoveProject,
    handleNavigateToFolder: projects.handleNavigateToFolder,
    handleOpenFolder: projects.handleOpenFolder,
    handlePaymentMethodAction,
    handlePlanSelection,
    handleRenameFolder: projects.handleRenameFolder,
    handleRenameProject: projects.handleRenameProject,
    handleSetDefaultPaymentMethod,
    handleSignOut,
    headerMetaLabel,
    isSigningOut,
    loading: projects.loading,
    offersUrl,
    paymentMethod,
    paymentMethods,
    q: projects.q,
    search: projects.search,
    selectedPlanId,
    setActiveTab,
    setAccountError,
    setAccountProfile,
    setContactPreference,
    setSearch: projects.setSearch,
    setSelectedPlanId: handleSelectedPlanIdChange,
    setShowSearch: projects.setShowSearch,
    setView: projects.setView,
    showDemoRail,
    showSearch: projects.showSearch,
    subscriptionState,
    thumbnails: projects.thumbnails,
    thumbnailLoadingIds: projects.thumbnailLoadingIds,
    tierLabel,
    toast: projects.toast,
    view: projects.view,
    visibleFolders: projects.visibleFolders,
    visibleProjects: projects.visibleProjects,
    closeBillingModal,
  };
}