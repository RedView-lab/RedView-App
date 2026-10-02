/**
 * Bundle autonome du routing-quality bench, exécutable sur le VPS à côté de
 * BRouter (topologie de prod : proxy et BRouter sur le même hôte, latence sans
 * le tunnel SSH). Node ≥ 20, aucune dépendance à installer.
 *
 *   node script-test-bench/routing-quality/vps/build-vps.mjs
 *   scp -i ~/.ssh/oracle_brouter.key script-test-bench/routing-quality/vps/dist/run.mjs opc@141.145.220.99:/tmp/rq/
 *   ssh … 'cd /tmp/rq && BENCH_BROUTER_UPSTREAM=http://127.0.0.1:17777 node run.mjs --label after'
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

const redirect = {
  name: 'routing-quality-vps',
  setup(b) {
    b.onResolve({ filter: /audit[\\/]b-loader(\.ts)?$/ }, () => ({ path: path.join(here, 'b-loader-stub.ts') }));
    b.onResolve({ filter: /^\.\/app\.ts$/ }, (args) =>
      args.importer.endsWith(path.join('routing-quality', 'run.ts')) ? { path: path.join(here, 'app-static.ts') } : undefined,
    );
    b.onResolve({ filter: /^@\// }, async (args) => {
      const result = await b.resolve(`./${args.path.slice(2)}`, { resolveDir: path.join(root, 'src'), kind: args.kind });
      return result.errors.length ? undefined : { path: result.path };
    });
  },
};

await build({
  entryPoints: [path.join(root, 'script-test-bench', 'routing-quality', 'run.ts')],
  outfile: path.join(here, 'dist', 'run.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [redirect],
  define: {
    'import.meta.env': JSON.stringify({ MODE: 'production', DEV: false, PROD: true, SSR: true }),
  },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('→ script-test-bench/routing-quality/vps/dist/run.mjs');
