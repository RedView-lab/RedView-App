import { supabase } from '@/shared/services/supabase';

export async function getCurrentUserId(): Promise<string> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getUser();
  if (sessionErr) throw sessionErr;
  const user = sessionData.user;
  if (!user) throw new Error('Not authenticated');
  return user.id;
}