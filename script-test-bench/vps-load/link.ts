/**
 * Capacité du lien du générateur (le portable) vers le VPS, mesurée avant une
 * passe : tout le banc partage ce lien, et un lien saturé gonfle chaque
 * latence mesurée sans que le VPS y soit pour rien. Le rapport compare le
 * débit de chaque phase à cette capacité.
 *
 *  - descendant : 8 téléchargements parallèles des plus grosses ressources de
 *    l'app, sans compression (le corps fait la taille du fichier) ;
 *  - montant : 4 écritures parallèles de la charge du gros projet (1,8 Mo) sur
 *    le projet de calibrage du compte sonde, chronométrées jusqu'aux en-têtes
 *    de réponse, temps de traitement d'Appwrite (`X-Debug-Speed`) retranché.
 */
import { Client, Databases, Query } from 'appwrite';

import type { LoadTestSession } from './accounts.ts';
import { DATABASE_ID } from './vu.ts';

export interface LinkCapacity {
  downMbps: number;
  upMbps: number;
  rttMs: number;
}

export async function measureLink(appUrl: string, assets: string[], probe: LoadTestSession, payload: string, endpoint: string, project: string): Promise<LinkCapacity> {
  // Aller-retour : 5 petites requêtes sur une connexion réutilisée, médiane.
  const rtts: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const t0 = performance.now();
    await (await fetch(`${appUrl}/health`)).arrayBuffer();
    if (index > 0) rtts.push(performance.now() - t0);
  }
  rtts.sort((a, b) => a - b);

  const sizes = await Promise.all(assets.filter((asset) => asset.startsWith('/assets/')).map(async (asset) => {
    const response = await fetch(`${appUrl}${asset}`, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
    return { asset, bytes: Number(response.headers.get('content-length')) || 0 };
  }));
  const biggest = sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  const t0 = performance.now();
  const downloaded = await Promise.all(biggest.map(async ({ asset }) => {
    const response = await fetch(`${appUrl}${asset}?link=${Date.now()}`, { headers: { 'accept-encoding': 'identity' } });
    return (await response.arrayBuffer()).byteLength;
  }));
  const downSeconds = (performance.now() - t0) / 1000;
  const downMbps = (downloaded.reduce((sum, bytes) => sum + bytes, 0) * 8) / 1e6 / downSeconds;

  const client = new Client().setEndpoint(endpoint).setProject(project).setSession(probe.secret);
  const databases = new Databases(client);
  const own = await databases.listDocuments(DATABASE_ID, 'projects', [Query.equal('user_id', probe.userId), Query.select(['$id']), Query.limit(1)]);
  const target = own.documents[0]?.$id;
  let upMbps = Number.NaN;
  if (target) {
    const url = `${endpoint}/databases/${DATABASE_ID}/collections/projects/documents/${target}`;
    const body = JSON.stringify({ data: { data: payload } });
    // En-têtes reçus = corps envoyé + traitement d'Appwrite (retranché) ; l'écho n'est lu qu'ensuite.
    const t1 = performance.now();
    const results = await Promise.all(Array.from({ length: 4 }, async () => {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-appwrite-project': project, 'x-appwrite-session': probe.secret },
        body,
      });
      const headersS = (performance.now() - t1) / 1000;
      await response.arrayBuffer();
      return { headersS, serverS: Number(response.headers.get('x-debug-speed')) || 0 };
    }));
    const sendS = Math.max(...results.map((r) => r.headersS - r.serverS - rtts[0]! / 1000));
    upMbps = (Buffer.byteLength(body) * 4 * 8) / 1e6 / Math.max(0.05, sendS);
  }
  return { downMbps, upMbps, rttMs: rtts[Math.floor(rtts.length / 2)] ?? Number.NaN };
}
