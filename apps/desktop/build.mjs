// Bundles the Electron main process (including the embedded hub) and preload into dist/.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: 'linked', logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' }),
]);
console.log('built dist/main.cjs, dist/preload.cjs');
