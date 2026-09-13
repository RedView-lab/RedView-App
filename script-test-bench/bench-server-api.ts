/**
 * RedView Test-Bench : Serveur & API (Routing, Rate Limiting, Cache LRU & Sécurité)
 * 
 * Benchmarks :
 * 1. Débit de l'algorithme de Rate Limiting en mémoire (10 000 requêtes)
 * 2. Efficacité et éviction du Cache LRU (setLru sous 10k insertions / capacité 1k)
 * 3. Résolution d'IP client derrière reverse proxy Traefik / Coolify / Cloudflare
 * 4. Validation anti Path-Traversal sur les chemins de fichiers statiques
 * 5. Formatage et latence du endpoint de santé (/health, /api/health)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import path from 'node:path';

export async function runServerApiBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Serveur & Infrastructure API (Node.js & Coolify)');
  const iterations = options.quick ? 5 : 20;

  // --- BENCHMARK 1 : Débit de l'algorithme de Rate Limiting (10 000 requêtes simulées) ---
  const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
  suite.measureSync(
    {
      name: 'Vérification Rate Limiting IP (10k requêtes)',
      category: 'server-rate-limit',
      iterations,
      regressionThresholdP95Ms: 5.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let allowed = 0;
      const now = Date.now();
      for (let i = 0; i < 10_000; i++) {
        const ip = `192.168.1.${i % 250}`;
        const key = `${ip}:general`;
        const record = rateLimitMap.get(key);
        if (!record || now > record.resetTime) {
          rateLimitMap.set(key, { count: 1, resetTime: now + 60000 });
          allowed++;
        } else {
          record.count += 1;
          if (record.count <= 120) allowed++;
        }
      }
      return allowed;
    },
  );

  // --- BENCHMARK 2 : Cache LRU (10 000 insertions avec éviction / capacité 1 024) ---
  const lruCache = new Map<string, unknown>();
  suite.measureSync(
    {
      name: 'Cache LRU Éviction & Insertion (10k ops, cap 1024)',
      category: 'server-cache',
      iterations,
      regressionThresholdP95Ms: 12.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      for (let i = 0; i < 10_000; i++) {
        const key = `tile-12-${i % 2000}-${i % 1500}`;
        setLru(lruCache, key, { data: 'mock_tile_buffer', size: 1024 }, 1024);
      }
      return lruCache.size;
    },
  );

  // --- BENCHMARK 3 : Résolution d'IP Client sécurisée (Traefik / Docker / Cloudflare) ---
  suite.measureSync(
    {
      name: 'Résolution IP Forwarded Headers (10k requêtes)',
      category: 'server-security',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 2.5,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let count = 0;
      for (let i = 0; i < 10_000; i++) {
        const headers = {
          'cf-connecting-ip': i % 2 === 0 ? '198.51.100.42' : undefined,
          'x-forwarded-for': '203.0.113.195, 172.18.0.2',
        };
        const resolved = resolveClientIp(headers, '172.18.0.1');
        if (resolved) count++;
      }
      return count;
    },
  );

  // --- BENCHMARK 4 : Sécurité Path-Traversal sur fichiers statiques ---
  const mockDistDir = 'C:\\Users\\simon\\Documents\\REDVIEWproduction\\redview-app\\dist';
  suite.measureSync(
    {
      name: 'Vérification Anti Path-Traversal (10k requêtes URL)',
      category: 'server-security',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 20.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let safeCount = 0;
      const testPaths = [
        '/index.html',
        '/assets/main.js',
        '/../../etc/passwd',
        '/..%2f..%2fconfig.json',
        '/viewer.html',
        '/terrain-tiles/12/2124/1445.png',
      ];
      for (let i = 0; i < 10_000; i++) {
        const reqPath = testPaths[i % testPaths.length];
        // Fast-path de sécurité : vérification immédiate des séquences suspectes
        if (reqPath.includes('..') || reqPath.includes('%2')) {
          const fullPath = path.resolve(mockDistDir, '.' + reqPath);
          if (fullPath.startsWith(mockDistDir)) safeCount++;
        } else {
          safeCount++;
        }
      }
      return safeCount;
    },
  );

  // --- BENCHMARK 5 : Endpoint de Santé Uptime (/health) ---
  suite.measureSync(
    {
      name: 'Formatage JSON Health Endpoint (/health)',
      category: 'server-health',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 1.5,
      itemsProcessedPerOp: 1_000,
    },
    () => {
      let dummy = '';
      for (let i = 0; i < 1000; i++) {
        dummy = JSON.stringify({
          status: 'ok',
          uptime: Math.round(process.uptime()),
          timestamp: Date.now(),
        });
      }
      return dummy;
    },
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Fuite mémoire de rateLimitMap sous attaque DDoS avec des millions d’IPs distinctes : la boucle de purge à 5 min ne libère pas assez vite la mémoire.',
  );
  suite.addRegressionRisk(
    'Cache LRU en mémoire mono-instance : lors du scale horizontal Docker dans Coolify, les caches ne sont pas partagés entre conteneurs.',
  );
  suite.addRecommendation(
    'Déporter le rate-limiting et le cache de tuiles dans un cluster Redis partagé si le déploiement passe en multi-replicas Docker.',
  );
  suite.addRecommendation(
    'Ajouter une limite maximale de taille (ex: max 10 000 entrées) sur la table rateLimitMap pour borner la consommation mémoire à 5 Mo maximum.',
  );

  return suite;
}

function setLru<K, V>(cache: Map<K, V>, key: K, value: V, maxItems: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxItems) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
    else break;
  }
}

function resolveClientIp(headers: Record<string, string | undefined>, socketIp: string): string {
  const isPrivate = socketIp.startsWith('172.') || socketIp.startsWith('10.') || socketIp === '127.0.0.1';
  if (isPrivate) {
    const cf = headers['cf-connecting-ip'];
    if (cf) return cf.trim();
    const xff = headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return socketIp;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-server-api.ts')) {
  const quick = process.argv.includes('--quick');
  runServerApiBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
