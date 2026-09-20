import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await copyFile('node_modules/lucide/dist/umd/lucide.js', 'public/vendor/lucide.js');
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) await copyFile(`node_modules/pdfjs-dist/build/${name}`, `public/vendor/${name}`);
for (const name of ['cmaps', 'standard_fonts']) await cp(`node_modules/pdfjs-dist/${name}`, `public/vendor/${name}`, { recursive: true });
