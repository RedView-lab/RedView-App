import { describe, expect, it, vi } from 'vitest';
import { isProjectCloudError } from './errors';
import { encodeProjectPayload } from './payloadEncoding';

const downloadProjectPayloadFile = vi.fn();
vi.mock('./payloadFiles', () => ({
  downloadProjectPayloadFile: (...args: unknown[]) => downloadProjectPayloadFile(...args),
  isPayloadFilePointer: (data: unknown) => typeof data === 'string' && data.startsWith('file:'),
  pruneProjectPayloadFiles: vi.fn(),
  uploadProjectPayloadFile: vi.fn(),
}));
vi.mock('./payloadEncodingClient', () => ({ encodeProjectPayloadOffThread: vi.fn() }));
vi.mock('@/shared/services/appwrite', () => ({
  account: {},
  getAppwriteUser: vi.fn(),
  getSessionUserIdSync: () => null,
}));

const { docToProjectRow } = await import('./cloudDocuments');

const documentJson = JSON.stringify({ schema: 2, name: 'Chamonix → Paris', itineraries: [] });

function cloudDoc(data: unknown) {
  return { $id: 'p1', $createdAt: '2026-10-01T10:00:00Z', $updatedAt: '2026-10-07T10:00:00Z', user_id: 'u1', name: 'Chamonix → Paris', data };
}

async function readError(data: unknown) {
  const error = await docToProjectRow(cloudDoc(data)).then(() => null, (caught: unknown) => caught);
  expect(isProjectCloudError(error)).toBe(true);
  return error as { kind: string };
}

describe('docToProjectRow', () => {
  it('reads the gzip payload of the document', async () => {
    const row = await docToProjectRow(cloudDoc((await encodeProjectPayload(documentJson)).data));
    expect(row.data.name).toBe('Chamonix → Paris');
    expect(row.dirty).toBe(false);
  });

  // Un projet vide ouvert à la place serait enregistré par-dessus les vraies
  // données à la première modification.
  it('refuses a corrupted payload instead of opening an empty project', async () => {
    expect((await readError('gz:bm90IGd6aXA=')).kind).toBe('unreadable');
    expect((await readError('{"schema": 2, "name": ')).kind).toBe('unreadable');
  });

  it('refuses data that is not a project', async () => {
    expect((await readError(undefined)).kind).toBe('unreadable');
    expect((await readError(JSON.stringify({ hello: 'world' }))).kind).toBe('unreadable');
  });

  it('refuses a payload file that does not decompress, but a missing file stays retryable', async () => {
    downloadProjectPayloadFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]));
    expect((await readError('file:abc')).kind).toBe('unreadable');

    downloadProjectPayloadFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 404 }));
    const missing = await docToProjectRow(cloudDoc('file:abc')).then(() => null, (caught: unknown) => caught);
    expect(isProjectCloudError(missing)).toBe(false);
  });
});
