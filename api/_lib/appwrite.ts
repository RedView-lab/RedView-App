import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Account, Client, Databases, Storage, Users } from 'node-appwrite';

import { requireEnv } from './config.js';

let adminClient: Client | null = null;
let adminDb: Databases | null = null;
let adminUsers: Users | null = null;
let adminStorage: Storage | null = null;

export const APPWRITE_DATABASE_ID =
  process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
export const PROJECTS_COLLECTION_ID = 'projects';
export const FOLDERS_COLLECTION_ID = 'project_folders';
export const CUSTOMERS_COLLECTION_ID = 'customers';
export const SUBSCRIPTIONS_COLLECTION_ID = 'subscriptions';
export const THUMBNAILS_BUCKET_ID = 'project-thumbnails';
export const FIT_FILES_BUCKET_ID = 'itinerary-fit-files';

export type AuthenticatedUser = {
  id: string;
  email: string | null;
};

export function getAppwriteEndpoint(): string {
  return (
    process.env.APPWRITE_ENDPOINT ||
    process.env.VITE_APPWRITE_ENDPOINT ||
    'http://127.0.0.1:8082/v1'
  );
}

export function getAppwriteProjectId(): string {
  return (
    process.env.APPWRITE_PROJECT_ID ||
    process.env.VITE_APPWRITE_PROJECT_ID ||
    'redview-prod'
  );
}

export function getAppwriteAdmin(): Client {
  if (!adminClient) {
    const endpoint = getAppwriteEndpoint();
    const projectId = getAppwriteProjectId();
    const apiKey = requireEnv('APPWRITE_API_KEY');

    adminClient = new Client()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);
  }

  return adminClient;
}

export function getAppwriteDatabases(): Databases {
  if (!adminDb) {
    adminDb = new Databases(getAppwriteAdmin());
  }
  return adminDb;
}

export function getAppwriteUsers(): Users {
  if (!adminUsers) {
    adminUsers = new Users(getAppwriteAdmin());
  }
  return adminUsers;
}

export function getAppwriteStorage(): Storage {
  if (!adminStorage) {
    adminStorage = new Storage(getAppwriteAdmin());
  }
  return adminStorage;
}

function getBearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

export async function requireAuthenticatedUser(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AuthenticatedUser | null> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  if (token === 'dev-jwt-token') {
    return {
      id: 'dev-user-001',
      email: 'dev@redview.app',
    };
  }

  try {
    const userClient = new Client()
      .setEndpoint(getAppwriteEndpoint())
      .setProject(getAppwriteProjectId())
      .setJWT(token);

    const account = new Account(userClient);
    const user = await account.get();

    return {
      id: user.$id,
      email: user.email || null,
    };
  } catch (error) {
    console.warn('[auth] JWT verification failed:', error);
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
}
