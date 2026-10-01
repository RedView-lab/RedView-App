/**
 * C1 — api/poi.ts sur échec amont : le serveur local (npm start, :3000) a un
 * POI_UPSTREAM qui répond 403 depuis cette machine. On vérifie ce que le
 * proxy renvoie au navigateur.
 *
 * Usage : node script-test-bench/audit/c-poi-upstream-failure.mjs [baseUrl]
 * Sortie != 0 si un échec amont est converti en « 200 + 0 POI » (indiscernable
 * d'un corridor réellement vide → l'UI affiche 0 POI sans erreur).
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

async function probe(label, url, init) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    console.log(`${label}: serveur injoignable (${e.message}) — lancer \`npm start\``);
    process.exit(3);
  }
  const text = await res.text();
  console.log(`${label.padEnd(34)} HTTP ${res.status} en ${Date.now() - t0} ms  cache-control=${res.headers.get('cache-control')}  corps=${text.slice(0, 100)}`);
  return { status: res.status, text, cache: res.headers.get('cache-control') };
}

const health = await probe('health (amont brut)', `${BASE}/api/poi?op=health`);
await sleep(500);
const bbox = await probe('bbox Annecy', `${BASE}/api/poi?op=bbox&categories=drinking_water,toilets&south=45.88&west=6.10&north=45.92&east=6.16`);
await sleep(500);
const corridor = await probe('corridor 2 points', `${BASE}/api/poi?op=corridor`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ points: [[45.9, 6.12], [45.91, 6.13]], radiusM: 500, categories: ['drinking_water'] }),
});

const upstreamDown = health.status >= 400;
console.log(`\nAmont en échec (health ${health.status}) : ${upstreamDown ? 'oui' : 'non'}`);
for (const [name, r] of [['bbox', bbox], ['corridor', corridor]]) {
  let empty = false;
  try { empty = r.status === 200 && Array.isArray(JSON.parse(r.text).features) && JSON.parse(r.text).features.length === 0; } catch { /* */ }
  if (upstreamDown && empty) failures.push(`${name}: amont en échec → 200 {features:[]} (erreur masquée)`);
}
console.log(failures.length ? `\nFAIL\n  - ${failures.join('\n  - ')}` : '\nOK');
process.exitCode = failures.length ? 1 : 0;
