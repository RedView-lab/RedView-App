import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useHasChanged } from '@/shared/hooks/useHasChanged';
import { useAppI18n } from '@/shared/i18n';
import { setAnalyticsContext, trackAnalyticsEvent } from '@/shared/lib/analytics';
import { notify } from '@/shared/lib/notify';
import { readStoredAppwriteSession } from '@/shared/services/appwrite';

import {
  formatAccountDisplayName,
  formatLastConnection,
  loadAccountProfile,
  signOutAccount,
  UnsyncedProjectsError,
  type AccountProfile,
} from '../../../account';
import {
  accountTierLabel,
  activateTrialSubscription,
  analyticsPlanOf,
  applyPaymentMethodSetup,
  cancelManagedSubscription,
  createPaymentMethodSetupIntent,
  fetchBillingOverview,
  hasLiveSubscription,
  LANDING_URL,
  logBillingUi,
  logBillingUiError,
  openBillingPortal,
  persistBillingContactPreference,
  readBillingContactPreference,
  resumeManagedSubscription,
  setDefaultBillingPaymentMethod,
  startSubscription,
  syncManagedSubscription,
  writeBillingContactPreference,
  type BillingOverviewResponse,
} from '../../../lib';
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

const PROJECT_BROWSER_ACTIVE_TAB_STORAGE_KEY = 'redview:project-browser:active-tab';

/**
 * Vue d'ensemble de la facturation en cache TanStack Query (30 s, appels
 * simultanés fusionnés) : rouvrir le gestionnaire de projets ou le remonter
 * ne rappelle pas le serveur à chaque fois (chaque appel lit Stripe ; le
 * quota par IP renvoyait 429 à un navigateur qui rouvrait souvent l'overlay).
 */
const billingOverviewKey = (userId: string) => ['billing', 'overview', userId] as const;
const BILLING_OVERVIEW_STALE_MS = 30_000;

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
    /* échecs de stockage ignorés */
  }

  return null;
}

function writeStoredActiveTab(userId: string | null, tab: OverlayTab): void {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(getProjectBrowserActiveTabStorageKey(userId), tab);
  } catch {
    /* échecs de stockage ignorés */
  }
}

