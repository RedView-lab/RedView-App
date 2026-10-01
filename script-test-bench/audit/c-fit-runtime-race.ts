/**
 * C6 — Ordonnancement des prédictions FIT.
 *
 * Utilise le VRAI client moteur (src/features/fitPredictor/engine/api.ts) avec
 * un Worker factice FIFO (même sémantique que worker.ts : un seul thread, les
 * messages sont traités l'un après l'autre, aucun abandon). La logique
 * then/catch/cancel du hook useItineraryFitRuntime/index.ts (l.480-628) est
 * reproduite à l'identique sur un petit état (React non disponible en Node) ;
 * on vérifie en plus, sur le texte source, que le .catch ne teste toujours pas
 * `runId` (garde-fou de régression).
 *
 * Usage : npx tsx script-test-bench/audit/c-fit-runtime-race.ts [--compute-ms=2000]
 * Sortie != 0 si un scénario reproduit un bug.
 */
import fs from 'node:fs';

const COMPUTE_MS = Number(process.argv.find((a) => a.startsWith('--compute-ms='))?.split('=')[1] ?? 1500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const t0 = Date.now();
const now = () => `${String(Date.now() - t0).padStart(5)} ms`;

// ── Worker factice : FIFO, mono-thread, plan d'échec par _id ─────────────
type Plan = { fail?: string };
let planFor: (id: number) => Plan = () => ({});
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  private queue: Array<{ _id: number }> = [];
  private busy = false;
  private dead = false;
  constructor(_url: unknown, _opts: unknown) {}
  postMessage(req: { _id: number }) { this.queue.push(req); void this.pump(); }
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && !this.dead) {
      const req = this.queue.shift()!;
      await sleep(COMPUTE_MS); // predict() est synchrone et bloque le worker
      if (this.dead) break;
      const p = planFor(req._id);
      this.onmessage?.({ data: p.fail
        ? { _id: req._id, type: 'error', message: p.fail }
        : { _id: req._id, type: 'result', action: 'predict', data: { total_time_s: 3600 * req._id, points: [] } } });
    }
    this.busy = false;
  }
  terminate() { this.dead = true; this.queue = []; }
}
(globalThis as { Worker?: unknown }).Worker = FakeWorker;
const { createFitPredictionEngine } = await import('../../src/features/fitPredictor/engine/api.ts');

// ── Modèle minimal du hook (copie des branches l.480-628) ────────────────
type Runtime = { status: 'idle' | 'ready' | 'running' | 'success' | 'error'; error: string | null; result: unknown };
type Proj = { signature: string; pendingFitRecompute?: boolean; prediction?: unknown };
function makeHook() {
  let engine = createFitPredictionEngine();
  const runtime: Record<string, Runtime> = {};
  const project: Record<string, Proj> = {};
  const latestRun: Record<string, number> = {};
  const cancelled = new Set<string>();
  const history: Record<string, string[]> = {};
  const setRt = (id: string, patch: Partial<Runtime>) => {
    runtime[id] = { ...(runtime[id] ?? { status: 'idle', error: null, result: null }), ...patch };
    (history[id] ??= []).push(`${now()} ${runtime[id]!.status}${runtime[id]!.error ? ` (${runtime[id]!.error})` : ''}`);
  };
  const calculate = (id: string) => {
    const inputSignature = project[id]!.signature;
    const runId = (latestRun[id] ?? 0) + 1;
    latestRun[id] = runId;
    cancelled.delete(id);
    setRt(id, { status: 'running', error: null, result: null });
    const gpx = new File(['<gpx/>'], 'r.gpx');
    void engine.predict([], gpx, {}, () => {})
      .then((raw) => {
        cancelled.delete(id);
        let applied = false;
        if (project[id]!.signature === inputSignature) {
          applied = true;
          project[id] = { ...project[id]!, prediction: raw, pendingFitRecompute: undefined };
        }
        if (!applied) {
          if (latestRun[id] === runId) setRt(id, { status: 'ready' });
          return;
        }
        setRt(id, { status: 'success', error: null, result: raw });
      })
      .catch((error: unknown) => {
        const wasCancelled = cancelled.has(id) && error instanceof Error && error.message === 'Prediction worker terminated';
        if (wasCancelled) { cancelled.delete(id); return; }
        project[id] = { ...project[id]!, pendingFitRecompute: undefined };
        setRt(id, { status: 'error', error: error instanceof Error ? error.message : String(error), result: null });
      });
    return runId;
  };
  const cancel = (id: string) => {
    if (runtime[id]?.status !== 'running') return;
    cancelled.add(id);
    engine.terminate();
    engine = createFitPredictionEngine();
    setRt(id, { status: 'ready', error: null });
  };
  return { calculate, cancel, runtime, project, history };
}

