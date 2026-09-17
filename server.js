import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import app from './api/index.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export function createWebServer(handler = app) {
return createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return handler(req, res);
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = ['/', '/admin'].includes(pathname) || pathname.startsWith('/admin/') || pathname.startsWith('/survey/') ? 'index.html' : decodeURIComponent(pathname).slice(1);
    const target = path.resolve(publicDir, file);
    if (!target.startsWith(publicDir) || !types[path.extname(target)]) { res.writeHead(404); return res.end('Not found'); }
    const content = await readFile(target);
    res.writeHead(200, { 'content-type': types[path.extname(target)], 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWebServer().listen(Number(process.env.PORT || 5177), '127.0.0.1', () => console.log(`Koenoha Survey: http://localhost:${process.env.PORT || 5177}`));
}
