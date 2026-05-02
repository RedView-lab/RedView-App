import { navigatorLock } from "@supabase/auth-js";
import { createClient } from "@supabase/supabase-js";
import type { Session, User } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_AUTH_LOCK_TIMEOUT_MS = 30000;

function supabaseAuthLock<R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
	return navigatorLock(
		name,
		acquireTimeout <= 0 ? acquireTimeout : Math.max(acquireTimeout, SUPABASE_AUTH_LOCK_TIMEOUT_MS),
		fn,
	);
}

function buildSupabaseAuthStorageKey(url: string | undefined): string {
	if (!url) return "";
	try {
		const projectRef = new URL(url).hostname.split(".")[0] ?? "";
		return projectRef ? `sb-${projectRef}-auth-token` : "";
	} catch {
		return "";
	}
}

export const SUPABASE_AUTH_STORAGE_KEY = buildSupabaseAuthStorageKey(supabaseUrl);

export interface StoredSupabaseSessionSnapshot {
	user: {
		id: string;
		email?: string;
	};
}

let inFlightSessionPromise: Promise<Session | null> | null = null;

type StoredSupabaseSessionPayload = {
	access_token?: unknown;
	refresh_token?: unknown;
	user?: {
		id?: unknown;
		email?: unknown;
	};
};

function readStoredSupabaseSessionPayload(): StoredSupabaseSessionPayload | null {
	if (typeof window === "undefined") return null;
	if (!SUPABASE_AUTH_STORAGE_KEY) return null;

	try {
		const raw = window.localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as StoredSupabaseSessionPayload;
	} catch {
		return null;
	}
}

export function hasStoredSupabaseSession(): boolean {
	return readStoredSupabaseSession() !== null;
}

export function readStoredSupabaseSession(): StoredSupabaseSessionSnapshot | null {
	const parsed = readStoredSupabaseSessionPayload();
	if (!parsed?.user || typeof parsed.user.id !== "string") return null;
	if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string") {
		return null;
	}

	return {
		user: {
			id: parsed.user.id,
			...(typeof parsed.user.email === "string" ? { email: parsed.user.email } : {}),
		},
	};
}

export async function getSupabaseSession(): Promise<Session | null> {
	if (!inFlightSessionPromise) {
		inFlightSessionPromise = (async () => {
			const {
				data: { session },
				error,
			} = await supabase.auth.getSession();

			if (error) throw error;
			return session;
		})();
	}

	try {
		return await inFlightSessionPromise;
	} finally {
		if (inFlightSessionPromise) {
			inFlightSessionPromise = null;
		}
	}
}

export async function getSupabaseUser(): Promise<User | null> {
	const session = await getSupabaseSession();
	return session?.user ?? null;
}

export async function getSupabaseAccessToken(): Promise<string | null> {
	const session = await getSupabaseSession();
	return session?.access_token ?? null;
}

export const supabase = createClient(
	supabaseUrl,
	supabaseAnonKey,
	SUPABASE_AUTH_STORAGE_KEY
		? {
				auth: {
					storageKey: SUPABASE_AUTH_STORAGE_KEY,
					detectSessionInUrl: false,
					lock: supabaseAuthLock,
				},
		  }
		: undefined,
);
