/**
 * Accessibilité du parcours principal (axe-core, règles WCAG 2.0 / 2.1 / 2.2
 * niveaux A et AA) : chaque écran du parcours est audité tel que l'utilisateur
 * le voit, et le résultat est comparé à un cliquet (a11y-baseline.json).
 *
 * axe est injecté par `page.evaluate` (protocole du navigateur, hors CSP) : la
 * page garde sa CSP de prod, dont le parcours vérifie qu'elle n'est jamais
 * violée — ajouter un <script> ou `bypassCSP` la contournerait.
 *
 * Cliquet, comme les suppressions ESLint : pour chaque (écran, règle), le
 * nombre d'éléments en défaut ne doit pas dépasser celui de la référence ; une
 * règle nouvelle sur un écran échoue. Après une correction, la référence doit
 * redescendre (`--update-a11y-baseline`), sinon le contrôle échoue aussi : un
 * défaut corrigé ne peut pas revenir en silence.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';

const require = createRequire(import.meta.url);
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** WCAG 2.0, 2.1 et 2.2, niveaux A et AA (pas les « bonnes pratiques » d'axe). */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

export interface A11yFinding {
  screen: string;
  rule: string;
  impact: string;
  help: string;
  /** Éléments en défaut (sélecteurs CSS d'axe, pour le diagnostic). */
  targets: string[];
  /** Explication d'axe par élément (contraste mesuré, enfant attendu…), dans le rapport. */
  details: string[];
}

/** (écran, règle) → nombre d'éléments en défaut tolérés. */
export type A11yBaseline = Record<string, number>;

const baselineKey = (finding: Pick<A11yFinding, 'screen' | 'rule'>) => `${finding.screen} | ${finding.rule}`;

export async function auditScreen(page: Page, screen: string): Promise<A11yFinding[]> {
  const loaded = await page.evaluate(() => typeof (window as { axe?: unknown }).axe === 'object');
  if (!loaded) await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((violation) => ({
      rule: violation.id,
      impact: violation.impact ?? 'unknown',
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.map(String).join(' ')),
      details: violation.nodes.map((node) => node.failureSummary ?? ''),
    }));
  }, WCAG_TAGS);
  return violations.map((violation) => ({ screen, ...violation }));
}

export function readBaseline(file: string): A11yBaseline {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as A11yBaseline : {};
}

export function buildBaseline(findings: A11yFinding[]): A11yBaseline {
  const entries = findings.map((finding) => [baselineKey(finding), finding.targets.length] as const);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export interface A11yComparison {
  /** Règle nouvelle sur un écran, ou plus d'éléments en défaut qu'en référence. */
  regressions: string[];
  /** Défauts corrigés ou réduits : la référence doit redescendre. */
  stale: string[];
}

/** Écrans audités pendant ce passage : une entrée d'un écran non atteint (parcours interrompu) n'est pas jugée. */
export function compareWithBaseline(findings: A11yFinding[], baseline: A11yBaseline, screens: string[]): A11yComparison {
  const current = buildBaseline(findings);
  const regressions: string[] = [];
  for (const finding of findings) {
    const key = baselineKey(finding);
    const allowed = baseline[key] ?? 0;
    if (finding.targets.length > allowed) {
      regressions.push(`${key} (${finding.impact}) : ${finding.targets.length} élément(s), ${allowed} toléré(s) — ${finding.help} — ${finding.targets.slice(0, 3).join(' ; ')}`);
    }
  }
  const stale = Object.entries(baseline)
    .filter(([key]) => screens.includes(key.split(' | ')[0]!))
    .filter(([key, count]) => (current[key] ?? 0) < count)
    .map(([key, count]) => `${key} : ${current[key] ?? 0} au lieu de ${count}`);
  return { regressions, stale };
}
