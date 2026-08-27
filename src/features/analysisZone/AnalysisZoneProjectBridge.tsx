/**
 * Side-effect-only bridge living inside <ProjectProvider>: hydrates the
 * in-memory analysis zone from the persisted project on mount (and project
 * switch — the provider is keyed per project so this remounts), then commits
 * every in-memory zone change back into `project.controlPanel.analysisZone`.
 *
 * Ordering matters: the in-memory zone can briefly hold the PREVIOUS
 * project's zone right after a project switch (the AnalysisZoneProvider sits
 * above the keyed ProjectProvider and does not remount). Pushing is therefore
 * gated until the hydrated value has actually landed in the context.
 */

import { useEffect, useRef } from 'react';

import { useProjectStore } from '@/features/itineraryPanel';
import { createDefaultControlPanelPersistedState } from '@/features/controlPanel/lib/persistedState';

import { useAnalysisZone } from './AnalysisZoneContext';
import { isValidAnalysisZone, type AnalysisZone } from './lib/geometry';

export function AnalysisZoneProjectBridge() {
  const store = useProjectStore();
  const analysisZone = useAnalysisZone();
  const setProject = store.setProject;
  const hydrateZone = analysisZone?.hydrateZone;
  const zone = analysisZone?.zone ?? null;

  const expectedHydrationKeyRef = useRef<string | null>(null);
  const hydrationSettledRef = useRef(false);

  // Hydrate once per provider mount (per project).
  useEffect(() => {
    const persisted = store.project.controlPanel?.analysisZone ?? null;
    const valid = isValidAnalysisZone(persisted) ? persisted : null;
    expectedHydrationKeyRef.current = valid ? valid.id : null;
    hydrationSettledRef.current = valid == null && zone == null;
    hydrateZone?.(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateZone]);

  // Push in-memory zone changes into the project once hydration has settled.
  useEffect(() => {
    if (!hydrateZone || !setProject) return;
    const next: AnalysisZone | null = isValidAnalysisZone(zone) ? zone : null;
    const nextKey = next ? next.id : null;

    if (!hydrationSettledRef.current) {
      if (nextKey !== expectedHydrationKeyRef.current) {
        // Still showing the previous project's zone — wait for hydration.
        return;
      }
      hydrationSettledRef.current = true;
      return;
    }

    setProject((prev) => {
      const currentKey = prev.controlPanel?.analysisZone?.id ?? null;
      if (currentKey === nextKey) return prev;
      const controlPanel = structuredClone(
        prev.controlPanel ?? createDefaultControlPanelPersistedState(),
      );
      controlPanel.analysisZone = next ? structuredClone(next) : null;
      return { ...prev, controlPanel };
    });
  }, [hydrateZone, setProject, zone]);

  return null;
}
