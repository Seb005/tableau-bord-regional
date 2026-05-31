// Seed des données nouvelles en exécutant chaque fonction Netlify localement
import 'dotenv/config';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const functionsDir = path.resolve('netlify/functions');
const files = readdirSync(functionsDir).filter(
  (f) => f.startsWith('nouvelles-') && f.endsWith('.js') && f !== 'nouvelles-proxy.js'
);

console.log(`\nExécution de ${files.length} fonctions...\n`);

for (const file of files) {
  const name = file.replace('.js', '');
  process.stdout.write(`${name}... `);
  try {
    const mod = await import(pathToFileURL(path.join(functionsDir, file)).href);
    const fn = mod.default;
    const result = await fn();
    const status = result?.status ?? 'no response';
    console.log(`✓ ${status}`);
  } catch (err) {
    console.log(`✗ ${err.message}`);
  }
}

console.log('\nDone.');
