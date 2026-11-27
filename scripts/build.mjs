import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

for (const file of ['index.html', 'app.js', 'styles.css']) {
  await cp(file, `dist/${file}`);
}

const workerUrl = (process.env.WORKER_API_URL || '').replace(/\\/$/, '');
if (!workerUrl) {
  throw new Error('WORKER_API_URL must be supplied by the deployment workflow.');
}

await writeFile(
  'dist/config.js',
  `window.WORKER_API_URL = ${JSON.stringify(workerUrl)};\\n`,
  'utf8'
);

console.log(`Mini App built for API: ${workerUrl}`);
