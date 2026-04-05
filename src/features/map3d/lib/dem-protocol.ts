/**
 * DEPRECATED - DEM processing is now handled server-side by Vercel serverless function.
 * See: api/ign-dem/[z]/[x]/[y].ts
 *
 * mapbox-gl v3.21.0 removed addProtocol/removeProtocol, so client-side
 * custom DEM tile protocols are no longer possible. The processing pipeline
 * (IGN BIL decode -> WGS84G->Mercator resample -> Terrain-RGB encode) now runs
 * in the Vercel serverless function and serves standard PNG tiles that Mapbox
 * GL can consume directly as a raster-dem source.
 *
 * The unified DEM source is configured in sources.ts to point to /api/ign-dem/{z}/{x}/{y}.
 */

export {};