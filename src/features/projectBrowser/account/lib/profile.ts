import { supabase } from '@/shared/services/supabase';

import {
  DEFAULT_COUNTRY,
  DEFAULT_LEVEL,
  DEFAULT_SPORT,
} from './options';
import type {
  AccountIdentityForm,
  AccountPracticeForm,
  AccountProfile,
  AccountSportEntry,
} from '../types';

type SupabaseUserLike = {
  email?: string | null;
  last_sign_in_at?: string | null;
  user_metadata?: unknown;
};

type AccountMetadata = {
  first_name?: unknown;
  last_name?: unknown;
  country?: unknown;
  sports?: unknown;
};

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function readMetadata(user: SupabaseUserLike): AccountMetadata {
  return user.user_metadata && typeof user.user_metadata === 'object'
    ? (user.user_metadata as AccountMetadata)
    : {};
}

function buildSportEntry(value: Partial<AccountSportEntry> | null | undefined, index: number): AccountSportEntry {
  return {
    id: typeof value?.id === 'string' && value.id ? value.id : `sport-${index + 1}`,
    sport: readString(value?.sport, DEFAULT_SPORT),
    level: readString(value?.level, DEFAULT_LEVEL),
    annualDistanceKm: readString(value?.annualDistanceKm, '500'),
  };
}

function readSports(value: unknown): AccountSportEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [buildSportEntry(null, 0)];
  }

  return value.map((entry, index) => buildSportEntry(entry as Partial<AccountSportEntry>, index));
}

function buildFallbackName(email: string, fallbackDisplayName: string) {
  if (fallbackDisplayName.trim()) return fallbackDisplayName.trim();
  const localPart = email.split('@')[0] ?? 'Utilisateur';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function splitFallbackName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const [firstName, ...rest] = trimmed.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(' '),
  };
}

export function formatAccountDisplayName(profile: Pick<AccountProfile, 'firstName' | 'lastName' | 'email'>, fallbackDisplayName: string) {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  if (fullName) return fullName;
  return buildFallbackName(profile.email, fallbackDisplayName);
}

export function formatLastConnection(lastSignInAt: string | null) {
  if (!lastSignInAt) return 'Derniere connection indisponible';

  const date = new Date(lastSignInAt);
  if (Number.isNaN(date.getTime())) return 'Derniere connection indisponible';

  const day = new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

  return `Derniere connection le ${day} a ${time}`;
}

export async function loadAccountProfile(fallbackEmail: string, fallbackDisplayName: string): Promise<AccountProfile> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) throw error;
  if (!user) throw new Error('Session utilisateur introuvable.');

  const metadata = readMetadata(user);
  const email = readString(user.email, fallbackEmail);
  const fallbackName = splitFallbackName(buildFallbackName(email, fallbackDisplayName));

  return {
    firstName: readString(metadata.first_name, fallbackName.firstName),
    lastName: readString(metadata.last_name, fallbackName.lastName),
    email,
    country: readString(metadata.country, DEFAULT_COUNTRY),
    sports: readSports(metadata.sports),
    lastSignInAt: typeof user.last_sign_in_at === 'string' ? user.last_sign_in_at : null,
  };
}

export async function saveAccountIdentity(form: AccountIdentityForm) {
  const {
    data: { user },
    error: readError,
  } = await supabase.auth.getUser();

  if (readError) throw readError;
  if (!user) throw new Error('Session utilisateur introuvable.');

  const metadata = readMetadata(user);
  const { data, error } = await supabase.auth.updateUser({
    email: form.email.trim(),
    data: {
      ...metadata,
      first_name: form.firstName.trim(),
      last_name: form.lastName.trim(),
    },
  });

  if (error) throw error;
  return data.user;
}

export async function saveAccountPractice(form: AccountPracticeForm) {
  const {
    data: { user },
    error: readError,
  } = await supabase.auth.getUser();

  if (readError) throw readError;
  if (!user) throw new Error('Session utilisateur introuvable.');

  const metadata = readMetadata(user);
  const { data, error } = await supabase.auth.updateUser({
    data: {
      ...metadata,
      country: form.country,
      sports: form.sports.map((sport, index) => buildSportEntry(sport, index)),
    },
  });

  if (error) throw error;
  return data.user;
}

export async function updateAccountPassword(password: string) {
  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) throw error;
}

export async function signOutAccount() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}