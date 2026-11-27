import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile('index.html', 'utf8');
const scripts = [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)]
  .filter(([, attrs]) => !/\\bsrc\\s*=/.test(attrs) && !/\\btype\\s*=\\s*["']application\\/json["']/.test(attrs));
if (!scripts.length) throw new Error('No inline application scripts found.');
for (let i = 0; i < scripts.length; i++) {
  new vm.Script(scripts[i][2], { filename: 'index.html:inline-script-' + (i + 1) });
}
if (!html.includes("Serverless.call('api'")) throw new Error('Telegram Serverless API bridge is missing.');
if (!html.includes("id=\"p-a\"") || !html.includes("id=\"p-w\"")) throw new Error('Expected panel sections are missing.');

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('index.html', 'dist/index.html');
console.log('Mini App build passed: inline JavaScript syntax and Telegram RPC bridge validated.');
