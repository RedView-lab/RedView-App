/// <reference lib="webworker" />

// Un worker du pool Flow-Py des avalanches (viewer/tools/terrain/avalanche/
// flowPyPool.ts) : exécute les blocs de cellules de départ qu'on lui confie.

import {
  createFlowPyWorkerHandler,
  flowPyBlockTransfer,
  type FlowPyWorkerRequest,
} from '../viewer/tools/terrain/avalanche/flowPyPool';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const handle = createFlowPyWorkerHandler();

workerScope.onmessage = (e: MessageEvent<FlowPyWorkerRequest>) => {
  try {
    const response = handle(e.data);
    if (response?.type === 'block') workerScope.postMessage(response, flowPyBlockTransfer(response.block));
    else if (response) workerScope.postMessage(response);
  } catch (err: unknown) {
    workerScope.postMessage({ type: 'error', job: e.data.job, message: (err as Error)?.message || String(err) });
  }
};
