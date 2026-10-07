/**
 * Client minimal de l'API Umami (auto-hébergé, 3.4+) pour les scripts : clé API
 * lue hors du dépôt (`~/.redview/umami.json` : { "url", "apiKey", "websiteId" },
 * ou `UMAMI_API_KEY` / `UMAMI_URL` / `UMAMI_WEBSITE_ID`). Créer la clé dans
 * Umami : Paramètres → Clés API (affichée une seule fois, préfixe `umami_`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UmamiConfig {
  url: string;
  apiKey: string;
  websiteId: string;
}

export const UMAMI_CONFIG_PATH = path.join(os.homedir(), '.redview', 'umami.json');
const DEFAULT_URL = 'https://analytics.redview.tech';
const DEFAULT_WEBSITE_ID = '794b9933-1d87-4e8c-af69-a09982cc2353';

export function readUmamiConfig(): UmamiConfig | null {
  let stored: Partial<UmamiConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(UMAMI_CONFIG_PATH, 'utf8')) as Partial<UmamiConfig>;
  } catch {
    // Pas de fichier : variables d'environnement seulement.
  }
  const apiKey = process.env.UMAMI_API_KEY || stored.apiKey;
  if (!apiKey) return null;
  return {
    url: (process.env.UMAMI_URL || stored.url || DEFAULT_URL).replace(/\/$/, ''),
    apiKey,
    websiteId: process.env.UMAMI_WEBSITE_ID || stored.websiteId || DEFAULT_WEBSITE_ID,
  };
}

export async function umamiRequest<T>(config: UmamiConfig, method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.url}/api${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Umami ${method} ${route} → HTTP ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Tous les éléments d'une liste paginée (`{ data, count, page, pageSize }`). */
export async function umamiList<T>(config: UmamiConfig, route: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const separator = route.includes('?') ? '&' : '?';
    const result = await umamiRequest<{ data?: T[]; count?: number } | T[]>(config, 'GET', `${route}${separator}page=${page}&pageSize=100`);
    const data = Array.isArray(result) ? result : result.data ?? [];
    items.push(...data);
    const count = Array.isArray(result) ? data.length : result.count ?? data.length;
    if (data.length < 100 || items.length >= count) break;
  }
  return items;
}
