import { build } from 'esbuild';
import { copyFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  external: ['obsidian'],
  platform: 'browser',
  format: 'cjs',
  target: 'es2021',
  treeShaking: true,
  metafile: true,
  legalComments: 'eof',
});

const externalImports = Object.values(result.metafile.outputs)
  .flatMap(output => output.imports)
  .filter(entry => entry.external);
if (externalImports.some(entry => entry.path !== 'obsidian')) {
  throw new Error('Unexpected external runtime import');
}
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('styles.css', 'dist/styles.css');
await writeFile('dist/metafile.json', JSON.stringify(result.metafile));
