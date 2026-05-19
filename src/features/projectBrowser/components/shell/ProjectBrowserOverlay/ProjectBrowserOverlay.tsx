import { useAppI18n } from '@/shared/i18n';

import { AccountPanel } from '../../../account';
import { BillingActionModal } from '../../../billing/components/BillingActionModal/BillingActionModal';
import { SettingsPanel } from '../../../settings';
import { ProjectsPanel } from '../../projects';
import { SubscriptionPanel } from '../../subscription';
import type { ProjectBrowserOverlayProps } from '../../../types';
import { TopTabs } from '../TopTabs';
import { ProjectBrowserOverlayDemoRail } from './ProjectBrowserOverlayDemoRail';
import { ProjectBrowserOverlayHeader } from './ProjectBrowserOverlayHeader';
import { useProjectBrowserOverlayState } from './useProjectBrowserOverlayState';

import '../../../styles/index.css';

export function ProjectBrowserOverlay(props: ProjectBrowserOverlayProps) {
  const { t } = useAppI18n();
  const state = useProjectBrowserOverlayState(props);

  if (!props.open) return null;

  return (
    <div
      className="rvpb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('Sélecteur de projet principal')}
    >
      <div
        className={`rvpb-shell${state.activeTab === 'account' ? ' is-account-tab' : ''}${state.showDemoRail ? ' has-demo-rail' : ''}`}
      >
        {state.showDemoRail ? <ProjectBrowserOverlayDemoRail offersUrl={state.offersUrl} /> : null}

        <div className="rvpb-shell__main">
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
              creatingProject={state.creatingProject}
              creatingFolder={state.creatingFolder}
              error={state.error}
              loading={state.loading}
              q={state.q}
              currentFolderId={state.currentFolderId}
              breadcrumbs={state.breadcrumbs}
              visibleFolders={state.visibleFolders}
              visibleProjects={state.visibleProjects}
              thumbnails={state.thumbnails}
              busyIds={state.busyIds}
              draggedItem={state.draggedItem}
              dropTarget={state.dropTarget}
              dragPreview={state.dragPreview}
              toast={state.toast}
              onOpenProject={props.onOpenProject}
              onOpenFolder={state.handleOpenFolder}
              onNavigateToFolder={state.handleNavigateToFolder}
              handleRenameProject={state.handleRenameProject}
              handleDeleteProject={state.handleDeleteProject}
              handleRenameFolder={state.handleRenameFolder}
              handleDeleteFolder={state.handleDeleteFolder}
              handleDuplicateProject={state.handleDuplicateProject}
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

          {state.activeTab === 'subscription' ? (
            <SubscriptionPanel
              subscriptionState={state.subscriptionState}
              selectedPlanId={state.selectedPlanId}
              setSelectedPlanId={state.setSelectedPlanId}
              contactPreference={state.contactPreference}
              setContactPreference={state.setContactPreference}
              accountEmail={state.accountEmail}
              paymentMethod={state.paymentMethod}
              paymentMethods={state.paymentMethods}
              billingActionBusy={state.billingActionBusy}
              billingActionError={state.billingActionError}
              contactStatusMessage={state.contactStatusMessage}
              onSelectPlan={state.handlePlanSelection}
              onToggleManagedSubscription={state.handleManagedSubscriptionToggle}
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

          {state.activeTab === 'settings' ? <SettingsPanel /> : null}
        </div>

        {state.billingModal ? (
          <BillingActionModal
            flow={state.billingModal}
            onClose={state.closeBillingModal}
            onComplete={state.handleBillingModalComplete}
          />
        ) : null}
      </div>
    </div>
  );
}