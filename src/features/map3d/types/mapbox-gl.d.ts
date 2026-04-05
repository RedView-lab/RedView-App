// Ensure this file is treated as a module (augmentation, not replacement)
export {};

declare module 'mapbox-gl' {
  interface ProtocolResponse {
    data: ArrayBuffer | ImageBitmap | string | null;
    cacheControl?: string;
    expires?: string;
  }

  interface ProtocolRequestParams {
    url: string;
    type: string;
  }

  type ProtocolHandler = (
    params: ProtocolRequestParams,
    abortController: AbortController,
  ) => Promise<ProtocolResponse>;

  // These exist at runtime in mapbox-gl v3 but are missing from @types/mapbox-gl
  function addProtocol(protocol: string, handler: ProtocolHandler): void;
  function removeProtocol(protocol: string): void;
}

