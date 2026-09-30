import { getAppwriteUser } from './appwrite';
import type { FootDiscipline } from '@/shared/lib/discipline';

/**
 * Account sports (Appwrite user prefs `sports[].sport`, stored as French
 * labels) exposed as a tiny cached store, so the itinerary panel can offer
 * Trail / Running without importing the project-browser account feature.
 */

/** Labels renamed or merged over time → current label. */
const LEGACY_SPORT_ALIASES: Record<string, string> = {
  Randonnee: 'Trail',
};

export function normalizeAccountSportLabel(label: string): string {
  return LEGACY_SPORT_ALIASES[label] ?? label;
}

const FOOT_DISCIPLINE_BY_SPORT: Record<string, FootDiscipline> = {
  Trail: 'trail',
  Running: 'running',
};

export function footDisciplinesFromSports(labels: readonly string[]): FootDiscipline[] {
  const found = new Set<FootDiscipline>();
  for (const label of labels) {
    const discipline = FOOT_DISCIPLINE_BY_SPORT[normalizeAccountSportLabel(label)];
    if (discipline) found.add(discipline);
  }
  return [...found];
}

function readAccountSportLabels(prefs: unknown): string[] {
  const sports = (prefs as { sports?: unknown } | null)?.sports;
  if (!Array.isArray(sports)) return [];
  return sports
    .map((entry) => (entry as { sport?: unknown } | null)?.sport)
    .filter((sport): sport is string => typeof sport === 'string')
    .map(normalizeAccountSportLabel);
}

const EMPTY: readonly string[] = [];
let cache: readonly string[] | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function publishAccountSports(labels: readonly string[]): void {
  cache = labels.map(normalizeAccountSportLabel);
  emit();
}

export function resetAccountSports(): void {
  cache = null;
  emit();
}

/** Loads the account sports once (later calls reuse the cache). */
export function fetchAccountSports(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!inFlight) {
    inFlight = getAppwriteUser()
      .then((user) => {
        if (user) publishAccountSports(readAccountSportLabels(user.prefs));
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function subscribeAccountSports(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccountSportsSnapshot(): readonly string[] {
  return cache ?? EMPTY;
}
