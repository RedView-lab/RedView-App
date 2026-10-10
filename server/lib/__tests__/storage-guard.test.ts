import { describe, expect, it } from 'vitest';

import { createStorageGuard, fileOwnerId, hasExpectedSignature, planQuotaEvictions } from '../storage-guard.mjs';

const FIT_HEAD = Uint8Array.from([14, 0x10, 0, 0, 0, 0, 0, 0, ...'.FIT'.split('').map((c) => c.charCodeAt(0)), 0, 0]);
const GZIP_HEAD = Uint8Array.from([0x1f, 0x8b, 8, 0]);
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_HEAD = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
const JUNK = new TextEncoder().encode('not a real file!');

const MB = 1024 ** 2;

interface FakeFile {
  $id: string;
  $createdAt: string;
  $permissions: string[];
  sizeOriginal: number;
  name: string;
  chunksTotal: number;
  chunksUploaded: number;
  head: Uint8Array;
}

/** Faux Appwrite Storage : trois buckets en mémoire, horloge pilotée par le test. */
function fakeAppwrite() {
  let clock = Date.parse('2026-10-10T12:00:00Z');
  const buckets = new Map<string, Map<string, FakeFile>>([
    ['project-thumbnails', new Map()],
    ['itinerary-fit-files', new Map()],
    ['project-payloads', new Map()],
  ]);
  const reports: { message: string; extra?: Record<string, unknown> }[] = [];
  let seq = 0;
  const add = (bucketId: string, owner: string | null, size: number, head: Uint8Array, chunks = { total: 1, uploaded: 1 }, name = '') => {
    seq += 1;
    const id = `f${String(seq).padStart(4, '0')}`;
    buckets.get(bucketId)!.set(id, {
      $id: id,
      $createdAt: new Date(clock).toISOString(),
      $permissions: owner ? [`read("user:${owner}")`, `update("user:${owner}")`, `delete("user:${owner}")`] : [],
      sizeOriginal: size,
      name,
      chunksTotal: chunks.total,
      chunksUploaded: chunks.uploaded,
      head,
    });
    return id;
  };
  const deps = {
    now: () => clock,
    report: (error: Error, extra?: Record<string, unknown>) => { reports.push({ message: error.message, extra }); },
    async listFiles(bucketId: string, sinceIso: string | null, cursor: string | null) {
      const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
      const all = [...buckets.get(bucketId)!.values()]
        .filter((file) => Date.parse(file.$createdAt) >= since)
        .sort((a, b) => a.$id.localeCompare(b.$id))
        .filter((file) => cursor === null || file.$id > cursor);
      return { files: all.slice(0, 100) };
    },
    async getFile(bucketId: string, fileId: string) {
      return buckets.get(bucketId)!.get(fileId) ?? null;
    },
    async readHead(bucketId: string, fileId: string, bytes: number) {
      const file = buckets.get(bucketId)!.get(fileId);
      if (!file) throw Object.assign(new Error('not found'), { code: 404 });
      return file.head.subarray(0, bytes);
    },
    async deleteFile(bucketId: string, fileId: string) {
      if (!buckets.get(bucketId)!.delete(fileId)) throw Object.assign(new Error('not found'), { code: 404 });
    },
  };
  return {
    deps,
    add,
    reports,
    has: (bucketId: string, fileId: string) => buckets.get(bucketId)!.has(fileId),
    advance(ms: number) { clock += ms; },
  };
}

