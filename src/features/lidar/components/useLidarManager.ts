import { useContext } from 'react';

import { LidarManager } from '../lib/lidarManager';
import { LidarManagerSlotContext } from './lidarManagerSlot';

const createLidarManager = () => new LidarManager();

/** LidarManager de la session de Dashboard, créé au premier appel (cf. LidarProvider). */
export function useLidarManager(): LidarManager {
  const slot = useContext(LidarManagerSlotContext);
  if (!slot) throw new Error('useLidarManager must be used within LidarProvider');
  return slot.getOrCreate(createLidarManager);
}
