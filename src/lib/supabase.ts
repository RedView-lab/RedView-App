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

export function hasStoredSupabaseSession(): boolean {
	if (typeof window === "undefined") return false;
	if (!SUPABASE_AUTH_STORAGE_KEY) return false;

	try {
		return Boolean(window.localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY));
	} catch {
		return false;
	}
}

export function readStoredSupabaseSession(): StoredSupabaseSessionSnapshot | null {
	if (typeof window === "undefined") return null;
	if (!SUPABASE_AUTH_STORAGE_KEY) return null;

	try {
		const raw = window.localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as {
			user?: {
				id?: unknown;
				email?: unknown;
			};
		};
		if (!parsed?.user || typeof parsed.user.id !== "string") return null;

		return {
			user: {
				id: parsed.user.id,
				...(typeof parsed.user.email === "string" ? { email: parsed.user.email } : {}),
			},
		};
	} catch {
		return null;
	}
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
