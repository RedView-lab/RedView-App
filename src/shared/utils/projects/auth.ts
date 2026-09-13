import { getAppwriteUser, readStoredAppwriteSession } from '@/shared/services/appwrite';

export async function getCurrentUserId(): Promise<string> {
  const user = await getAppwriteUser();
  if (user?.$id) return user.$id;

  const storedSession = readStoredAppwriteSession();
  if (storedSession?.user.id) return storedSession.user.id;

  throw new Error('Not authenticated');
}