/**
 * Régénère le rapport d'une passe depuis ses mesures, sans rien relancer :
 *
 *   npx tsx script-test-bench/vps-load/render.ts script-test-bench/reports/vps-load/<passe>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { renderMarkdown, type PhaseResult, type RunMeta } from './report.ts';
import type { VpsWindow } from './sampler.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage : render.ts <dossier de la passe>');
  process.exit(1);
}
const data = JSON.parse(readFileSync(path.join(dir, 'resultats.json'), 'utf8')) as { meta: RunMeta; results: PhaseResult[]; idle: VpsWindow | null };
const meta: RunMeta = { link: null, waves: 3, ...data.meta };
writeFileSync(path.join(dir, 'rapport.md'), renderMarkdown(meta, data.results, data.idle));
console.log(path.join(dir, 'rapport.md'));
