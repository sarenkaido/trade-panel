import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

for (const file of ['index.html', 'app.js', 'styles.css']) {
  await cp(file, `dist/${file}`);
}

const configuredUrl = process.env.WORKER_API_URL || '';
const workerUrl = configuredUrl.endsWith('/')
  ? configuredUrl.slice(0, -1)
  : configuredUrl;

if (!workerUrl) {
  throw new Error('WORKER_API_URL must be supplied by the deployment workflow.');
}

const config = 'window.WORKER_API_URL = ' + JSON.stringify(workerUrl) + String.fromCharCode(10);
await writeFile('dist/config.js', config, 'utf8');

console.log('Mini App built for API: ' + workerUrl);
