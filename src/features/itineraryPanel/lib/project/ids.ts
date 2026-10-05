/**
 * Identifiant d'un élément du document (itinéraire, ligne de feuille de route,
 * zone interdite, pause, profil perso…) : préfixe lisible + horodatage + aléa.
 * Deux appareils ou deux éditeurs qui créent un élément au même instant
 * n'obtiennent jamais le même id (un `Date.now()` seul le permettait) ; l'id
 * ne change plus ensuite, c'est lui qui apparie les éléments à la fusion.
 */
export function createDocumentId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomSuffix()}`;
}

function randomSuffix(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const [a, b] = cryptoApi.getRandomValues(new Uint32Array(2));
    return `${a.toString(36)}${b.toString(36)}`.slice(0, 10).padStart(10, '0');
  }
  return Math.random().toString(36).slice(2, 12).padEnd(10, '0');
}
