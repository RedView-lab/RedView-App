/**
 * Activation par cohorte d'inscription (agrégats seulement, lecture seule) :
 * inscrits → projet créé → itinéraire tracé → revenus après J+7 → abonnés.
 * `--usage` ajoute l'usage : actifs à 7 / 30 jours, projets, itinéraires et
 * kilomètres par compte (tranches), part des comptes par fonction.
 *
 *   npx tsx --env-file=.env scripts/analytics/activation-report.ts
 *   npx tsx --env-file=.env scripts/analytics/activation-report.ts --usage
 *   npx tsx --env-file=.env scripts/analytics/activation-report.ts --exclude "@redview\.(tech|test)$|^collab-test"
 *   npx tsx --env-file=.env scripts/analytics/activation-report.ts --weeks 8 --json
 *
 * Les comptes libellés `internal` (équipe, tests : scripts/analytics/internal-accounts.ts)
 * sont toujours écartés ; `--exclude` ajoute une expression régulière sur l'e-mail
 * — appliquée en mémoire, aucun e-mail n'est affiché. Logique et définitions :
 * api/_lib/activationReport.ts. À lire avec la mesure d'audience Umami
 * (anonyme, par session) : docs/analytics/measurement.md.
 */
import {
  computeActivation,
  computeUsage,
  formatActivationTable,
  formatPlainSummary,
  formatUsageReport,
  loadActivationData,
} from '../../api/_lib/activationReport.ts';

const argv = process.argv.slice(2);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const exclude = option('--exclude') ? new RegExp(option('--exclude')!, 'i') : undefined;
const weeks = Number(option('--weeks') ?? 12);
const withUsage = argv.includes('--usage');

const data = await loadActivationData(exclude);
const report = computeActivation(data.users, data.projects, data.paidUserIds);
const shown = { cohorts: report.cohorts.slice(0, weeks), total: report.total };
const usage = withUsage ? computeUsage(data.users, data.projects) : null;

if (argv.includes('--json')) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), excludedAccounts: data.excluded, ...shown, ...(usage ? { usage } : {}) }, null, 2));
} else {
  console.log(`# Rapport RedView — ${new Date().toISOString().slice(0, 10)} (${data.users.length} comptes, ${data.projects.length} projets${data.excluded ? `, ${data.excluded} compte(s) écarté(s)` : ''})\n`);
  console.log(`${formatPlainSummary(report, usage)}\n`);
  console.log('## Activation par cohorte d’inscription\n');
  console.log(formatActivationTable(shown));
  console.log('\nRetour à J+7 : parmi les inscrits depuis 7 jours ou plus, activité du compte ou sauvegarde d’un projet 7 jours après l’inscription.');
  if (usage) {
    console.log('\n## Usage\n');
    console.log(formatUsageReport(usage));
  }
}
