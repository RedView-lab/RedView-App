import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireEnv } from './config';

let adminClient: SupabaseClient | null = null;
let authClient: SupabaseClient | null = null;

export type AuthenticatedUser = {
  id: string;
  email: string | null;
};

export function getSupabaseAdmin() {
  if (!adminClient) {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return adminClient;
}

function getSupabaseAuthClient() {
  if (!authClient) {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const supabaseAnonKey = requireEnv('VITE_SUPABASE_ANON_KEY');

    authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return authClient;
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

  const { data, error } = await getSupabaseAuthClient().auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
  };
}
