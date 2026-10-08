import { afterEach, describe, expect, it, vi } from 'vitest';
import { decompressProjectPayload, gzipProjectJson } from './compression';
import { MAX_CLOUD_PROJECT_PAYLOAD_CHARS } from './limits';
import { encodeProjectPayload, type PayloadWorkerRequest } from './payloadEncoding';

// Une limite de document de 200 000 caractères garde le cas hors limite petit (12 M dans l'application).
vi.mock('./limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./limits')>()),
  MAX_CLOUD_PROJECT_PAYLOAD_CHARS: 200_000,
}));

const project = {
  schema: 2,
  name: 'Chamonix → Paris',
  itineraries: [{ id: 'a', points: Array.from({ length: 2000 }, (_, i) => ({ lat: 45.9 + i * 1e-4, lon: 6.87, ele: 1035 + i })) }],
};

describe('encodeProjectPayload', () => {
  it('gives the document payload the app reads back', async () => {
    const json = JSON.stringify(project);
    const encoded = await encodeProjectPayload(json);
    expect(encoded.compressed).toBe(true);
    expect(encoded.gzip).toBeNull();
    expect(encoded.data!.startsWith('gz:')).toBe(true);
    await expect(decompressProjectPayload(encoded.data!)).resolves.toEqual(project);
  });

  it('keeps the gzip for the bucket when its base64 would not fit in the document', async () => {
    // Texte presque incompressible (~6,5 bits/caractère) : son gzip en base64 dépasse la limite du document.
    const bytes = new Uint8Array(400_000);
    let x = 2463534242; // xorshift32
    for (let i = 0; i < bytes.length; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      bytes[i] = 33 + (x % 94);
    }
    const json = JSON.stringify({ blob: new TextDecoder('latin1').decode(bytes) });
    const encoded = await encodeProjectPayload(json);
    expect(encoded.data).toBeNull();
    expect(encoded.gzip!.byteLength * 4 / 3).toBeGreaterThan(MAX_CLOUD_PROJECT_PAYLOAD_CHARS);
    expect(encoded.gzip).toEqual(await gzipProjectJson(json));
  });
});

/** Double du worker qui exécute le vrai encodeur, de façon asynchrone, comme payloadWorker.ts. */
function stubWorker(options: { crash?: boolean } = {}) {
  const created: unknown[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    constructor() {
      created.push(this);
    }
    postMessage(request: PayloadWorkerRequest) {
      setTimeout(async () => {
        if (options.crash) {
          this.onerror?.({ message: 'worker crashed' });
          return;
        }
        const encoded = await encodeProjectPayload(request.json);
        this.onmessage?.({ data: { id: request.id, ...encoded } } as MessageEvent);
      }, 1);
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  return created;
}

describe('encodeProjectPayloadOffThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('encodes in one shared worker, with the same result as in the page', async () => {
    const created = stubWorker();
    const { encodeProjectPayloadOffThread } = await import('./payloadEncodingClient');
    const json = JSON.stringify(project);
    const [a, b] = await Promise.all([encodeProjectPayloadOffThread(json), encodeProjectPayloadOffThread(`${json} `)]);
    expect(created).toHaveLength(1);
    expect(a).toEqual(await encodeProjectPayload(json));
    expect(b).toEqual(await encodeProjectPayload(`${json} `));
  });

  it('falls back to the page when the worker fails, and keeps doing so', async () => {
    const created = stubWorker({ crash: true });
    const { encodeProjectPayloadOffThread } = await import('./payloadEncodingClient');
    const json = JSON.stringify(project);
    await expect(encodeProjectPayloadOffThread(json)).resolves.toEqual(await encodeProjectPayload(json));
    await expect(encodeProjectPayloadOffThread(json)).resolves.toEqual(await encodeProjectPayload(json));
    expect(created).toHaveLength(1);
  });
});
