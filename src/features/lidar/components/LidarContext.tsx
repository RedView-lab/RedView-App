import { createContext, useContext, useRef, useEffect, type ReactNode } from 'react';
import { LidarManager } from '../lidarManager';

const LidarCtx = createContext<LidarManager | null>(null);

export function LidarProvider({ children }: { children: ReactNode }) {
  const ref = useRef<LidarManager>(new LidarManager());

  useEffect(() => {
    return () => ref.current.destroy();
  }, []);

  return <LidarCtx.Provider value={ref.current}>{children}</LidarCtx.Provider>;
}

export function useLidarManager(): LidarManager {
  const ctx = useContext(LidarCtx);
  if (!ctx) throw new Error('useLidarManager must be used within LidarProvider');
  return ctx;
}
