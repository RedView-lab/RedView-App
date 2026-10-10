import { CollabConnection, type CollabConnectionOptions } from './connection';

/**
 * Renomme un projet partagé hors de l'éditeur (gestionnaire de projets) : le
 * document d'un projet partagé appartient au serveur temps réel, et la ligne
 * `projects` n'en est que la copie (son nom suit au point de sauvegarde). Une
 * connexion courte à la salle écrit le nom à la racine, comme l'en-tête de
 * l'éditeur, attend que le serveur l'ait écrit, puis se ferme. Renommer la
 * seule ligne laissait la salle remettre l'ancien nom à l'ouverture (D3-2).
 */

type RenameOptions = Pick<CollabConnectionOptions, 'url' | 'projectId' | 'getToken' | 'WebSocketImpl'> & {
  name: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export function renameInRoom({ name, timeoutMs = DEFAULT_TIMEOUT_MS, ...options }: RenameOptions): Promise<void> {
  // Lus par la connexion : `durable` (écrit par le serveur) ne change pas toujours l'état publié.
  let onUnsynced = () => undefined as void;
  let onRejected = () => undefined as void;
  const connection = new CollabConnection({
    ...options,
    onUnsyncedChange: () => onUnsynced(),
    onRejection: () => onRejected(),
  });
  const client = connection.client;
  return new Promise<void>((resolve, reject) => {
    let renamed = false;
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      connection.stop();
      if (error) reject(error);
      else resolve();
    };
    onRejected = () => finish(new Error('Renommage du projet partagé refusé par le serveur'));
    const timer = setTimeout(() => finish(new Error('Renommage du projet partagé : serveur temps réel injoignable')), timeoutMs);
    const check = () => {
      if (done) return;
      const state = client.getState();
      if (state.status === 'denied') {
        finish(new Error(`Renommage du projet partagé refusé (${state.deniedReason ?? 'refus'})`));
        return;
      }
      if (!state.ready) return;
      if (!renamed) {
        renamed = true;
        const document = client.getDocument();
        if (document.name !== name) client.pushLocalDocument({ ...document, name }, 'user');
      }
      if (client.engine.fullySynced) finish();
    };
    onUnsynced = check;
    unsubscribe = client.subscribeState(check);
    connection.start();
  });
}
