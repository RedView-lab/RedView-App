import {
  Account,
  Client,
  Databases,
  ID,
  OAuthProvider,
  Permission,
  Query,
  Role,
  Storage,
  type Models,
} from 'appwrite';

const appwriteEndpoint =
  (import.meta.env.VITE_APPWRITE_ENDPOINT as string | undefined) ||
  'http://appwrite.141.145.220.99.sslip.io/v1';
const appwriteProjectId =
  (import.meta.env.VITE_APPWRITE_PROJECT_ID as string | undefined) || 'redview-prod';

export const APPWRITE_DATABASE_ID =
  (import.meta.env.VITE_APPWRITE_DATABASE_ID as string | undefined) || 'redview-db';
export const PROJECTS_COLLECTION_ID = 'projects';
export const FOLDERS_COLLECTION_ID = 'project_folders';
export const CUSTOMERS_COLLECTION_ID = 'customers';
export const SUBSCRIPTIONS_COLLECTION_ID = 'subscriptions';
export const THUMBNAILS_BUCKET_ID = 'project-thumbnails';
export const FIT_FILES_BUCKET_ID = 'itinerary-fit-files';

export const APPWRITE_AUTH_STORAGE_KEY = 'redview:appwrite-session';

export interface StoredAppwriteSessionSnapshot {
  user: {
    id: string;
    email?: string;
    name?: string;
  };
}

export const client = new Client();
client.setEndpoint(appwriteEndpoint).setProject(appwriteProjectId);

export const account = new Account(client);
export const databases = new Databases(client);
export const storage = new Storage(client);

export { ID, OAuthProvider, Permission, Query, Role };

export function hasStoredAppwriteSession(): boolean {
  return readStoredAppwriteSession() !== null;
}

export function readStoredAppwriteSession(): StoredAppwriteSessionSnapshot | null {
  if (typeof window === 'undefined') return null;

  if (window.localStorage.getItem('redview:dev-session') === 'true') {
    return {
      user: {
        id: 'dev-user-001',
        email: 'dev@redview.app',
        name: 'Dev User',
      },
    };
  }

  try {
    const raw = window.localStorage.getItem(APPWRITE_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAppwriteSessionSnapshot;
    if (!parsed?.user || typeof parsed.user.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredAppwriteSession(user: { id: string; email?: string; name?: string }): void {
  if (typeof window === 'undefined') return;
  try {
    const snapshot: StoredAppwriteSessionSnapshot = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
    window.localStorage.setItem(APPWRITE_AUTH_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore local storage errors
  }
}

export function clearStoredAppwriteSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(APPWRITE_AUTH_STORAGE_KEY);
    window.localStorage.removeItem('redview:dev-session');
  } catch {
    // ignore
  }
}

let inFlightUserPromise: Promise<Models.User<Models.Preferences> | null> | null = null;

export async function getAppwriteUser(): Promise<Models.User<Models.Preferences> | null> {
  if (typeof window !== 'undefined' && window.localStorage.getItem('redview:dev-session') === 'true') {
    return {
      $id: 'dev-user-001',
      name: 'Dev User',
      email: 'dev@redview.app',
      status: true,
      labels: [],
      passwordUpdate: '',
      emailVerification: true,
      phone: '',
      phoneVerification: false,
      mfa: false,
      prefs: {},
      targets: [],
      accessedAt: '',
      registration: '',
    } as unknown as Models.User<Models.Preferences>;
  }

  if (!inFlightUserPromise) {
    inFlightUserPromise = (async () => {
      try {
        const user = await account.get();
        saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name });
        return user;
      } catch {
        clearStoredAppwriteSession();
        return null;
      }
    })();
  }

  try {
    return await inFlightUserPromise;
  } finally {
    inFlightUserPromise = null;
  }
}

export async function getAppwriteJwt(): Promise<string | null> {
  if (typeof window !== 'undefined' && window.localStorage.getItem('redview:dev-session') === 'true') {
    return 'dev-jwt-token';
  }

  try {
    const { jwt } = await account.createJWT();
    return jwt;
  } catch (error) {
    console.warn('[appwrite] createJWT failed', error);
    return null;
  }
}