export function useProjectBrowserOverlayState({
  open,
  displayName,
  onOpenProject,
  onRequestClose,
  canClose = true,
}: ProjectBrowserOverlayProps) {
  const { t, locale } = useAppI18n();
  const storedSession = readStoredAppwriteSession();
  const userId = storedSession?.user.id ?? null;
  const accountEmail = storedSession?.user.email ?? '';
  const [activeTab, setActiveTab] = useState<OverlayTab>(() => {
    if (typeof window !== 'undefined') {
      try {
        const params = new URLSearchParams(window.location.search);
        const tabParam = params.get('tab');
        if (tabParam === 'subscription' || tabParam === 'projects' || tabParam === 'account' || tabParam === 'settings') {
          return tabParam;
        }
        if (params.get('action') === 'upgrade' || params.has('upgrade')) {
          return 'subscription';
        }
      } catch {
        /* ignore */
      }
    }
    return readStoredActiveTab(userId) ?? 'projects';
  });
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>(() => ({
    isLoading: open && userId !== null,
    error: null,
    snapshot: null,
    trialEligible: true,
  }));
  const [accountProfile, setAccountProfile] = useState<AccountProfile | null>(null);
  const [accountLoading, setAccountLoading] = useState(open);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [contactPreference, setContactPreference] = useState<BillingContactPreference>(() =>
    readBillingContactPreference(userId),
  );
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodSummary[]>([]);
  const [billingActionBusy, setBillingActionBusy] = useState(false);
  const [billingActionError, setBillingActionError] = useState<string | null>(null);
  const [billingModal, setBillingModal] = useState<BillingModalState | null>(null);
  const [contactStatusMessage, setContactStatusMessage] = useState<string | null>(null);
  const syncedContactPreferenceRef = useRef<string | null>(null);
  const contactHydratedRef = useRef(false);
  const billingReturnHandledRef = useRef(false);
  const queryClient = useQueryClient();
  const projects = useProjectBrowserProjects({
    open,
    onOpenProject,
  });

  // Changement de compte : onglet et e-mail de facturation de ce compte (au
  // premier rendu, les initialiseurs ci-dessus ont déjà lu l'URL puis le stockage).
  const userIdChanged = useHasChanged(userId);
  if (userIdChanged) {
    setActiveTab(readStoredActiveTab(userId) ?? 'projects');
    setContactPreference(readBillingContactPreference(userId));
  }

  // Chargements relancés par leurs effets plus bas : l'indicateur passe au
  // rendu où ils repartent, pas après le commit.
  // t suit la langue : un changement de langue relance aussi les chargements.
  const localeChanged = useHasChanged(locale);
  const billingKeyChanged = useHasChanged(open ? userId : null);
  if ((billingKeyChanged || localeChanged) && open && userId) {
    setSubscriptionState((prev) => ({ ...prev, isLoading: true, error: null }));
  }
  const accountKeyChanged = useHasChanged(open ? `${accountEmail}\u0000${displayName ?? ''}` : null);
  if ((accountKeyChanged || localeChanged) && open) {
    setAccountLoading(true);
    setAccountError(null);
  }

  useEffect(() => {
    writeStoredActiveTab(userId, activeTab);
  }, [activeTab, userId]);

  useEffect(() => {
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
    // Formule (jamais l'abonnement lui-même) : contexte des événements de mesure.
    setAnalyticsContext({ plan: analyticsPlanOf(overview.subscription) });

    // Réponse lue telle quelle (bancs : faux /api/billing minimal) : chaque champ a son repli.
    const contact = overview.contactPreference ?? readBillingContactPreference(null);
    setSubscriptionState({
      isLoading: false,
      error: null,
      snapshot: overview.subscription ?? null,
      trialEligible: overview.trialEligible === true,
    });
    setPaymentMethods(Array.isArray(overview.paymentMethods) ? overview.paymentMethods : []);
    setContactPreference(contact);
    syncedContactPreferenceRef.current = JSON.stringify(contact);
    contactHydratedRef.current = true;
    setContactStatusMessage(null);
    setBillingActionError(null);
  }, []);

  /** Lecture fraîche après une action (souscription, résiliation…) : le cache est remplacé. */
  const refreshBillingOverview = useCallback(async () => {
    if (!userId) return;
    const overview = await queryClient.fetchQuery({
      queryKey: billingOverviewKey(userId),
      queryFn: fetchBillingOverview,
      staleTime: 0,
    });
    applyBillingOverview(overview);
  }, [applyBillingOverview, queryClient, userId]);

  useEffect(() => {
    if (!open || !userId) return;

    let cancelled = false;
    void (async () => {
      try {
        const overview = await queryClient.fetchQuery({
          queryKey: billingOverviewKey(userId),
          queryFn: fetchBillingOverview,
          staleTime: BILLING_OVERVIEW_STALE_MS,
        });

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
          trialEligible: false,
        });
        setPaymentMethods([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyBillingOverview, open, queryClient, t, userId]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

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
      try {
        await signOutAccount();
      } catch (nextError) {
        if (!(nextError instanceof UnsyncedProjectsError)) throw nextError;
        // Des modifications locales n'ont pas pu être envoyées : la purge locale
        // de la déconnexion les détruirait. L'utilisateur choisit.
        const names = nextError.projects.map((project) => `« ${project.name} »`).join(', ');
        const confirmed = window.confirm(
          t('Des modifications ne sont pas synchronisées avec le cloud : {{names}}. OK : se déconnecter quand même (ces modifications seront perdues). Annuler : rester connecté pour réessayer plus tard ou exporter les projets.', { names }),
        );
        if (!confirmed) {
          setIsSigningOut(false);
          return;
        }
        await signOutAccount({ force: true });
      }
    } catch (nextError) {
      console.warn('[ProjectBrowserOverlay] Failed to sign out cleanly', nextError);
    }
    if (typeof window !== 'undefined') window.location.reload();
  }, [isSigningOut, t]);

  /** Erreur d'une action de facturation, traduite pour l'onglet Abonnement. */
  const failBillingAction = useCallback(
    (event: string, nextError: unknown, fallback: string) => {
      logBillingUiError(event, nextError);
      setBillingActionError(nextError instanceof Error ? t(nextError.message) : t(fallback));
    },
    [t],
  );

  const handleChoosePlan = useCallback(
    async (planId: SubscriptionPlanId) => {
      trackAnalyticsEvent({ name: 'checkout_started', data: { plan: planId } });
      setBillingActionBusy(true);
      setBillingActionError(null);
      try {
        const result = await startSubscription(planId);
        logBillingUi('start-subscription-result', { planId, intent: result.intent });
        setBillingModal(
          result.intent === 'setup'
            ? { mode: 'trial', clientSecret: result.clientSecret, setupIntentId: result.setupIntentId, planId }
            : { mode: 'subscription', clientSecret: result.clientSecret, subscriptionId: result.subscriptionId, planId },
        );
      } catch (nextError) {
        failBillingAction('start-subscription-error', nextError, 'Impossible de lancer la souscription.');
        // Un abonnement existe peut-être déjà (autre onglet, autre appareil) : l'écran se remet à jour.
        void refreshBillingOverview().catch(() => undefined);
      } finally {
        setBillingActionBusy(false);
      }
    },
    [failBillingAction, refreshBillingOverview],
  );

  /** Portail Stripe : factures, ou passage à une autre durée avec `planId`. */
  const goToBillingPortal = useCallback(
    async (planId?: SubscriptionPlanId) => {
      setBillingActionBusy(true);
      setBillingActionError(null);
      try {
        window.location.assign(await openBillingPortal(planId));
      } catch (nextError) {
        failBillingAction('billing-portal-error', nextError, 'Impossible d’ouvrir l’espace de facturation Stripe.');
        setBillingActionBusy(false);
      }
    },
    [failBillingAction],
  );

  const handleSwitchPlan = useCallback((planId: SubscriptionPlanId) => void goToBillingPortal(planId), [goToBillingPortal]);
  const handleOpenPortal = useCallback(() => void goToBillingPortal(), [goToBillingPortal]);

  const handleCancelSubscription = useCallback(async (): Promise<boolean> => {
    setBillingActionError(null);
    try {
      await cancelManagedSubscription();
      await refreshBillingOverview();
      notify.success('Résiliation confirmée. Vous recevrez une confirmation par e-mail.');
      return true;
    } catch (nextError) {
      logBillingUiError('cancel-subscription-error', nextError);
      notify.error(nextError instanceof Error ? nextError.message : 'La résiliation a échoué. Réessayez.');
      return false;
    }
  }, [refreshBillingOverview]);

  const handleResumeSubscription = useCallback(async () => {
    setBillingActionBusy(true);
    setBillingActionError(null);
    try {
      await resumeManagedSubscription();
      await refreshBillingOverview();
      notify.success('Votre abonnement continue.');
    } catch (nextError) {
      failBillingAction('resume-subscription-error', nextError, 'Impossible de reprendre l’abonnement.');
    } finally {
      setBillingActionBusy(false);
    }
  }, [failBillingAction, refreshBillingOverview]);

  const handlePaymentMethodAction = useCallback(async () => {
    setBillingActionBusy(true);
    setBillingActionError(null);
    try {
      const result = await createPaymentMethodSetupIntent();
      setBillingModal({ mode: 'payment-method', clientSecret: result.clientSecret });
    } catch (nextError) {
      failBillingAction('payment-method-error', nextError, 'Impossible d’ouvrir le formulaire de paiement.');
    } finally {
      setBillingActionBusy(false);
    }
  }, [failBillingAction]);

  const handleBillingModalComplete = useCallback(
    async (completion: BillingModalCompletion) => {
      logBillingUi('billing-modal-complete', { mode: completion.mode });

      if (completion.mode === 'payment-method') {
        applyBillingOverview(await applyPaymentMethodSetup(completion.setupIntentId));
        setBillingModal(null);
        notify.success('Moyen de paiement enregistré.');
        return;
      }

      if (completion.mode === 'trial') {
        await activateTrialSubscription(completion.setupIntentId);
        notify.success('Votre essai gratuit a commencé. Bienvenue sur RedView !');
      } else {
        await syncManagedSubscription(completion.subscriptionId);
        notify.success('Abonnement activé. Merci !');
      }
      await refreshBillingOverview();
      setBillingModal(null);
    },
    [applyBillingOverview, refreshBillingOverview],
  );

  // Retour d'un moyen de paiement à redirection (PayPal…) : Stripe ramène sur
  // `/?tab=subscription&billing_return=…` avec l'intent confirmé ; on finit le
  // parcours (le webhook le finit aussi si l'onglet ne revient jamais).
  useEffect(() => {
    if (!open || !userId || billingReturnHandledRef.current || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const flow = url.searchParams.get('billing_return');
    if (!flow) return;
    billingReturnHandledRef.current = true;

    const status = url.searchParams.get('redirect_status');
    const setupIntentId = url.searchParams.get('setup_intent');
    const subscriptionId = url.searchParams.get('subscription');
    for (const key of ['billing_return', 'redirect_status', 'setup_intent', 'setup_intent_client_secret', 'payment_intent', 'payment_intent_client_secret', 'subscription']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);

    if (status === 'failed') {
      notify.error('Le paiement n’a pas abouti. Aucun montant n’a été prélevé ; vous pouvez réessayer.');
      return;
    }
    if (status !== 'succeeded' && status !== 'pending') return;

    const completion: BillingModalCompletion | null =
      flow === 'trial' && setupIntentId
        ? { mode: 'trial', setupIntentId }
        : flow === 'subscription' && subscriptionId
          ? { mode: 'subscription', subscriptionId }
          : flow === 'payment-method' && setupIntentId
            ? { mode: 'payment-method', setupIntentId }
            : null;
    if (!completion) return;

    void (async () => {
      setBillingActionBusy(true);
      try {
        await handleBillingModalComplete(completion);
      } catch (nextError) {
        failBillingAction('billing-return-error', nextError, 'Impossible de finaliser le paiement.');
      } finally {
        setBillingActionBusy(false);
      }
    })();
  }, [failBillingAction, handleBillingModalComplete, open, userId]);

  const handleSetDefaultPaymentMethod = useCallback(
    async (paymentMethodId: string) => {
      setBillingActionBusy(true);
      setBillingActionError(null);
      try {
        applyBillingOverview(await setDefaultBillingPaymentMethod(paymentMethodId));
      } catch (nextError) {
        failBillingAction('default-payment-method-error', nextError, 'Impossible de définir ce moyen de paiement par défaut.');
      } finally {
        setBillingActionBusy(false);
      }
    },
    [applyBillingOverview, failBillingAction],
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
  const showDemoRail = Boolean(subscriptionState.snapshot) && !hasLiveSubscription(subscriptionState.snapshot);
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
    importingProject: projects.importingProject,
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
    handleExportProject: projects.handleExportProject,
    handleImportProjects: projects.handleImportProjects,
    handleCancelSubscription,
    handleChoosePlan,
    handleOpenPortal,
    handleResumeSubscription,
    handleSwitchPlan,
    handleMoveFolder: projects.handleMoveFolder,
    handleMoveProject: projects.handleMoveProject,
    handleNavigateToFolder: projects.handleNavigateToFolder,
    handleOpenFolder: projects.handleOpenFolder,
    handlePaymentMethodAction,
    handleRenameFolder: projects.handleRenameFolder,
    handleRenameProject: projects.handleRenameProject,
    handleSetDefaultPaymentMethod,
    handleSignOut,
    headerMetaLabel,
    isSigningOut,
    loading: projects.loading,
    offersUrl,
    paymentMethods,
    q: projects.q,
    search: projects.search,
    setActiveTab,
    setAccountError,
    setAccountProfile,
    setContactPreference,
    setSearch: projects.setSearch,
    setShowSearch: projects.setShowSearch,
    setView: projects.setView,
    showDemoRail,
    showSearch: projects.showSearch,
    subscriptionState,
    thumbnails: projects.thumbnails,
    thumbnailLoadingIds: projects.thumbnailLoadingIds,
    tierLabel,
    view: projects.view,
    visibleFolders: projects.visibleFolders,
    visibleProjects: projects.visibleProjects,
    sharedProjects: projects.sharedProjects,
    projectsUserId: projects.userId,
    handleLeaveProject: projects.handleLeaveProject,
    closeBillingModal,
  };
}