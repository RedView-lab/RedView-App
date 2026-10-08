// Jumeau worker_threads de src/features/lidar/workers/flowPyWorker.ts pour
// bench-avalanche : le même gestionnaire, pour que le banc chronomètre le pool
// du visualiseur.
import { parentPort } from 'node:worker_threads';
import {
  createFlowPyWorkerHandler,
  flowPyBlockTransfer,
  type FlowPyWorkerRequest,
} from '../../src/features/lidar/viewer/tools/terrain/avalanche/flowPyPool.ts';

const handle = createFlowPyWorkerHandler();
parentPort!.on('message', (request: FlowPyWorkerRequest) => {
  try {
    const response = handle(request);
    if (response?.type === 'block') parentPort!.postMessage(response, flowPyBlockTransfer(response.block));
    else if (response) parentPort!.postMessage(response);
  } catch (error) {
    parentPort!.postMessage({ type: 'error', job: request.job, message: (error as Error)?.message || String(error) });
  }
});
