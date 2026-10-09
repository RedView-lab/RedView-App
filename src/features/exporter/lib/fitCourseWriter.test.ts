import { Decoder, Encoder, Profile, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';

import { FitCourseWriter, encodeFitString } from './fitCourseWriter';

const M = Profile.MesgNum;

function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** A course file's messages, shaped like exportFit's (random sizes, names, gaps). */
function courseMessages(seed: number, points: number): Array<[number, Record<string, unknown>]> {
  const rnd = seeded(seed);
  const start = new Date(Date.UTC(2026, 9, 6, 6, 30));
  const at = (i: number) => new Date(start.getTime() + i * 1000);
  const semicircles = (deg: number) => Math.round((deg * 2 ** 31) / 180);
  const records = Array.from({ length: points }, (_, i) => {
    const record: Record<string, unknown> = {
      timestamp: at(i),
      positionLat: semicircles(45 + i * 0.0001 + rnd() * 1e-5),
      positionLong: semicircles(6 + Math.sin(i / 300) * 0.02),
      distance: Math.round(i * 11.13 * 100) / 100 + rnd() * 0.004,
    };
    // Quelques points sans altitude : la définition du record alterne.
    if (rnd() > 0.1) record.altitude = Math.round((800 + 400 * Math.sin(i / 700) + rnd()) * 10) / 10;
    return record;
  });
  const names = ['Col de la Croix-Fry', 'Boulangerie « Chez Zoé »', 'Fontaine', 'Refuge 🏔', '', 'Ravito', 'Gîte d’étape du Lac', 'É', 'Hôtel des Alpes et du Mont-Blanc'];
  const types = ['water', 'food', 'summit', 'checkpoint', 'shelter', 'firstAid', 'store', 'generic'];
  const messages: Array<[number, Record<string, unknown>]> = [
    [M.FILE_ID, { type: 'course', manufacturer: 'development', product: 4242, serialNumber: 1_791_000_000, timeCreated: start }],
    [M.COURSE, { name: `Parcours ${seed} — Chamonix → Paris`, sport: seed % 2 ? 'running' : 'cycling' }],
    [M.LAP, {
      startTime: at(0),
      timestamp: at(points - 1),
      startPositionLat: records[0]!.positionLat,
      startPositionLong: records[0]!.positionLong,
      endPositionLat: records[points - 1]!.positionLat,
      endPositionLong: records[points - 1]!.positionLong,
      totalDistance: records[points - 1]!.distance,
    }],
    [M.EVENT, { timestamp: at(0), event: 'timer', eventType: 'start' }],
    ...records.map((record): [number, Record<string, unknown>] => [M.RECORD, record]),
  ];
  // Plus de 16 formes de course point (longueurs de nom) : les emplacements de message local bouclent.
  for (let k = 0; k < 40; k++) {
    const record = records[Math.floor(rnd() * points)]!;
    const name = `${names[k % names.length]}${'·'.repeat(k % 23)}`;
    messages.push([M.COURSE_POINT, {
      messageIndex: k,
      timestamp: record.timestamp,
      name: name || undefined,
      type: types[k % types.length],
      positionLat: record.positionLat,
      positionLong: record.positionLong,
      distance: record.distance,
    }]);
  }
  messages.push([M.EVENT, { timestamp: at(points - 1), event: 'timer', eventType: 'stopDisableAll' }]);
  return messages;
}

function encodeWithSdk(messages: Array<[number, Record<string, unknown>]>): Uint8Array {
  const encoder = new Encoder();
  for (const [mesgNum, mesg] of messages) encoder.onMesg(mesgNum, mesg);
  return encoder.close();
}

function encodeWithWriter(messages: Array<[number, Record<string, unknown>]>): Uint8Array {
  const writer = new FitCourseWriter();
  for (const [mesgNum, mesg] of messages) writer.write(mesgNum, mesg);
  return writer.close();
}

/** Indice du premier octet différent, -1 si identiques. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe('FitCourseWriter', () => {
  it('writes the same bytes as the Garmin SDK encoder', () => {
    for (const [seed, points] of [[1, 2], [2, 300], [3, 5_000], [4, 1]] as const) {
      const messages = courseMessages(seed, points);
      const ours = encodeWithWriter(messages);
      const sdk = encodeWithSdk(messages);
      expect(ours.length).toBe(sdk.length);
      expect(firstDifference(ours, sdk)).toBe(-1);
    }
  });

  it('noms trop longs pour un champ FIT (> 254 octets) : coupés sur un caractère, fichier toujours lisible', () => {
    // Le SDK refuse ces messages ; l'écrivain débordait l'octet de taille et corrompait tout le fichier.
    const longName = '東京ライド'.repeat(30); // 450 octets UTF-8
    const emojiName = '🚴'.repeat(80); // 320 octets
    const messages = courseMessages(5, 50).map(([num, mesg]): [number, Record<string, unknown>] => {
      if (num === M.COURSE) return [num, { ...mesg, name: longName }];
      if (num === M.COURSE_POINT && mesg.messageIndex === 0) return [num, { ...mesg, name: emojiName }];
      return [num, mesg];
    });
    const decoder = new Decoder(Stream.fromByteArray(Array.from(encodeWithWriter(messages))));
    expect(decoder.checkIntegrity()).toBe(true);
    const { messages: decoded, errors } = decoder.read();
    expect(errors).toEqual([]);
    const courseName = decoded.courseMesgs?.[0]?.name as string;
    expect(new TextEncoder().encode(courseName).length).toBeLessThanOrEqual(254);
    expect(longName.startsWith(courseName)).toBe(true);
    expect(courseName).not.toContain('\uFFFD');
    const pointName = decoded.coursePointMesgs?.[0]?.name as string;
    expect(emojiName.startsWith(pointName)).toBe(true);
    expect(decoded.recordMesgs?.length).toBe(50);
    expect(decoded.coursePointMesgs?.length).toBe(40);
  });

  it('encodeFitString : intact sous la borne, jamais coupé au milieu d’un caractère', () => {
    expect(encodeFitString('Col du Galibier').length).toBe(15);
    expect(encodeFitString('a'.repeat(300)).length).toBe(254);
    // 'é' = 2 octets : 127 × 2 = 254 tient, le 128e est laissé
    expect(new TextDecoder('utf-8', { fatal: true }).decode(encodeFitString('é'.repeat(200)))).toBe('é'.repeat(127));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(encodeFitString('x' + '🚴'.repeat(100)))).toBe('x' + '🚴'.repeat(63));
  });

  it('refuses a message with no known field, like the SDK', () => {
    expect(() => new FitCourseWriter().write(M.RECORD, { notAField: 1 })).toThrow();
  });
});
