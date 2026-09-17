import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await copyFile('node_modules/lucide/dist/umd/lucide.js', 'public/vendor/lucide.js');
