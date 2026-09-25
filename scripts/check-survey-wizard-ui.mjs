// Uses an in-memory store and fake AI; never reads .env or calls a provider.
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.js';
import { createWebServer } from '../server.js';
import { normalizeSurvey } from '../lib/domain.js';
import { messagesFor } from '../lib/ai.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
process.env.SESSION_SECRET = 'wizard-ui-test-only-secret-32-characters';
process.env.ADMIN_PASSWORD = 'wizard-test-password-only';
delete process.env.APP_ORIGIN;
delete process.env.VERCEL;
const survey = normalizeSurvey({
  id: 'wizard-check', title: '勉強会の振り返り', status: 'public',
  description: 'ご意見・ご感想をお聞かせください。',
  startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(),
  attributes: [{ id: 'role', type: 'single', label: '参加区分', options: ['参加者', '運営'], required: true }],
  questions: [
    { id: 'rating', label: '全体的な満足度を教えてください。', type: 'slider', required: true, followUp: { maxTurns: 2 } },
    { id: 'topics', label: '興味のあるテーマ', type: 'multiple', options: ['開発', 'デザイン'], required: true },
    { id: 'comment', label: '印象に残ったこと', type: 'aiInterview', maxTurns: 2 },
    { id: 'next', label: '次回へのご希望', type: 'longText', required: true }
  ], interview: { enabled: true, maxTurns: 1 }
});
const tables = { surveys: [survey], responses: [] };
const calls = [];
const server = createWebServer(createApp({
  store: { records: async name => structuredClone(tables[name]), append: async (name, record) => tables[name].push(structuredClone(record)) },
  ai: async (s, r, summarize) => {
    const prompt = messagesFor(s, r, summarize)[0].content;
    calls.push({ summarize, prompt });
    return summarize ? '演習が役立ち、今後も実践の機会を希望している。' : prompt.includes('今回が最後の質問') ? '最後に、今後いちばん大切にしたいことは何ですか？' : '特に役立ったことを教えてください。';
  }
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/survey/${survey.id}`);
  const next = () => page.getByRole('button', { name: 'この回答で次へ進む', exact: true }).click();
  await next();
  await page.getByText('参加区分に回答してください。', { exact: true }).waitFor();
  await page.getByRole('radio', { name: '参加者', exact: true }).check();
  await next();
  await page.getByText('全体的な満足度を教えてください。に回答してください。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'AIインタビューを利用してみる（任意）', exact: true }).click();
  assert.equal(calls.length, 0);
  await page.getByRole('slider').fill('5');
  await page.getByRole('slider').dispatchEvent('input');
  await page.screenshot({ path: '/tmp/koenoha-wizard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'AIインタビューを利用してみる（任意）', exact: true }).click();
  await page.getByLabel('AIへの回答', { exact: true }).fill('演習が役立った');
  await page.getByRole('button', { name: '回答する', exact: true }).click();
  await page.getByText('最後に、今後いちばん大切にしたいことは何ですか？', { exact: true }).waitFor();
  assert.equal(calls[0].summarize, false);
  assert.doesNotMatch(calls[0].prompt, /今回が最後の質問/);
  assert.match(calls[1].prompt, /今回が最後の質問/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/koenoha-wizard-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel('AIへの回答', { exact: true }).fill('実践の機会');
  await page.getByRole('button', { name: '回答する', exact: true }).click();
  await page.getByRole('heading', { name: 'この設問の要約' }).waitFor();
  assert.equal(calls[2].summarize, true);
  await page.getByRole('button', { name: '次へ進む', exact: true }).click();
  await page.getByRole('button', { name: '次へ進む', exact: true }).click();
  await page.getByText('興味のあるテーマに回答してください。', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: '開発', exact: true }).check();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  assert.equal(await page.getByRole('slider').inputValue(), '5');
  assert.equal(await page.getByRole('radio', { name: '参加者', exact: true }).isChecked(), true);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'この設問の要約' }).count(), 1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await page.getByRole('slider').fill('4');
  await page.getByRole('slider').dispatchEvent('input');
  await next();
  assert.equal(await page.getByRole('checkbox', { name: '開発', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '次へ進む', exact: true }).click();
  await page.getByLabel('自由記述の回答', { exact: true }).fill('具体例がよかった');
  await next();
  await page.getByRole('button', { name: '回答を確認する', exact: true }).click();
  await page.getByText('次回へのご希望に回答してください。', { exact: true }).waitFor();
  await page.getByLabel('次回へのご希望').fill('実践の機会');
  await page.getByRole('button', { name: '回答を確認する', exact: true }).click();
  assert.equal(tables.responses.length, 0);
  await page.getByRole('heading', { name: '回答内容の確認', exact: true }).waitFor();
  await page.getByRole('button', { name: '修正する', exact: true }).nth(2).click();
  await page.getByRole('checkbox', { name: 'デザイン', exact: true }).check();
  await page.getByRole('button', { name: '次へ進む', exact: true }).click();
  assert.equal(await page.locator('textarea[name="answers:comment"]').inputValue(), '具体例がよかった');
  await next();
  assert.equal(await page.getByLabel('次回へのご希望').inputValue(), '実践の機会');
  await page.getByRole('button', { name: '回答を確認する', exact: true }).click();
  await page.getByRole('button', { name: 'AIともう少し振り返る', exact: true }).click();
  await page.getByLabel('あなたの回答', { exact: true }).fill('実践を増やしたい');
  await page.getByRole('button', { name: '回答する', exact: true }).click();
  await page.getByRole('button', { name: 'この内容で送信', exact: true }).click();
  await page.getByRole('heading', { name: 'ご回答ありがとうございました', exact: true }).waitFor();
  assert.equal(tables.responses.length, 1);
  assert.deepEqual(tables.responses[0].answers, { rating: 4, topics: ['開発', 'デザイン'], comment: '具体例がよかった', next: '実践の機会' });
  assert.deepEqual(tables.responses[0].attributes, { role: '参加者' });
  assert.deepEqual(tables.responses[0].questionInterviews, {});
  assert.deepEqual(errors, []);
  console.log('PASS: wizard validation, closing-to-summary, back/edit/reset, all input types retained, optional AI skipped, whole-survey AI, final-only save, mobile layout');
} catch (error) {
  console.error(await page?.locator('main').innerText());
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
