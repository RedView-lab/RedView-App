import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { logger } from '@/shared/lib/logger';
import { notify } from '@/shared/lib/notify';

/**
 * État serveur (Appwrite, API) : TanStack Query. Pas pour le document de
 * l'éditeur (ProjectStore, autosave) ni pour la carte.
 *
 * Règles communes ici, à surcharger par requête :
 *  - données fraîches 30 s, gardées 5 min hors écran ;
 *  - pas de rechargement au retour sur l'onglet (sauf requêtes qui le demandent) ;
 *  - 2 nouvelles tentatives, jamais sur une erreur 4xx (session, droits, validation) ;
 *  - toute mutation en échec affiche un toast, sauf `meta.silentError`
 *    (la mutation gère son retour elle-même). `meta.errorMessage` = repli
 *    quand l'erreur n'a pas de message.
 */
declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      silentError?: boolean;
      errorMessage?: string;
    };
  }
}

const DEFAULT_ERROR_MESSAGE = 'Une erreur est survenue.';

function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

/** Erreur 4xx (AppwriteException.code, réponse HTTP) : réessayer ne sert à rien. */
function isClientError(error: unknown): boolean {
  const status = (error as { code?: unknown; status?: unknown } | null)?.code ?? (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function createAppQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        logger.app.warn('query failed', { queryKey: query.queryKey, error: errorMessage(error) });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        logger.app.warn('mutation failed', { mutationKey: mutation.options.mutationKey, error: errorMessage(error) });
        if (mutation.meta?.silentError) return;
        notify.error(errorMessage(error) ?? mutation.meta?.errorMessage ?? DEFAULT_ERROR_MESSAGE);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => failureCount < 2 && !isClientError(error),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** Client unique de l'app ; vidé à chaque changement de session (App.tsx). */
export const appQueryClient = createAppQueryClient();
