import { useSyncExternalStore } from 'react';

import {
  getProjectSyncStatus,
  subscribeProjectSyncStatus,
  type ProjectSyncStatus,
} from '@/shared/services/projects/syncStatus';

/** État de synchronisation cloud du projet ouvert (voir syncStatus.ts). */
export function useProjectSyncStatus(): ProjectSyncStatus {
  return useSyncExternalStore(subscribeProjectSyncStatus, getProjectSyncStatus, getProjectSyncStatus);
}