describe('signatures de contenu', () => {
  it('reconnaît FIT, gzip et images ; refuse des octets quelconques', () => {
    expect(hasExpectedSignature('fit', FIT_HEAD)).toBe(true);
    expect(hasExpectedSignature('gzip', GZIP_HEAD)).toBe(true);
    expect(hasExpectedSignature('image', PNG_HEAD)).toBe(true);
    expect(hasExpectedSignature('image', WEBP_HEAD)).toBe(true);
    expect(hasExpectedSignature('image', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    for (const kind of ['fit', 'gzip', 'image']) expect(hasExpectedSignature(kind, JUNK)).toBe(false);
    expect(hasExpectedSignature('gzip', FIT_HEAD)).toBe(false);
  });

  it('propriétaire = rôle de la permission delete, jamais une équipe', () => {
    expect(fileOwnerId({ $permissions: ['read("team:pX")', 'delete("user:abc")'] })).toBe('abc');
    expect(fileOwnerId({ $permissions: ['read("team:pX")'] })).toBeNull();
  });
});

describe('planQuotaEvictions', () => {
  it('retire les fichiers neufs les plus récents jusqu’à repasser sous le plafond, jamais les anciens', () => {
    const usage = new Map([
      ['u1', new Map([
        ['project-payloads/old', { size: 30, createdAt: 1, bucketId: 'project-payloads' }],
        ['project-payloads/new1', { size: 30, createdAt: 10, bucketId: 'project-payloads' }],
        ['project-payloads/new2', { size: 30, createdAt: 20, bucketId: 'project-payloads' }],
      ])],
    ]);
    const plan = planQuotaEvictions(usage, new Set(['project-payloads/new1', 'project-payloads/new2']), 50);
    expect(plan.map((entry) => entry.fileId)).toEqual(['new2', 'new1']);
    expect(planQuotaEvictions(usage, new Set(), 50)).toEqual([]);
  });
});

describe('garde des buckets (A15-3)', () => {
  it('un compte qui remplit un bucket au-delà de son plafond voit ses nouveaux envois retirés et signalés', async () => {
    const app = fakeAppwrite();
    const legit = app.add('itinerary-fit-files', 'alice', 5 * MB, FIT_HEAD);
    const guard = createStorageGuard({ ...app.deps, options: { perUserBytes: 100 * MB } });
    expect(await guard.runOnce()).toBe(0);

    app.advance(5 * 60_000);
    const flood = Array.from({ length: 6 }, () => app.add('project-payloads', 'mallory', 30 * MB, GZIP_HEAD));
    const aliceNew = app.add('project-thumbnails', 'alice', 1 * MB, PNG_HEAD);
    app.advance(60_000);
    const removed = await guard.runOnce();

    expect(removed).toBe(3);
    expect(flood.filter((id) => app.has('project-payloads', id))).toHaveLength(3);
    expect(guard.usageOf('mallory')).toBe(90 * MB);
    expect(app.has('itinerary-fit-files', legit)).toBe(true);
    expect(app.has('project-thumbnails', aliceNew)).toBe(true);
    expect(app.reports.filter((r) => r.extra?.reason === 'over-quota')).toHaveLength(3);
    // Aucun nom de fichier dans le rapport : identifiants et tailles seulement.
    expect(JSON.stringify(app.reports)).not.toMatch(/name/);
  });

  it('un fichier dont le contenu n’a pas la forme de son bucket est supprimé', async () => {
    const app = fakeAppwrite();
    const guard = createStorageGuard({ ...app.deps });
    await guard.runOnce();
    app.advance(60_000);
    const fake = app.add('project-payloads', 'mallory', 30 * MB, JUNK);
    const fakeFit = app.add('itinerary-fit-files', 'mallory', 10 * MB, GZIP_HEAD);
    const realFit = app.add('itinerary-fit-files', 'bob', 2 * MB, FIT_HEAD);
    app.advance(60_000);
    expect(await guard.runOnce()).toBe(2);
    expect(app.has('project-payloads', fake)).toBe(false);
    expect(app.has('itinerary-fit-files', fakeFit)).toBe(false);
    expect(app.has('itinerary-fit-files', realFit)).toBe(true);
    expect(app.reports.map((r) => r.extra?.reason)).toEqual(['bad-content', 'bad-content']);
  });

  it('fichiers sans propriétaire utilisateur (instantanés du serveur temps réel) : jamais touchés', async () => {
    const app = fakeAppwrite();
    const snapshot = app.add('project-payloads', null, 50 * MB, JUNK);
    const guard = createStorageGuard({ ...app.deps, options: { perUserBytes: 1 } });
    await guard.runOnce();
    expect(app.has('project-payloads', snapshot)).toBe(true);
    expect(app.reports).toEqual([]);
  });

  it('envoi par morceaux : laissé pendant qu’il avance, supprimé une fois abandonné', async () => {
    const app = fakeAppwrite();
    const guard = createStorageGuard({ ...app.deps, options: { incompleteGraceMs: 60 * 60_000 } });
    const partial = app.add('project-payloads', 'carol', 10 * MB, GZIP_HEAD, { total: 6, uploaded: 2 });
    await guard.runOnce();
    app.advance(30 * 60_000);
    await guard.runOnce();
    expect(app.has('project-payloads', partial)).toBe(true);
    app.advance(31 * 60_000);
    expect(await guard.runOnce()).toBe(1);
    expect(app.has('project-payloads', partial)).toBe(false);
    expect(app.reports[0]?.extra?.reason).toBe('abandoned-chunks');
  });

  it('mode « report » : signale sans rien supprimer', async () => {
    const app = fakeAppwrite();
    const guard = createStorageGuard({ ...app.deps, enforce: false });
    await guard.runOnce();
    app.advance(60_000);
    const fake = app.add('project-payloads', 'mallory', 30 * MB, JUNK);
    expect(await guard.runOnce()).toBe(0);
    expect(app.has('project-payloads', fake)).toBe(true);
    expect(app.reports[0]?.message).toMatch(/would remove/);
  });

  it('un compte déjà au-dessus du plafond au démarrage est signalé, sans suppression', async () => {
    const app = fakeAppwrite();
    const old = app.add('project-payloads', 'dave', 30 * MB, GZIP_HEAD);
    const guard = createStorageGuard({ ...app.deps, options: { perUserBytes: 10 * MB } });
    expect(await guard.runOnce()).toBe(0);
    expect(app.has('project-payloads', old)).toBe(true);
    expect(app.reports).toEqual([expect.objectContaining({ extra: expect.objectContaining({ reason: 'over-quota-existing', ownerId: 'dave' }) })]);
  });

  it('plus de 100 fichiers : la liste est parcourue page par page', async () => {
    const app = fakeAppwrite();
    for (let index = 0; index < 250; index += 1) app.add('itinerary-fit-files', 'erin', 1, FIT_HEAD);
    const guard = createStorageGuard({ ...app.deps });
    await guard.runOnce();
    expect(guard.usageOf('erin')).toBe(250);
  });

  it('stock existant au démarrage : un contenu inattendu est signalé, jamais effacé', async () => {
    const app = fakeAppwrite();
    const legacy = app.add('project-thumbnails', 'dave', 1 * MB, JUNK);
    app.advance(1_000);
    const guard = createStorageGuard({ ...app.deps });
    expect(await guard.runOnce()).toBe(0);
    expect(app.has('project-thumbnails', legacy)).toBe(true);
    expect(app.reports.map((r) => r.extra?.reason)).toEqual(['bad-content-existing']);
  });

  it('au-delà du plafond, la charge la plus récente de chaque projet (sa dernière sauvegarde) est gardée', async () => {
    const app = fakeAppwrite();
    const guard = createStorageGuard({ ...app.deps, options: { perUserBytes: 40 * MB } });
    await guard.runOnce();
    app.advance(60_000);
    const older = app.add('project-payloads', 'erin', 30 * MB, GZIP_HEAD, undefined, 'p1.json.gz');
    app.advance(1_000);
    const latest = app.add('project-payloads', 'erin', 30 * MB, GZIP_HEAD, undefined, 'p1.json.gz');
    app.advance(60_000);
    expect(await guard.runOnce()).toBe(1);
    expect(app.has('project-payloads', latest)).toBe(true);
    expect(app.has('project-payloads', older)).toBe(false);
  });
});
