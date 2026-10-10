import { lazy, Suspense, useEffect } from 'react';

import { useAppI18n } from '@/shared/i18n';
import { RedViewLogo } from '@/shared/components/RedViewLogo';
import { trackScreen, type AnalyticsScreen } from '@/shared/lib/analytics';
import { trackNavigationImport } from '@/shared/lib/staleBuild';

import { ProjectsPanel } from '../../projects';
import type { ProjectBrowserOverlayProps } from '../../../types';
import { TopTabs } from '../TopTabs';
import { AccountPanel, prefetchTabPanelsWhenIdle, SettingsPanel, SubscriptionPanel } from './lazyTabPanels';
import { ProjectBrowserOverlayHeader } from './ProjectBrowserOverlayHeader';
import { useProjectBrowserOverlayState } from './useProjectBrowserOverlayState';

import '../../../styles/index.css';

// Chargé à l'ouverture d'un parcours de paiement : le module démarre Stripe.js
// (`loadStripe`) dès qu'il est évalué — au chargement initial, cela coûtait à
// chaque utilisateur 4 requêtes et ~250 Kio depuis js.stripe.com, plus ~7 Kio
// brotli de la coque.
const BillingActionModal = lazy(() =>
  trackNavigationImport(import('../../../billing/components/BillingActionModal/BillingActionModal')).then((m) => ({ default: m.BillingActionModal })),
);

const TAB_SCREENS = {
  projects: 'projects',
  account: 'projects_account',
  subscription: 'projects_subscription',
  settings: 'projects_settings',
} as const satisfies Record<string, AnalyticsScreen>;

export function ProjectBrowserOverlay(props: ProjectBrowserOverlayProps) {
  const { t } = useAppI18n();
  const state = useProjectBrowserOverlayState(props);

  // Page vue virtuelle de l'onglet affiché (mesure d'audience).
  useEffect(() => {
    if (props.open) trackScreen(TAB_SCREENS[state.activeTab]);
  }, [props.open, state.activeTab]);

  useEffect(() => (props.open ? prefetchTabPanelsWhenIdle() : undefined), [props.open]);

  if (!props.open) return null;

  return (
    <div
      className="rvpb-overlay rv-fixed-viewport"
      role="dialog"
      aria-modal="true"
      aria-label={t('Sélecteur de projet principal')}
    >
      <div className="rvpb-brand-corner" aria-label="RedView">
        <RedViewLogo width={125} height={24} />
      </div>

      <div className={`rvpb-shell${state.activeTab === 'account' ? ' is-account-tab' : ''}`}>
        <ProjectBrowserOverlayHeader
          accountDisplayName={state.accountDisplayName}
          headerMetaLabel={state.headerMetaLabel}
          tierLabel={state.tierLabel}
          isSigningOut={state.isSigningOut}
          onSignOut={state.handleSignOut}
        />

        <div className="rvpb-divider" />

        <TopTabs activeTab={state.activeTab} onChange={state.setActiveTab} />

        <div className="rvpb-divider" />

          {state.activeTab === 'projects' ? (
            <ProjectsPanel
              folders={state.folders}
              view={state.view}
              setView={state.setView}
              showSearch={state.showSearch}
              setShowSearch={state.setShowSearch}
              search={state.search}
              setSearch={state.setSearch}
              handleCreateProject={state.handleCreateProject}
              handleCreateFolder={state.handleCreateFolder}
              handleImportProjects={state.handleImportProjects}
              creatingProject={state.creatingProject}
              importingProject={state.importingProject}
              creatingFolder={state.creatingFolder}
              error={state.error}
              loading={state.loading}
              q={state.q}
              currentFolderId={state.currentFolderId}
              breadcrumbs={state.breadcrumbs}
              visibleFolders={state.visibleFolders}
              visibleProjects={state.visibleProjects}
              sharedProjects={state.sharedProjects}
              userId={state.projectsUserId}
              thumbnails={state.thumbnails}
              thumbnailLoadingIds={state.thumbnailLoadingIds}
              busyIds={state.busyIds}
              draggedItem={state.draggedItem}
              dropTarget={state.dropTarget}
              dragPreview={state.dragPreview}
              onOpenProject={props.onOpenProject}
              onOpenFolder={state.handleOpenFolder}
              onNavigateToFolder={state.handleNavigateToFolder}
              handleRenameProject={state.handleRenameProject}
              handleDeleteProject={state.handleDeleteProject}
              handleRenameFolder={state.handleRenameFolder}
              handleDeleteFolder={state.handleDeleteFolder}
              handleDuplicateProject={state.handleDuplicateProject}
              handleExportProject={state.handleExportProject}
              handleLeaveProject={state.handleLeaveProject}
              handleMoveProject={state.handleMoveProject}
              handleMoveFolder={state.handleMoveFolder}
              handleDragStart={state.handleDragStart}
              handleDragMove={state.handleDragMove}
              handleDragEnd={state.handleDragEnd}
              handleDragEnterTarget={state.handleDragEnterTarget}
              handleDragLeaveTarget={state.handleDragLeaveTarget}
              handleDropIntoFolder={state.handleDropIntoFolder}
              handleDropToRoot={state.handleDropToRoot}
            />
          ) : null}

          <Suspense fallback={null}>
          {state.activeTab === 'subscription' ? (
            <SubscriptionPanel
              subscriptionState={state.subscriptionState}
              contactPreference={state.contactPreference}
              setContactPreference={state.setContactPreference}
              accountEmail={state.accountEmail}
              paymentMethods={state.paymentMethods}
              billingActionBusy={state.billingActionBusy}
              billingActionError={state.billingActionError}
              contactStatusMessage={state.contactStatusMessage}
              onChoosePlan={state.handleChoosePlan}
              onSwitchPlan={state.handleSwitchPlan}
              onCancelSubscription={state.handleCancelSubscription}
              onResumeSubscription={state.handleResumeSubscription}
              onOpenPortal={state.handleOpenPortal}
              onManagePaymentMethod={state.handlePaymentMethodAction}
              onSetDefaultPaymentMethod={state.handleSetDefaultPaymentMethod}
            />
          ) : null}

          {state.activeTab === 'account' ? (
            <AccountPanel
              profile={state.accountProfile}
              isLoading={state.accountLoading}
              error={state.accountError}
              fallbackDisplayName={props.displayName}
              onProfileUpdated={(nextProfile) => {
                state.setAccountProfile(nextProfile);
                state.setAccountError(null);
              }}
            />
          ) : null}

          {state.activeTab === 'settings' ? (
            <SettingsPanel profile={state.accountProfile} />
          ) : null}
          </Suspense>

        {state.billingModal ? (
          <Suspense fallback={null}>
            <BillingActionModal
              flow={state.billingModal}
              onClose={state.closeBillingModal}
              onComplete={state.handleBillingModalComplete}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}