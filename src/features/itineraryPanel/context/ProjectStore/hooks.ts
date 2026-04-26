import { useContext } from 'react';

import { ProjectStoreContext } from './context';
import type { ProjectStoreValue } from './types';

export function useProjectStore(): ProjectStoreValue {
  const ctx = useContext(ProjectStoreContext);
  if (!ctx) {
    throw new Error('useProjectStore must be used within <ProjectProvider>');
  }
  return ctx;
}

export function useProjectStoreOptional(): ProjectStoreValue | null {
  return useContext(ProjectStoreContext);
}