import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { SOLO_COMPUTE_GATE } from './collab';
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

/**
 * Porte des calculs dérivés (cf. `DerivedComputeGate`) pour un traitement
 * (routage, prédiction, POI). Un traitement que la porte fait attendre
 * appelle `markWaiting()` ; `retryNonce` change alors dès que la porte peut
 * avoir changé d'avis, pour le relancer. Sans attente, les changements de la
 * porte (présence des autres éditeurs…) ne relancent rien : un calcul en
 * cours n'est jamais interrompu par eux.
 */
export function useDerivedComputeGate() {
  const gate = useContext(ProjectStoreContext)?.derivedComputeGate ?? SOLO_COMPUTE_GATE;
  const waitingRef = useRef(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => gate.subscribe(() => {
    if (!waitingRef.current) return;
    waitingRef.current = false;
    setRetryNonce((nonce) => nonce + 1);
  }), [gate]);

  const markWaiting = useCallback(() => {
    waitingRef.current = true;
  }, []);

  return { gate, retryNonce, markWaiting };
}