// ── Garde-fou source : le .catch ignore-t-il toujours runId ? ────────────
const src = fs.readFileSync('src/features/itineraryPanel/hooks/useItineraryFitRuntime/index.ts', 'utf8');
const catchBlock = src.slice(src.indexOf('.catch((error: unknown) => {'), src.indexOf('}, [active, predictionStore, setProject, updateFitRuntime]);'));
const catchChecksRunId = /latestPredictionRunRef\.current\[itineraryId\]\s*[!=]==\s*runId/.test(catchBlock);
const apiSrc = fs.readFileSync('src/features/fitPredictor/engine/api.ts', 'utf8');
const apiSupersedes = /supersed|abort|cancelPending|pending\.clear\(\)[\s\S]{0,80}postMessage/.test(apiSrc.slice(apiSrc.indexOf('function send')));
console.log(`source : .catch teste runId = ${catchChecksRunId} ; api.ts annule les requêtes dépassées = ${apiSupersedes}`);

// S1 — file d'attente : 5 modifications de rythme à 400 ms d'écart (> debounce 300 ms).
{
  planFor = () => ({});
  const h = makeHook();
  h.project.A = { signature: 's0' };
  let lastEditAt = 0;
  for (let k = 1; k <= 5; k++) {
    h.project.A.signature = `s${k}`;
    h.calculate('A');
    lastEditAt = Date.now();
    await sleep(400);
  }
  while (h.runtime.A?.status === 'running' || h.runtime.A?.status === 'ready') await sleep(20);
  const waitMs = Date.now() - lastEditAt;
  console.log(`\nS1 file d'attente : dernier réglage → résultat affiché en ${waitMs} ms (calcul unitaire ${COMPUTE_MS} ms)`);
  console.log(`   historique : ${h.history.A!.join(' | ')}`);
  if (waitMs > 2 * COMPUTE_MS) failures.push(`S1: 4 prédictions périmées calculées avant la bonne → ${waitMs} ms au lieu de ~${COMPUTE_MS} ms`);
}

// S2 — Annuler alors que 2 calculs du même itinéraire sont en file.
{
  planFor = () => ({});
  const h = makeHook();
  h.project.A = { signature: 'a', pendingFitRecompute: true };
  h.calculate('A');
  await sleep(50);
  h.project.A.signature = 'b';
  h.calculate('A');
  await sleep(50);
  h.cancel('A');
  await sleep(50);
  console.log(`\nS2 annulation avec 2 calculs en file : état final ${h.runtime.A!.status}${h.runtime.A!.error ? ` « ${h.runtime.A!.error} »` : ''}`);
  console.log(`   historique : ${h.history.A!.join(' | ')}`);
  if (h.runtime.A!.status === 'error') failures.push(`S2: « Annuler » affiche l'erreur « ${h.runtime.A!.error} » (2e requête rejetée non reconnue comme annulée)`);
}

// S3 — Annuler l'itinéraire A tue le calcul en file de l'itinéraire B (worker partagé).
{
  planFor = () => ({});
  const h = makeHook();
  h.project.A = { signature: 'a' };
  h.project.B = { signature: 'b' };
  h.calculate('A');
  h.calculate('B');
  await sleep(50);
  h.cancel('A');
  await sleep(50);
  console.log(`\nS3 annuler A pendant que B attend : B = ${h.runtime.B!.status}${h.runtime.B!.error ? ` « ${h.runtime.B!.error} »` : ''}`);
  if (h.runtime.B!.status === 'error') failures.push(`S3: annuler l'itinéraire A met l'itinéraire B en erreur « ${h.runtime.B!.error} »`);
}

// S4 — Échec d'un calcul périmé pendant que le calcul courant tourne.
{
  planFor = (id) => (id === 1 ? { fail: 'Error parsing FIT file #2: FIT: bad header signature' } : {});
  const h = makeHook();
  h.project.A = { signature: 'a', pendingFitRecompute: true };
  h.calculate('A');
  await sleep(50);
  h.project.A.signature = 'b';
  h.calculate('A');
  let sawErrorWhileRunning = false;
  let pendingClearedEarly = false;
  const end = Date.now() + 3 * COMPUTE_MS;
  while (Date.now() < end) {
    await sleep(20);
    if (h.runtime.A!.status === 'error') {
      sawErrorWhileRunning = true;
      if (h.project.A.pendingFitRecompute === undefined && h.project.A.prediction === undefined) pendingClearedEarly = true;
    }
    if (h.runtime.A!.status === 'success') break;
  }
  console.log(`\nS4 échec périmé pendant le calcul courant : erreur affichée alors que le run 2 tourne = ${sawErrorWhileRunning}, bouton réactivé (status != running) = ${sawErrorWhileRunning}, pendingFitRecompute effacé avant résultat = ${pendingClearedEarly}`);
  console.log(`   historique : ${h.history.A!.join(' | ')}`);
  if (sawErrorWhileRunning) failures.push('S4: l\'échec d\'un run périmé passe le run courant en « error » (le .catch ne vérifie pas runId)');
}

if (!catchChecksRunId) failures.push('source : le .catch de handleCalculatePrediction ne compare pas runId à latestPredictionRunRef');
console.log(failures.length ? `\nFAIL ${failures.length}:\n  - ${failures.join('\n  - ')}` : '\nOK');
process.exit(failures.length ? 1 : 0);
