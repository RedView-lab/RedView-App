export async function getStorageUsage(): Promise<{ used: number; quota: number }> {
  if (!navigator.storage?.estimate) {
    return { used: 0, quota: 0 };
  }
  const estimate = await navigator.storage.estimate();
  return {
    used: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
  };
}
