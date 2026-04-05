import { useState, useEffect } from 'react';
import { getStorageUsage } from '../storage/quota';

export function useStorageQuota(pollIntervalMs = 5000) {
  const [usage, setUsage] = useState({ used: 0, quota: 0 });

  useEffect(() => {
    let active = true;

    async function poll() {
      const u = await getStorageUsage();
      if (active) setUsage(u);
    }

    poll();
    const id = setInterval(poll, pollIntervalMs);
    return () => { active = false; clearInterval(id); };
  }, [pollIntervalMs]);

  return usage;
}
