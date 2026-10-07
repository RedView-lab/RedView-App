import { describe, expect, it } from 'vitest';

import { openZip, readZipEntry } from './zipReader';
import { StoredZipBuilder, writeZip } from './zipWriter';

const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
const text = (data: Uint8Array) => new TextDecoder().decode(data);

async function readAll(blob: Blob): Promise<Record<string, string>> {
  const directory = await openZip(blob, { maxEntries: 100 });
  const out: Record<string, string> = {};
  for (const [name, entry] of directory.entries) out[name] = text(await readZipEntry(directory, entry, 1 << 24));
  return out;
}

describe('StoredZipBuilder', () => {
  it('relit chaque entrée à l’identique, Blob ou octets, noms UTF-8 compris', async () => {
    const builder = new StoredZipBuilder(new Date(2026, 9, 7, 12, 0, 0));
    await builder.add('LISEZMOI.txt', bytes('Bonjour'));
    await builder.add('projets/Étape 1.redview', new Blob([bytes('x'.repeat(10_000))]));
    await builder.add('compte.json', new Blob([bytes('{"a":1}')]));
    const zip = builder.finish();

    expect(zip.size).toBe(builder.size + (46 * 3 + 'LISEZMOI.txt'.length + 'compte.json'.length
      + new TextEncoder().encode('projets/Étape 1.redview').length) + 22);
    expect(await readAll(zip)).toEqual({
      'LISEZMOI.txt': 'Bonjour',
      'projets/Étape 1.redview': 'x'.repeat(10_000),
      'compte.json': '{"a":1}',
    });
  });

  it('refuse un nom en double ou absolu', async () => {
    const builder = new StoredZipBuilder();
    await builder.add('a.txt', bytes('1'));
    await expect(builder.add('a.txt', bytes('2'))).rejects.toThrow(/duplicate/);
    await expect(builder.add('/etc/passwd', bytes('2'))).rejects.toThrow(/invalid/);
  });

  it('produit les mêmes octets que writeZip pour des entrées stockées', async () => {
    const date = new Date(2026, 9, 7, 12, 0, 0);
    const builder = new StoredZipBuilder(date);
    await builder.add('mimetype', bytes('application/vnd.redview+zip'));
    await builder.add('b.bin', bytes('abc'));
    const fromBuilder = new Uint8Array(await builder.finish().arrayBuffer());
    const fromWriteZip = new Uint8Array(await (await writeZip([
      { name: 'mimetype', data: bytes('application/vnd.redview+zip'), compress: false },
      { name: 'b.bin', data: bytes('abc'), compress: false },
    ], date)).arrayBuffer());
    expect(fromBuilder).toEqual(fromWriteZip);
  });
});
