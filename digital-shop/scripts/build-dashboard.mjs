import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';

const shop = new URL('../', import.meta.url);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp'
};
const publicDir = new URL('public/', shop);
const files = (await readdir(publicDir, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => entry.parentPath.slice(fileURLToPath(publicDir).length) + '/' + entry.name)
  .map(path => '/' + path.replace(/^\/+/, ''))
  .sort();

const assets = {};
for (const path of files) {
  const type = types[extname(path)];
  if (!type) throw new Error('Missing content type for ' + path);
  const file = await readFile(new URL('public' + path, shop));
  assets[path] = { type, chunks: file.toString('base64').match(/.{1,4096}/g) ?? [] };
}

const migrationsDir = new URL('migrations/', shop);
const migrations = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
const statements = [];
for (const name of migrations) {
  const sql = await readFile(new URL(name, migrationsDir), 'utf8');
  statements.push(...unstable_splitSqlQuery(sql));
}
const result = await build({
  absWorkingDir: fileURLToPath(shop),
  entryPoints: ['src/dashboard.mjs'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  banner: { js: '// RR Bot Academy dashboard build. Recreate with npm run build:dashboard.' },
  plugins: [{
    name: 'dashboard-resources',
    setup(plugin) {
      plugin.onResolve({ filter: /^rr-dashboard-resources$/ }, () => ({
        path: 'resources', namespace: 'rr-dashboard'
      }));
      plugin.onLoad({ filter: /^resources$/, namespace: 'rr-dashboard' }, () => ({
        contents: JSON.stringify({ assets, statements }),
        loader: 'json'
      }));
    }
  }]
});
const outputDir = new URL('dashboard/', shop);
await mkdir(outputDir, { recursive: true });
await writeFile(new URL('worker.mjs', outputDir), result.outputFiles[0].text);
