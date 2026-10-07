/**
 * Comptes internes (équipe, comptes de test) : libellé Appwrite `internal`.
 * Un compte libellé n'envoie rien à la mesure d'audience (le before-send coupe
 * tout, src/features/auth/lib/authAnalytics.ts) et sort du rapport d'activation
 * (api/_lib/activationReport.ts) — la même population des deux côtés.
 *
 *   npx tsx --env-file=.env scripts/analytics-internal-accounts.ts --list
 *   npx tsx --env-file=.env scripts/analytics-internal-accounts.ts --add "^prenom\.nom@|@redview\.tech$"
 *   npx tsx --env-file=.env scripts/analytics-internal-accounts.ts --remove "^ancien@"
 *
 * `--add` / `--remove` prennent une expression régulière sur l'e-mail ; sans
 * `--apply`, le script dit seulement combien de comptes changeraient. Les
 * e-mails ne sont affichés que masqués (première lettre + domaine).
 */
import { Query, type Models } from 'node-appwrite';

import { INTERNAL_ACCOUNT_LABEL } from '../api/_lib/activationReport.ts';
import { getAppwriteUsers } from '../api/_lib/appwrite.ts';

const argv = process.argv.slice(2);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const apply = argv.includes('--apply');
const addPattern = option('--add');
const removePattern = option('--remove');

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}…@${domain}`;
}

async function listUsers(): Promise<Models.User<Models.Preferences>[]> {
  const all: Models.User<Models.Preferences>[] = [];
  for (let cursor: string | null = null; ;) {
    const page: Models.UserList<Models.Preferences> = await getAppwriteUsers().list([Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])]);
    all.push(...page.users);
    if (page.users.length < 100) break;
    cursor = page.users[page.users.length - 1]!.$id;
  }
  return all;
}

const users = await listUsers();
const isInternal = (user: Models.User<Models.Preferences>) => (user.labels ?? []).includes(INTERNAL_ACCOUNT_LABEL);

if (argv.includes('--list') || (!addPattern && !removePattern)) {
  const internal = users.filter(isInternal);
  console.log(`${internal.length} compte(s) interne(s) sur ${users.length} :`);
  for (const user of internal) console.log(`  ${maskEmail(user.email ?? '')}`);
}

for (const [pattern, adding] of [[addPattern, true], [removePattern, false]] as const) {
  if (!pattern) continue;
  const regex = new RegExp(pattern, 'i');
  const targets = users.filter((user) => regex.test(user.email ?? '') && isInternal(user) !== adding);
  console.log(`${adding ? 'Ajout' : 'Retrait'} du libellé « ${INTERNAL_ACCOUNT_LABEL} » : ${targets.length} compte(s)${apply ? '' : ' (simulation, --apply pour écrire)'}`);
  for (const user of targets) {
    console.log(`  ${maskEmail(user.email ?? '')}`);
    if (!apply) continue;
    const labels = adding
      ? [...(user.labels ?? []), INTERNAL_ACCOUNT_LABEL]
      : (user.labels ?? []).filter((label) => label !== INTERNAL_ACCOUNT_LABEL);
    await getAppwriteUsers().updateLabels(user.$id, labels);
  }
}
