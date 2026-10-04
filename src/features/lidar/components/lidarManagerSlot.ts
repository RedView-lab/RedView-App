import { createContext } from 'react';

import type { LidarManager } from '../lib/lidarManager';

/**
 * LidarManager d'une session de Dashboard. L'emplacement est fourni par le
 * shell du Dashboard sans charger le moteur LiDAR (import de type seulement) ;
 * le manager est créé au premier `useLidarManager()` (éditeur, chargé à la
 * demande) et vit jusqu'au démontage du Dashboard : il survit à la fermeture
 * et à la réouverture d'un projet.
 */
export class LidarManagerSlot {
  private manager: LidarManager | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;

  getOrCreate(create: () => LidarManager): LidarManager {
    this.manager ??= create();
    return this.manager;
  }

  /** Remontage (StrictMode) : la destruction programmée est annulée. */
  cancelDispose(): void {
    if (this.disposeTimer != null) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
  }

  /**
   * Destruction différée d'une tâche : le démontage simulé de StrictMode est
   * suivi d'un remontage immédiat qui l'annule ; un vrai démontage la laisse
   * s'exécuter.
   */
  scheduleDispose(): void {
    this.cancelDispose();
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      this.manager?.destroy();
      this.manager = null;
    }, 0);
  }
}

export const LidarManagerSlotContext = createContext<LidarManagerSlot | null>(null);
