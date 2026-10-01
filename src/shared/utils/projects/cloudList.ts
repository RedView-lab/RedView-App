import { APPWRITE_DATABASE_ID, databases, Query } from '@/shared/services/appwrite';

/** Taille de page Appwrite (le défaut sans Query.limit est 25). */
export const CLOUD_LIST_PAGE_SIZE = 100;
/** Garde-fou contre une boucle infinie (100 000 documents). */
const MAX_PAGES = 1000;

type CloudDocument = { $id: string } & Record<string, unknown>;

/**
 * Liste tous les documents d'une collection correspondant à `queries`, page
 * par page (Query.limit + Query.cursorAfter) jusqu'à épuisement.
 */
export async function listAllCloudDocuments<T extends CloudDocument = CloudDocument>(
  collectionId: string,
  queries: string[],
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageQueries: string[] = [...queries, Query.limit(CLOUD_LIST_PAGE_SIZE)];
    if (cursor) pageQueries.push(Query.cursorAfter(cursor));
    const result = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, pageQueries);
    const documents = (result.documents ?? []) as unknown as T[];
    all.push(...documents);
    if (documents.length < CLOUD_LIST_PAGE_SIZE) break;
    cursor = documents[documents.length - 1].$id;
  }
  return all;
}

/**
 * Lit la première page (sans curseur) de documents correspondant à `queries`.
 * Pour les boucles « détacher jusqu'à épuisement » : les documents modifiés
 * sortent du filtre, la page suivante est simplement la nouvelle première page.
 */
export async function listFirstCloudPage<T extends CloudDocument = CloudDocument>(
  collectionId: string,
  queries: string[],
): Promise<T[]> {
  const result = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [
    ...queries,
    Query.limit(CLOUD_LIST_PAGE_SIZE),
  ]);
  return (result.documents ?? []) as unknown as T[];
}
