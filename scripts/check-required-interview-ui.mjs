// Isolated browser regression: no real credentials, provider or persisted data.
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.js';
import { createWebServer } from '../server.js';
import { normalizeSurvey } from '../lib/domain.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
process.env.ADMIN_PASSWORD = 'required-interview-fixture-only';
process.env.SESSION_SECRET = 'required-interview-fixture-secret-only';
delete process.env.APP_ORIGIN;
delete process.env.VERCEL;
const survey = normalizeSurvey({
  id: 'required-ai-check', title: 'AIインタビューの必須設定', status: 'public',
  startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(),
  questions: [
    { id: 'rating', label: '満足度', type: 'single', options: ['満足', '普通'], followUp: { required: true, maxTurns: 1 } },
    { id: 'comment', label: '感想', type: 'aiInterview', maxTurns: 1 },
    { id: 'optional', label: 'その他', type: 'aiInterview', maxTurns: 1 }
  ], interview: { enabled: false }
});
const tables = { surveys: [survey], responses: [] };
const store = { records: async table => structuredClone(tables[table]), append: async (table, data) => tables[table].push(structuredClone(data)) };
let aiCalls = 0;
const server = createWebServer(createApp({ store, ai: async (_s, _r, summary) => { aiCalls++; return summary ? '具体例が役立った。' : '具体的にはどんな点が役立ちましたか？'; } }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), timeout: 20000 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${base}/survey/${survey.id}`);
  assert.match(await page.locator('.ai-introduction').innerText(), /（利用は任意です）/);
  await page.goto(`${base}/admin/edit/${survey.id}`);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  const fields = page.locator('.field-editor[data-group="questions"]');
  await fields.first().waitFor();
  assert.equal(await page.getByText('理由の入力を必須にする', { exact: true }).count(), 0);
  for (const i of [0, 1]) await fields.nth(i).getByLabel('AIインタビューを必須にする', { exact: true }).check();
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await page.getByText('保存しました。', { exact: true }).waitFor();
  await page.reload();
  for (const i of [0, 1]) assert.equal(await fields.nth(i).getByLabel('AIインタビューを必須にする', { exact: true }).isChecked(), true);
  assert.equal(tables.surveys.at(-1).questions[0].followUp.required, true);
  await page.goto(`${base}/survey/${survey.id}`);
  await page.getByRole('radio', { name: '満足', exact: true }).check();
  assert.equal(await page.getByRole('button', { name: 'AIインタビューを利用してみる（必須）', exact: true }).count(), 2);
  assert.equal(await page.getByRole('button', { name: 'AIインタビューを利用してみる（任意）', exact: true }).count(), 1);
  assert.equal(await page.locator('.ai-introduction p').innerText(), 'AIとの対話を通じて回答の理由や背景の言語化をサポートする機能');
  await page.getByRole('button', { name: '回答を送信', exact: true }).click();
  await page.getByText('満足度のAIインタビューに回答して終了してください。', { exact: true }).waitFor();
  assert.equal(tables.responses.length, 0);
  for (const id of ['rating', 'comment']) {
    const section = page.locator(`#qi-${id}`);
    await section.getByRole('button', { name: 'AIインタビューを利用してみる（必須）', exact: true }).click();
    await section.getByLabel('AIへの回答', { exact: true }).waitFor();
    await section.getByRole('button', { name: '要約せず終了', exact: true }).click();
    await section.getByRole('status').getByText('この設問に少なくとも1回回答してください。', { exact: true }).waitFor();
    await section.getByLabel('AIへの回答', { exact: true }).fill('具体例が役立ちました');
    await section.getByRole('button', { name: '回答する', exact: true }).click();
    await section.getByRole('heading', { name: 'この設問の要約', exact: true }).waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/koenoha-required-interview-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '回答を送信', exact: true }).click();
  await page.getByRole('heading', { name: 'ご回答ありがとうございました', exact: true }).waitFor();
  assert.equal(tables.responses.length, 1);
  assert.equal(aiCalls, 4);
  assert.equal(tables.responses[0].questionInterviews.optional, undefined);
  console.log('PASS: settings save/reload, required/optional labels, missing dialogue blocked, completed reply saved, optional skipped, mobile overflow');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
