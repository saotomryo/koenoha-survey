import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContextFile } from '../public/context-files.js';
test('context text extraction accepts UTF-8 and rejects oversized, empty, binary and unsupported files', async () => {
  assert.deepEqual(await extractContextFile(new File([' 日本語の資料 '], 'a.md')), { name: 'a.md', text: '日本語の資料' });
  for (const file of [new File([''], 'a.txt'), new File(['x'], 'a.docx'), new File(['x'.repeat(12001)], 'a.txt'), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'a.pdf'), new File([new Uint8Array([0xff])], 'a.txt'), new File(['a\0b'], 'a.txt')]) {
    await assert.rejects(extractContextFile(file));
  }
});
