// Entrée d'un thread worker Flow-Py du banc : le chargeur de tsx s'enregistre
// par thread, donc on l'enregistre ici avant de charger le worker TypeScript.
import { register } from 'tsx/esm/api';

register();
await import('./flowPyNodeWorker.ts');
