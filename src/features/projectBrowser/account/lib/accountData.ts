/**
 * Données du compte (RGPD) : export de tout ce que le compte possède (droit
 * d'accès et portabilité, art. 15 et 20) et suppression définitive (art. 17,
 * confirmée par un code envoyé à l'adresse du compte — api/auth/delete-account.ts).
 */
import { buildRedviewFileName } from '@/features/redviewFile/lib/format';
import { translateAppText } from '@/shared/i18n';
import { countBucket, trackAnalyticsEvent } from '@/shared/lib/analytics';
import { APP_BUILD_ID } from '@/shared/lib/appCacheEpoch';
import { apiFetch } from '@/shared/lib/apiFetch';
import { account, getAppwriteJwt } from '@/shared/services/appwrite';
import {
  collectProjectFitUploads,
  downloadProjectItineraryFitFileEntries,
  getProject,
  listOwnedFitFiles,
  listProjectBrowserSnapshot,
} from '@/shared/services/projects';
import { readProjectView } from '@/shared/services/projects/projectViews';

/**
 * La purge efface chaque projet et fichier possédé avant de répondre ; elle
 * est idempotente et reprenable, donc un délai dépassé se relance sans risque.
 */
const DELETE_ACCOUNT_TIMEOUT_MS = 180_000;

