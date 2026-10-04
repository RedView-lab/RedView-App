import { useEffect, useState, type ReactNode } from 'react';

import { LidarManagerSlot, LidarManagerSlotContext } from './lidarManagerSlot';

/**
 * Fournit l'emplacement du LidarManager de la session (cf. LidarManagerSlot).
 * Léger : n'importe pas le moteur LiDAR, que seul l'éditeur charge.
 */
export function LidarProvider({ children }: { children: ReactNode }) {
  const [slot] = useState(() => new LidarManagerSlot());

  useEffect(() => {
    slot.cancelDispose();
    return () => slot.scheduleDispose();
  }, [slot]);

  return <LidarManagerSlotContext.Provider value={slot}>{children}</LidarManagerSlotContext.Provider>;
}
