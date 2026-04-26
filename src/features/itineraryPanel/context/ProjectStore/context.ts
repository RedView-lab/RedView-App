import { createContext } from 'react';

import type { ProjectStoreValue } from './types';

export const ProjectStoreContext = createContext<ProjectStoreValue | null>(null);