import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  fetchAccountSports,
  footDisciplinesFromSports,
  getAccountSportsSnapshot,
  subscribeAccountSports,
} from '@/shared/services/accountPrefs';

/** Sports declared in the user's account settings (Trail / Running unlock foot disciplines). */
export function useAccountSports() {
  const sports = useSyncExternalStore(subscribeAccountSports, getAccountSportsSnapshot);

  useEffect(() => {
    void fetchAccountSports();
  }, []);

  return useMemo(() => {
    const footDisciplines = footDisciplinesFromSports(sports);
    return { sports, footDisciplines, hasFootSport: footDisciplines.length > 0 };
  }, [sports]);
}
