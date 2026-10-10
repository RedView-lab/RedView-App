/**
 * Pop-ins de confirmation et de saisie de l'application, à la place de
 * `window.confirm` / `window.prompt` : même apparence que les autres pop-ins
 * (`.rv-dialog`, shared/styles/dialog.css), et la page continue de vivre
 * derrière (carte, co-édition, sauvegarde automatique) — un dialogue natif
 * fige tout l'onglet tant qu'il est ouvert.
 *
 * Rendues par `AppDialogHost` (shared/components/AppDialog), que `AppDialogGate`
 * (monté une fois dans App) charge à la demande ; le visualiseur LiDAR monte le
 * sien (`mountStandaloneAppDialogHost`).
 * Les textes arrivent déjà traduits (`t(...)` ou `translateAppText(...)`).
 * Une seule pop-in à la fois : les demandes suivantes attendent leur tour.
 */

export type ConfirmDialogOptions = {
  title: string;
  message?: string;
  /** Libellé du bouton principal (l'action, p. ex. « Supprimer »). */
  confirmLabel: string;
  /** « Annuler » par défaut. */
  cancelLabel?: string;
};

export type PromptDialogOptions = {
  title: string;
  /** Libellé du champ. */
  label: string;
  initialValue?: string;
  confirmLabel: string;
  cancelLabel?: string;
  maxLength?: number;
};

export type AppDialogRequest =
  | { id: number; kind: 'confirm'; options: ConfirmDialogOptions }
  | { id: number; kind: 'prompt'; options: PromptDialogOptions };

type Pending = { request: AppDialogRequest; resolve: (value: boolean | string | null) => void };

let nextId = 1;
let queue: Pending[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function enqueue(request: AppDialogRequest): Promise<boolean | string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { request, resolve }];
    if (queue.length === 1) emit();
  });
}

/** Pop-in affichée (la plus ancienne demande en attente), lue par AppDialogHost. */
export function getCurrentAppDialog(): AppDialogRequest | null {
  return queue[0]?.request ?? null;
}

export function subscribeAppDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Réponse de la pop-in `id` : `true` / le texte saisi (sans espaces autour)
 * pour le bouton principal, `false` / `null` pour Annuler, Échap ou un clic
 * hors de la carte. Une réponse à une pop-in déjà fermée est ignorée.
 */
export function answerAppDialog(id: number, value: boolean | string | null): void {
  const current = queue[0];
  if (!current || current.request.id !== id) return;
  queue = queue.slice(1);
  emit();
  current.resolve(value);
}

/** Vrai si l'utilisateur confirme ; faux s'il annule, appuie sur Échap ou clique à côté. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return enqueue({ id: nextId++, kind: 'confirm', options }).then((value) => value === true);
}

/** Texte saisi, sans espaces autour (jamais vide) ; null si l'utilisateur annule. */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return enqueue({ id: nextId++, kind: 'prompt', options }).then((value) => (typeof value === 'string' ? value : null));
}
