/**
 * Suppressions de compte (RGPD) : état, reprise, rejeu après restauration.
 *
 *   npx tsx --env-file=.env scripts/appwrite/account-deletions.ts                # liste (lecture seule)
 *   npx tsx --env-file=.env scripts/appwrite/account-deletions.ts --resume       # termine les suppressions en attente
 *   npx tsx --env-file=.env scripts/appwrite/account-deletions.ts --reapply      # après restauration d'une sauvegarde :
 *                                                                       # resupprime tout compte du registre qui existe encore
 *
 * Une suppression interrompue laisse le compte bloqué, marqué
 * `deletionpending`, et `pending` au registre `account_deletions`
 * (api/_lib/accountDeletion.ts) : la personne ne peut plus la relancer. L'API
 * réessaie 3 fois en 12 min, puis le serveur de production reprend toute
 * suppression en attente depuis plus de 15 min, au démarrage et toutes les
 * 15 min (server/lib/account-deletion-resume.mjs) ; ce script reste pour un
 * cas bloqué ou hors de l'image.
 *
 * Restaurer une sauvegarde fait revenir les comptes supprimés depuis
 * l'instantané : `--reapply` les supprime de nouveau (même code, idempotent).
 * Le registre restauré ne connaît que les suppressions antérieures à
 * l'instantané : celles des dernières heures sont aussi dans les journaux de
 * l'app (`[account-deletion] compte supprimé <id>`) et dans GlitchTip en cas
 * d'échec — server/vps/backup/README.md, « Après une restauration ».
 *
 * Ids seulement, jamais d'e-mail ni de contenu.
 */
import { Query } from 'node-appwrite';

import {
  ACCOUNT_DELETIONS_COLLECTION_ID,
  DELETION_PENDING_LABEL,
  deleteAccount,
} from '../../api/_lib/accountDeletion.ts';
import { APPWRITE_DATABASE_ID, getAppwriteDatabases, getAppwriteUsers } from '../../api/_lib/appwrite.ts';

interface LedgerRow {
  $id: string;
  user_id: string;
  status: string;
  requested_at: string;
  completed_at?: string | null;
}

async function ledger(): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const list = await getAppwriteDatabases().listDocuments(APPWRITE_DATABASE_ID, ACCOUNT_DELETIONS_COLLECTION_ID, [
      Query.limit(100),
      ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ]);
    const documents = list.documents as unknown as LedgerRow[];
    rows.push(...documents);
    if (documents.length < 100) return rows;
    cursor = documents[documents.length - 1].$id;
  }
}

/** Comptes bloqués et marqués, au cas où le registre manquerait (collection pas encore créée). */
async function pendingLabelledUsers(): Promise<string[]> {
  const list = await getAppwriteUsers().list([Query.contains('labels', [DELETION_PENDING_LABEL]), Query.limit(100)]);
  return list.users.map((user) => user.$id);
}

async function userExists(userId: string): Promise<boolean> {
  try {
    await getAppwriteUsers().get(userId);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 404) return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--reapply') ? 'reapply' : process.argv.includes('--resume') ? 'resume' : 'list';
  const rows = await ledger();
  let labelled: string[] = [];
  try {
    labelled = await pendingLabelledUsers();
  } catch (error) {
    console.warn('recherche par label impossible (version d\'Appwrite ?) :', (error as Error).message);
  }

  const pending = new Set([...rows.filter((row) => row.status !== 'done').map((row) => row.user_id), ...labelled]);
  console.log(`registre : ${rows.length} suppression(s), ${rows.filter((row) => row.status === 'done').length} terminée(s)`);
  console.log(`en attente : ${pending.size}${pending.size ? ` — ${[...pending].join(', ')}` : ''}`);

  let targets: string[] = [];
  if (mode === 'resume') targets = [...pending];
  if (mode === 'reapply') {
    for (const row of rows) if (await userExists(row.user_id)) targets.push(row.user_id);
    for (const id of pending) if (!targets.includes(id)) targets.push(id);
    console.log(`comptes du registre encore présents : ${targets.length}`);
  }
  if (mode === 'list') return;

  let failed = 0;
  for (const userId of targets) {
    try {
      const summary = await deleteAccount(userId);
      console.log(`supprimé ${userId}`, summary);
    } catch (error) {
      failed += 1;
      console.error(`ÉCHEC ${userId} :`, error);
    }
  }
  console.log(`${targets.length - failed}/${targets.length} suppression(s) terminée(s)`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
