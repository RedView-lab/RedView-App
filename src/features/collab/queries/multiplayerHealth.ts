import { useQuery } from '@tanstack/react-query';

/**
 * Serveur temps réel joignable (`/multiplayer/health`) : sans lui, on ne
 * propose pas de partager un projet (un projet partagé n'est enregistré que
 * par ce serveur). Module léger, sans le moteur de co-édition : importé par le
 * gestionnaire de projets comme par l'éditeur.
 */

/** URL WebSocket du serveur temps réel (même origine, ou `VITE_MULTIPLAYER_URL`). */
export function multiplayerSocketUrl(): string {
  const configured = import.meta.env.VITE_MULTIPLAYER_URL as string | undefined;
  if (configured) return configured;
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/multiplayer`;
}

async function isMultiplayerAvailable(): Promise<boolean> {
  const url = new URL(multiplayerSocketUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/health`;
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    // Sans le service, le serveur de l'app répond 200 avec index.html (SPA) :
    // seule la réponse JSON du serveur temps réel compte.
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

export function useMultiplayerAvailable(): boolean {
  const { data } = useQuery({
    queryKey: ['multiplayer', 'health'],
    queryFn: isMultiplayerAvailable,
    staleTime: 60_000,
    retry: false,
    meta: { silentError: true },
  });
  return data === true;
}
