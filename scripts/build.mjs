import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css']) {
  await cp(file, `dist/${file}`);
}
const workerUrl = process.env.WORKER_API_URL || '';\nawait (await import('node:fs/promises')).writeFile('dist/config.js', `window.WORKER_API_URL = ${JSON.stringify(workerUrl)};\\n`);\nconsole.log('Mini App built into dist/');
