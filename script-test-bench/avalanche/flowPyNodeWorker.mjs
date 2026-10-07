// Entry of a bench Flow-Py worker thread: tsx's loader is registered per
// thread, so register it here before loading the TypeScript worker.
import { register } from 'tsx/esm/api';

register();
await import('./flowPyNodeWorker.ts');
