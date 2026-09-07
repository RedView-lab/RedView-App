import { getAppwriteUser, readStoredAppwriteSession } from '@/shared/services/appwrite';

export async function getCurrentUserId(): Promise<string> {
  const storedSession = readStoredAppwriteSession();
  if (storedSession?.user.id) return storedSession.user.id;

  const user = await getAppwriteUser();
  if (!user) throw new Error('Not authenticated');
  return user.$id;
}