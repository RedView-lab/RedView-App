/**
 * Note sur les courbes d'Umami (annotations 3.4) — « Déploiement <sha> »,
 * « Retour arrière à <sha> » : une variation d'audience, de Web Vitals ou d'un
 * entonnoir se lit face au changement qui l'a causée. Best-effort et
 * silencieux sans clé API (~/.redview/umami.json, voir scripts/umami/client.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { success, warn } from './coolify.mjs';

export async function annotateUmami(note) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.redview', 'umami.json'), 'utf8'));
  } catch {
    // Pas de fichier : variables d'environnement seulement.
  }
  const apiKey = process.env.UMAMI_API_KEY || config.apiKey;
  if (!apiKey) return;
  const url = (process.env.UMAMI_URL || config.url || 'https://analytics.redview.tech').replace(/\/$/, '');
  const websiteId = process.env.UMAMI_WEBSITE_ID || config.websiteId || '794b9933-1d87-4e8c-af69-a09982cc2353';
  try {
    const response = await fetch(`${url}/api/websites/${websiteId}/annotations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: new Date().toISOString(), note, allDay: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) success(`Umami: annotation « ${note} » added.`);
    else warn(`Umami annotation not added (HTTP ${response.status}).`);
  } catch (err) {
    warn(`Umami annotation not added (${err.message}).`);
  }
}
