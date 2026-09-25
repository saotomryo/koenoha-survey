// Documentation-only fixture: no .env, external AI or production storage access.
import { mkdir } from 'node:fs/promises';
import { createApp } from '../lib/app.js';
import { createWebServer } from '../server.js';
import { normalizeSurvey, newResponse } from '../lib/domain.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
process.env.ADMIN_PASSWORD = 'screenshot-demo-password';
process.env.SESSION_SECRET = 'screenshot-demo-secret-not-for-production';
process.env.STORAGE_DRIVER = 'local';
delete process.env.APP_ORIGIN;
delete process.env.VERCEL;
const survey = normalizeSurvey({
  id: 'workshop-demo', title: 'AI活用勉強会の振り返り',
  description: '本日はご参加ありがとうございました。次回の企画に向けて、感想をお聞かせください。',
  status: 'public', startsAt: '2026-01-01T00:00:00Z', endsAt: '2030-12-31T14:59:00Z', attributes: [],
  questions: [
    { id: 'rating', label: '今回の勉強会はいかがでしたか？', type: 'single', options: ['満足', 'やや満足', '普通', 'やや不満'], required: true, followUp: { required: false, maxTurns: 3 } },
    { id: 'topic', label: '次回取り上げてほしいテーマは？', type: 'multiple', options: ['業務の自動化', 'AIアプリ開発', 'データ分析'] },
    { id: 'comment', label: 'その他、ご意見・ご要望', type: 'longText' }
  ], interview: { enabled: false, provider: 'openai', maxTurns: 3 }
});
const opinions = ['実例が参考になりました。', '演習の時間を増やしてほしいです。', '初心者向けの説明が分かりやすかったです。', '仕事で使ってみたいと思いました。', '質問の時間があると嬉しいです。', '次回も参加したいです。'];
const responses = opinions.map((opinion, i) => ({
  ...newResponse(survey, { attributes: {}, answers: { rating: ['満足', '満足', 'やや満足', '満足', '普通', 'やや満足'][i], topic: i % 2 ? ['AIアプリ開発', 'データ分析'] : ['業務の自動化'], comment: opinion }, reasons: { rating: opinion } }, `demo-${i}`),
  createdAt: '2026-09-17T03:00:00Z'
}));
const tables = { surveys: [survey], responses };
const store = { records: async table => structuredClone(tables[table]), append: async (table, record) => tables[table].push(structuredClone(record)) };
const server = createWebServer(createApp({ store, ai: async () => '紹介された実例の中で、ご自身の仕事に取り入れてみたいものはありますか？' }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', deviceScaleFactor: 1 });
  await mkdir('docs/screenshots', { recursive: true });
  await page.goto(`${base}/survey/${survey.id}`);
  await page.getByRole('radio', { name: '満足', exact: true }).check();
  await page.screenshot({ path: 'docs/screenshots/survey.png' });
  await page.getByRole('button', { name: 'AIインタビューを利用してみる（任意）', exact: true }).click();
  await page.getByRole('textbox', { name: 'AIへの回答', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/interview.png' });
  const login = await page.request.post(`${base}/api/login`, { headers: { 'x-survey-request': '1' }, data: { password: process.env.ADMIN_PASSWORD } });
  if (!login.ok()) throw new Error('Fixture login failed');
  await page.goto(`${base}/admin`);
  await page.getByRole('heading', { name: 'アンケート管理', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/admin.png' });
  await page.goto(`${base}/admin/results/${survey.id}`);
  await page.getByRole('heading', { name: survey.title, exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/results.png' });
  console.log('Captured 4 screenshots with fictional data.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
