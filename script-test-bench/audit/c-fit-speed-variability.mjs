import fs from 'node:fs';
import { Decoder, Stream } from '@garmin/fitsdk';
for (const f of process.argv.slice(2)) {
  const d = new Decoder(Stream.fromByteArray(fs.readFileSync(f)));
  const { messages } = d.read();
  const recs = messages.recordMesgs ?? [];
  const sp = [];
  for (let i = 1; i < recs.length; i++) {
    const a = recs[i - 1], b = recs[i];
    const dt = (new Date(b.timestamp) - new Date(a.timestamp)) / 1000;
    const dd = (b.distance ?? 0) - (a.distance ?? 0);
    if (dt > 0 && dd > 0) sp.push(dd / dt);
  }
  const m = sp.reduce((s, v) => s + v, 0) / sp.length;
  const sd = Math.sqrt(sp.reduce((s, v) => s + (v - m) ** 2, 0) / sp.length);
  const dts = recs.slice(1).map((r, i) => (new Date(r.timestamp) - new Date(recs[i].timestamp)) / 1000).sort((a, b) => a - b);
  console.log(f.split(/[\/]/).pop(), 'n', recs.length, 'speed mean', (m * 3.6).toFixed(1), 'CV', (sd / m).toFixed(3), 'median dt', dts[dts.length >> 1], 'file_id', JSON.stringify(messages.fileIdMesgs?.[0]?.type));
}
