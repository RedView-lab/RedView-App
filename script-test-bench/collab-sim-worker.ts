/**
 * Processus de calcul de test-collab.ts : exécute des graines du simulateur
 * de co-édition (déterministes, indépendantes) et renvoie leurs rapports par
 * IPC. Messages : `{ type: 'run', job, options }` → `{ type: 'report', job,
 * report, ms }`.
 */
import { runSimulation, type SimulationOptions } from '../src/features/collab/sim/simulator.ts';

process.on('message', (message: { type: string; job: number; options: SimulationOptions }) => {
  if (message.type !== 'run') return;
  const started = performance.now();
  const report = runSimulation(message.options);
  process.send!({ type: 'report', job: message.job, report, ms: performance.now() - started });
});

process.on('disconnect', () => process.exit(0));
