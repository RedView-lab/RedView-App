import { getSupabaseUser, readStoredSupabaseSession } from '@/shared/services/supabase';

export async function getCurrentUserId(): Promise<string> {
  const storedSession = readStoredSupabaseSession();
  if (storedSession?.user.id) return storedSession.user.id;

  const user = await getSupabaseUser();
  if (!user) throw new Error('Not authenticated');
  return user.id;
}