async function deleteAccountRequest<T>(body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const send = async (fresh: boolean) => {
    const token = await getAppwriteJwt({ fresh });
    if (!token) throw new Error(translateAppText('Session expirée. Reconnectez-vous pour supprimer votre compte.'));
    return apiFetch('/api/auth/delete-account', {
      timeoutMs: DELETE_ACCOUNT_TIMEOUT_MS,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  };
  let response = await send(false);
  // JWT réutilisé mais refusé (session renouvelée entre-temps) : un nouveau, une fois.
  if (response.status === 401) response = await send(true);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(translateAppText(typeof data.error === 'string' ? data.error : 'La suppression du compte a échoué.'));
  }
  return { status: response.status, data: data as T };
}

/** Envoie le code de confirmation à l'adresse du compte. */
export async function requestAccountDeletionCode(): Promise<void> {
  await deleteAccountRequest({ action: 'request-code' });
}

/**
 * Supprime le compte. `pending` : le compte est déjà désactivé et la purge se
 * termine côté serveur (reprise automatique) — l'accusé arrive par e-mail.
 */
export async function confirmAccountDeletion(code: string): Promise<'deleted' | 'pending'> {
  const { status } = await deleteAccountRequest<{ deleted?: boolean }>({
    action: 'confirm',
    code: code.trim(),
    confirm: 'delete-my-account',
  });
  trackAnalyticsEvent({ name: 'account_deleted' });
  return status === 202 ? 'pending' : 'deleted';
}

export interface AccountExportProgress {
  done: number;
  total: number;
}

export interface AccountExportResult {
  fileName: string;
  sizeBytes: number;
  projectCount: number;
  /** Projets illisibles (introuvables ou erreur) : absents de l'archive, listés dans compte.json. */
  failedProjects: string[];
  /** Fichiers .fit déposés hors de vos projets (projets partagés d'autres personnes). */
  sharedFitFileCount: number;
}

function uniqueEntryName(base: string, taken: Set<string>): string {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';
  let name = base;
  for (let index = 2; taken.has(name); index += 1) name = `${stem} - ${index}${extension}`;
  taken.add(name);
  return name;
}

const README = [
  'Export des données de votre compte RedView',
  '============================================',
  '',
  'compte.json       Votre compte (identité, préférences dont vos profils de tracé et vos',
  '                  informations de pratique), vos dossiers, la liste de vos projets et des',
  '                  projets partagés avec vous.',
  'projets/*.redview Chacun de vos projets, complet : itinéraires, tracés, prédictions, POI,',
  '                  feuille de route, réglages, fichiers .fit et miniature. Un fichier',
  '                  .redview est une archive ZIP : il s\'ouvre dans RedView (« Importer un',
  '                  projet ») ou avec n\'importe quel outil ZIP (project.json, fit/…).',
  '',
  'fit-partages/     Les fichiers .fit que vous avez déposés dans des projets partagés par',
  '                  d\'autres personnes (vos traces et données d\'entraînement), et ceux qui ne',
  '                  sont plus rattachés à aucun projet.',
  '',
  'compte.json contient aussi vos commentaires dans les projets partagés avec vous et vos',
  'vues de chaque projet (itinéraire actif, réglages des panneaux). Les projets partagés avec',
  'vous appartiennent à leur propriétaire : ils sont listés dans compte.json et s\'exportent',
  'un par un depuis leur menu. Vos factures sont disponibles dans le portail de facturation',
  '(Abonnement).',
  '',
  '---',
  '',
  'RedView account data export: compte.json (account, preferences, folders, project list,',
  'your comments in projects shared with you, your project views), projets/*.redview (each',
  'project you own, complete; a .redview file is a ZIP archive), fit-partages/ (.fit files',
  'you added to other people\'s shared projects, or no longer attached to any project).',
  '',
].join('\n');

/**
 * Archive ZIP de tout ce que le compte possède, téléchargée par le navigateur.
 * Les projets sont lus un par un (une seule charge en mémoire à la fois) et
 * rangés tels quels, sans recompression.
 */
export async function exportAccountData(onProgress?: (progress: AccountExportProgress) => void): Promise<AccountExportResult> {
  // Chargés à la demande : l'écriture .redview et ZIP reste hors du chemin critique du gestionnaire de projets.
  const [{ buildRedviewFile, downloadBlob }, { StoredZipBuilder }] = await Promise.all([
    import('@/features/redviewFile/lib/exportProject'),
    import('@/features/redviewFile/lib/zip/zipWriter'),
  ]);
  const [user, snapshot] = await Promise.all([account.get(), listProjectBrowserSnapshot()]);
  const exportedAt = new Date();
  const builder = new StoredZipBuilder(exportedAt);
  const taken = new Set<string>();
  const projectEntries: Array<Record<string, unknown>> = [];
  const failedProjects: string[] = [];
  /** .fit déjà dans les .redview de vos projets. */
  const exportedFitPaths = new Set<string>();

  onProgress?.({ done: 0, total: snapshot.projects.length });
  for (const [index, summary] of snapshot.projects.entries()) {
    let file: string | null = null;
    try {
      const row = await getProject(summary.id);
      if (row) {
        for (const upload of collectProjectFitUploads(row.data)) if (upload.path) exportedFitPaths.add(upload.path);
        const { blob } = await buildRedviewFile({ project: { ...row.data, name: row.name || row.data.name }, projectId: summary.id });
        file = `projets/${uniqueEntryName(buildRedviewFileName(row.name || summary.name), taken)}`;
        await builder.add(file, blob);
      }
    } catch (error) {
      console.warn('[account-export] projet illisible', summary.id, error);
    }
    if (!file) failedProjects.push(summary.name);
    projectEntries.push({ ...summary, file, exported: file !== null });
    onProgress?.({ done: index + 1, total: snapshot.projects.length });
  }

  // Données fournies par le compte hors de ses projets (art. 15 et 20, A10-1) :
  // ses commentaires dans les projets partagés avec lui, ses vues, ses .fit
  // déposés ailleurs.
  const commentsInSharedProjects: Array<Record<string, unknown>> = [];
  for (const shared of snapshot.sharedProjects) {
    try {
      const row = await getProject(shared.id);
      for (const thread of row?.data.comments ?? []) {
        const mine = thread.messages.filter((message) => message.authorId === user.$id);
        if (mine.length > 0) {
          commentsInSharedProjects.push({
            projectId: shared.id,
            projectName: shared.name,
            threadId: thread.id,
            anchor: thread.anchor,
            messages: mine.map(({ id, text, createdAt, editedAt }) => ({ id, text, createdAt, editedAt })),
          });
        }
      }
    } catch (error) {
      console.warn('[account-export] projet partagé illisible', shared.id, error);
    }
  }
  const views: Array<Record<string, unknown>> = [];
  for (const id of [...snapshot.projects, ...snapshot.sharedProjects].map((project) => project.id)) {
    const stored = await readProjectView(id).catch(() => null);
    if (stored) views.push({ projectId: id, view: stored.view });
  }
  const otherFits = (await listOwnedFitFiles()).filter((file) => !exportedFitPaths.has(file.id));
  const fitEntries = await downloadProjectItineraryFitFileEntries(
    otherFits.map((file) => ({ path: file.id, name: file.name, type: 'application/octet-stream', lastModified: 0, size: 0 })),
  );
  const fitTaken = new Set<string>();
  let sharedFitFileCount = 0;
  for (const entry of fitEntries) {
    if (!entry.file) continue;
    await builder.add(`fit-partages/${uniqueEntryName(entry.name || `${entry.path}.fit`, fitTaken)}`, entry.file);
    sharedFitFileCount += 1;
  }

  const accountJson = {
    format: 'redview-account-export',
    version: 1,
    exportedAt: exportedAt.toISOString(),
    appBuild: APP_BUILD_ID,
    account: {
      id: user.$id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerification,
      registeredAt: user.registration,
      passwordUpdatedAt: user.passwordUpdate || null,
      preferences: user.prefs,
    },
    folders: snapshot.folders,
    projects: projectEntries,
    sharedWithMe: snapshot.sharedProjects.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
    commentsInSharedProjects,
    views,
  };
  const encoder = new TextEncoder();
  await builder.add('LISEZMOI.txt', encoder.encode(README) as Uint8Array<ArrayBuffer>);
  await builder.add('compte.json', encoder.encode(JSON.stringify(accountJson, null, 2)) as Uint8Array<ArrayBuffer>);

  const zip = builder.finish();
  const fileName = `redview-donnees-${exportedAt.toISOString().slice(0, 10)}.zip`;
  downloadBlob(zip, fileName);
  trackAnalyticsEvent({ name: 'account_data_exported', data: { projects: countBucket(snapshot.projects.length) } });
  return {
    fileName,
    sizeBytes: zip.size,
    projectCount: snapshot.projects.length - failedProjects.length,
    failedProjects,
    sharedFitFileCount,
  };
}
