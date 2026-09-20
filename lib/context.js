import { check } from './domain.js';

export function normalizeContext(value) {
  if (value == null) return { text: '', files: [] };
  check(typeof value === 'object' && !Array.isArray(value), '補足情報の形式が不正です。');
  const bounded = (text, max) => {
    check(typeof text === 'string' && text.length <= max, `補足情報は${max}文字以内で入力してください。`);
    return text.trim();
  };
  const text = bounded(value.text ?? '', 12000);
  check(Array.isArray(value.files ?? []) && (value.files ?? []).length <= 3, '参考ファイルは設問ごとに3件までです。');
  const files = (value.files ?? []).map(file => {
    check(file && typeof file === 'object', '参考ファイルの形式が不正です。');
    const name = bounded(file.name, 200);
    check(/\.(txt|md|pdf)$/i.test(name), 'TXT・Markdown・PDFのみ利用できます。');
    const text = bounded(file.text, 12000);
    check(text, '参考ファイルのテキストが空です。');
    return { name, text };
  });
  check(text.length + files.reduce((n, file) => n + file.text.length, 0) <= 24000, '設問の補足情報は合計24000文字までです。');
  return { text, files };
}
