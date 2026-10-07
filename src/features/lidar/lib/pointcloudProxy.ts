/**
 * URL same-origin du proxy `/api/pointcloud` pour une source LiDAR publique
 * sans en-têtes CORS (sous-dalles AHN de GeoTiles, bandes DHMV II d'EODaS).
 * Le serveur n'accepte que les hôtes / chemins de son allowlist
 * (`resolvePointcloudUpstream`, server/lib/http-security.mjs).
 */
export function pointcloudProxyUrl(upstreamUrl: string): string {
  return `/api/pointcloud?url=${encodeURIComponent(upstreamUrl)}`;
}
