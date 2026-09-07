import {
  account,
  clearStoredAppwriteSession,
  getAppwriteUser,
} from '@/shared/services/appwrite';
import { readDocumentAppLocale, translateAppText } from '@/shared/i18n';

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

type AccountMetadata = {
  first_name?: unknown;
  last_name?: unknown;
  country?: unknown;
  sports?: unknown;
};

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function readMetadata(user: any): AccountMetadata {
  return user?.prefs && typeof user.prefs === 'object' ? (user.prefs as AccountMetadata) : {};
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
  if (!lastSignInAt) return translateAppText('Dernière connexion indisponible');

  const date = new Date(lastSignInAt);
  if (Number.isNaN(date.getTime())) return translateAppText('Dernière connexion indisponible');

  const locale = readDocumentAppLocale();
  const formatterLocale = locale === 'fr' ? 'fr-FR' : 'en-US';
  const day = new Intl.DateTimeFormat(formatterLocale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat(formatterLocale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: locale !== 'fr',
  }).format(date);

  return translateAppText('Dernière connexion le {{date}} à {{time}}', {
    date: day,
    time,
  });
}

export async function loadAccountProfile(fallbackEmail: string, fallbackDisplayName: string): Promise<AccountProfile> {
  const user = await getAppwriteUser();
  if (!user) throw new Error(translateAppText('Session utilisateur introuvable.'));

  const metadata = readMetadata(user);
  const email = readString(user.email, fallbackEmail);
  const nameParts = splitFallbackName(readString(user.name, buildFallbackName(email, fallbackDisplayName)));

  return {
    firstName: readString(metadata.first_name, nameParts.firstName),
    lastName: readString(metadata.last_name, nameParts.lastName),
    email,
    country: readString(metadata.country, DEFAULT_COUNTRY),
    sports: readSports(metadata.sports),
    lastSignInAt: typeof user.accessedAt === 'string' ? user.accessedAt : null,
  };
}

export async function saveAccountIdentity(form: AccountIdentityForm) {
  const user = await getAppwriteUser();
  if (!user) throw new Error(translateAppText('Session utilisateur introuvable.'));

  const fullName = `${form.firstName.trim()} ${form.lastName.trim()}`.trim();
  if (fullName && fullName !== user.name) {
    try {
      await account.updateName(fullName);
    } catch (e) {
      console.warn('[profile] updateName failed', e);
    }
  }

  const currentPrefs = readMetadata(user);
  const updatedPrefs = {
    ...currentPrefs,
    first_name: form.firstName.trim(),
    last_name: form.lastName.trim(),
  };

  try {
    return await account.updatePrefs(updatedPrefs);
  } catch (err) {
    console.warn('[profile] updatePrefs failed', err);
    return user;
  }
}

export async function saveAccountPractice(form: AccountPracticeForm) {
  const user = await getAppwriteUser();
  if (!user) throw new Error(translateAppText('Session utilisateur introuvable.'));

  const currentPrefs = readMetadata(user);
  const updatedPrefs = {
    ...currentPrefs,
    country: form.country,
    sports: form.sports.map((sport, index) => buildSportEntry(sport, index)),
  };

  try {
    return await account.updatePrefs(updatedPrefs);
  } catch (err) {
    console.warn('[profile] updatePrefs failed', err);
    return user;
  }
}

export async function updateAccountPassword(password: string) {
  try {
    await account.updatePassword(password);
  } catch (error: any) {
    throw new Error(error?.message || 'Impossible de mettre à jour le mot de passe.');
  }
}

export async function signOutAccount() {
  clearStoredAppwriteSession();

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith('redview:') || key.startsWith('sb-') || key.startsWith('cookieFallback'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore storage access errors
  }

  try {
    await Promise.race([
      account.deleteSession('current'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (err) {
    console.warn('[auth] Appwrite deleteSession error (ignored):', err);
  }
}