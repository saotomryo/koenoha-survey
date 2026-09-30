import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.js';
import { createWebServer } from '../server.js';
import { LocalStore, getSurvey, getResponses } from '../lib/storage.js';
import { normalizeSurvey } from '../lib/domain.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
process.env.ADMIN_PASSWORD = 'reset-ui-test-only';
process.env.SESSION_SECRET = 'reset-ui-test-only-secret-32-characters';
delete process.env.APP_ORIGIN;
delete process.env.VERCEL;
const dir = await mkdtemp(path.join(tmpdir(), 'koenoha-reset-ui-'));
const store = new LocalStore(dir);
const survey = normalizeSurvey({ id: 'reset-ui', title: '試用アンケート', status: 'draft', questions: [{ id: 'comment', label: '感想', type: 'text' }] });
await store.append('surveys', survey);
await store.append('responses', { id: 'test', surveyId: survey.id, createdAt: new Date().toISOString(), answers: { comment: '試用回答' }, attributes: {}, turns: [], summary: '' });
const server = createWebServer(createApp({ store }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/admin`);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  try { await page.getByRole('heading', { name: 'アンケート管理', exact: true }).waitFor({ timeout: 5000 }); }
  catch (error) { console.log(await page.locator('body').innerText()); throw error; }
  await page.goto(`${base}/admin/results/${survey.id}`);
  const reset = page.getByRole('button', { name: '全回答を削除して下書きに戻す', exact: true });
  await reset.waitFor();
  await page.screenshot({ path: '/tmp/koenoha-response-reset.png', fullPage: true });
  page.once('dialog', dialog => dialog.dismiss());
  await reset.click();
  assert.equal((await getResponses(store, survey.id)).length, 1);
  page.once('dialog', dialog => dialog.accept());
  await reset.click();
  await page.waitForURL(`**/admin/edit/${survey.id}`);
  assert.equal((await getResponses(store, survey.id)).length, 0);
  assert.equal((await getSurvey(store, survey.id)).status, 'draft');
  assert.deepEqual(errors, []);
  console.log('PASS: cancel preserves data; confirmed reset deletes answers and opens editor at same ID.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
