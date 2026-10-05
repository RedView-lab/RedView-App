import { useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { getProjectThumbnailUrls } from '@/shared/utils/projects';

type ThumbnailMap = Record<string, string | null>;

const EMPTY_THUMBNAILS: ThumbnailMap = {};

function revokeThumbnailUrls(urls: Iterable<string | null>, keep?: ReadonlySet<string | null>) {
  for (const url of urls) {
    if (url && url.startsWith('blob:') && !keep?.has(url)) URL.revokeObjectURL(url);
  }
}

/**
 * Miniatures des projets listés (URLs `blob:`). Rechargées quand la liste est
 * relue du serveur (`listFetchedAt`) ou que ses projets changent (création,
 * import, duplication, suppression) ; la carte précédente reste affichée
 * pendant le chargement et seules les nouvelles cartes attendent. Les URLs
 * remplacées ou démontées sont libérées ; `gcTime: 0` empêche de resservir
 * une carte dont les URLs ont été libérées.
 */
export function useProjectThumbnails(userId: string | null, projectIds: string[], listFetchedAt: number) {
  const idsKey = projectIds.join('\n');
  const query = useQuery({
    queryKey: ['project-library', 'thumbnails', userId ?? 'anonymous', listFetchedAt, idsKey],
    queryFn: async ({ signal }) => {
      const map = await getProjectThumbnailUrls(idsKey ? idsKey.split('\n') : []);
      if (signal.aborted) {
        // Réponse d'une liste déjà remplacée : personne n'affichera ces URLs.
        revokeThumbnailUrls(Object.values(map));
        throw new DOMException('Thumbnails superseded', 'AbortError');
      }
      return map;
    },
    enabled: listFetchedAt > 0,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const thumbnails = query.data ?? EMPTY_THUMBNAILS;

  const shownRef = useRef<ThumbnailMap>(EMPTY_THUMBNAILS);
  useEffect(() => {
    const previous = shownRef.current;
    shownRef.current = thumbnails;
    if (previous !== thumbnails) revokeThumbnailUrls(Object.values(previous), new Set(Object.values(thumbnails)));
  }, [thumbnails]);
  useEffect(
    () => () => {
      revokeThumbnailUrls(Object.values(shownRef.current));
      shownRef.current = EMPTY_THUMBNAILS;
    },
    [],
  );

  const thumbnailLoadingIds = useMemo(() => {
    if (!query.isFetching || !idsKey) return new Set<string>();
    return new Set(idsKey.split('\n').filter((id) => !(id in thumbnails)));
  }, [query.isFetching, idsKey, thumbnails]);

  return { thumbnails, thumbnailLoadingIds };
}
