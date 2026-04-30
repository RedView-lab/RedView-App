import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

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

export const supabase = createClient(
	supabaseUrl,
	supabaseAnonKey,
	SUPABASE_AUTH_STORAGE_KEY
		? {
				auth: {
					storageKey: SUPABASE_AUTH_STORAGE_KEY,
					detectSessionInUrl: false,
				},
		  }
		: undefined,
);
