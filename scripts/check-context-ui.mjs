// Runs against the in-memory fixture; never uses production storage or AI.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = spawn(process.execPath, ['test/ui-fixture.js'], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    fixture.stdout.once('data', resolve);
    fixture.once('error', reject);
    fixture.once('exit', code => reject(new Error(`Fixture exited: ${code}`)));
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const source = await browser.newPage();
  await source.setContent('<meta charset="utf-8"><p>Workshop reference: practical examples and discussion.</p><p>勉強会の参考資料</p>');
  const pdf = await source.pdf();
  await source.close();
  await page.goto('http://127.0.0.1:5178/admin');
  await page.getByLabel('パスワード', { exact: true }).fill('ui-fixture-password-only');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.getByRole('link', { name: '設問別AIインタビューの動作確認', exact: true }).click();
  const field = page.locator('.field-editor[data-group="questions"]').first();
  await field.locator('summary').click();
  await field.locator('[data-context="text"]').fill('勉強会の概要');
  await field.locator('input[data-context-file]').first().setInputFiles({ name: 'reference.pdf', mimeType: 'application/pdf', buffer: pdf });
  await field.locator('[data-context-document="0"]').waitFor();
  assert.match(await field.locator('[data-context-document="0"]').inputValue(), /Workshop reference/);
  assert.match(await field.locator('[data-context-document="0"]').inputValue(), /勉強会の参考資料/);
  await field.locator('[data-context-document="0"]').fill('編集した資料本文');
  await field.locator('input[data-context-file]').first().setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('補足Markdown') });
  await field.locator('[data-context-document="1"]').waitFor();
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await page.getByText('保存しました。', { exact: true }).waitFor();
  await page.reload();
  await field.locator('summary').click();
  assert.equal(await field.locator('[data-context-document="0"]').inputValue(), '編集した資料本文');
  await field.locator('input[data-replace="1"]').setInputFiles({ name: 'replace.txt', mimeType: 'text/plain', buffer: Buffer.from('差し替えた資料') });
  await field.getByText('replace.txt', { exact: true }).waitFor();
  await field.locator('[data-action="context-remove"][data-file="0"]').click();
  assert.equal(await field.locator('[data-context-document]').count(), 1);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await page.getByText('保存しました。', { exact: true }).waitFor();
  const publicData = await (await page.request.get('http://127.0.0.1:5178/api/surveys/question-interview-check')).text();
  assert.equal(publicData.includes('aiContext'), false);
  await field.locator('summary').click();
  await page.screenshot({ path: '/tmp/koenoha-context-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/koenoha-context-mobile.png', fullPage: true });
  console.log('PASS: PDF/Markdown extraction, edit, save/reload, replace/delete, public exclusion, mobile overflow');
} finally {
  await browser?.close();
  fixture.kill();
}
