import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createApp } from '../lib/app.js';
import { normalizeSurvey, availability, buildResults, toCsv, responseTable } from '../lib/domain.js';
import { SheetsStore } from '../lib/storage.js';
import { messagesFor } from '../lib/ai.js';

process.env.ADMIN_PASSWORD = 'unit-test-password-only';
process.env.SESSION_SECRET = 'unit-test-secret-32-characters-only';
const now = Date.now();
const definition = overrides => normalizeSurvey({ id: 'event-test', title: '勉強会', status: 'public', startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 60000).toISOString(), attributes: [], questions: [
  { id: 'satisfaction', label: '満足度', type: 'slider', min: 1, max: 5, required: true },
  { id: 'comment', label: '感想', type: 'longText' }
], interview: { enabled: true, provider: 'openai', maxTurns: 1 }, ...overrides });
class MemoryStore {
  tables = { surveys: [definition()], responses: [] };
  async records(table) { return structuredClone(this.tables[table]); }
  async append(table, record) { this.tables[table].push(structuredClone(record)); }
  async initialize() {}
}
async function request(app, url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  req.url = url; req.method = method;
  req.headers = { host: 'localhost', 'content-type': 'application/json', 'x-survey-request': '1', ...(cookie ? { cookie } : {}), ...headers };
  let status, responseHeaders, raw;
  const res = { writeHead(code, h) { status = code; responseHeaders = h; }, end(text) { raw = text; } };
  await app(req, res);
  return { status, headers: responseHeaders, raw, data: responseHeaders?.['content-type']?.startsWith('application/json') ? JSON.parse(raw) : null };
}
async function login(app) { const r = await request(app, '/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } }); assert.equal(r.status, 200); return r.headers['set-cookie'].split(';')[0]; }
function answers() { return { responseId: randomUUID(), answers: { satisfaction: 4, comment: '実践例が役立ちました' }, attributes: {} }; }

test('AI background is admin-only, validated, scoped, preserved in backup and omitted from summaries', async () => {
  const context = { text: '管理者の背景情報', files: [{ name: 'slides.md', text: '資料本文' }] };
  const survey = definition({ questions: [
    { id: 'first', label: '感想', type: 'text', followUp: {}, aiContext: context },
    { id: 'second', label: 'その他', type: 'text', aiContext: { text: '別設問の資料' } }
  ] });
  const store = new MemoryStore(); store.tables.surveys = [survey];
  const app = createApp({ store });
  const publicResult = await request(app, '/api/surveys/event-test');
  assert.equal(publicResult.raw.includes('管理者の背景情報'), false);
  assert.equal(publicResult.raw.includes('slides.md'), false);
  assert.equal(publicResult.data.survey.questions[0].aiContext, undefined);
  const scoped = { ...survey, questions: [survey.questions[0]] };
  const response = { questionId: 'first', answers: { first: 'よかった' }, turns: [] };
  const prompt = JSON.parse(messagesFor(scoped, response)[1].content);
  assert.deepEqual(prompt.background[0].files, context.files);
  assert.equal(JSON.stringify(prompt).includes('別設問の資料'), false);
  assert.deepEqual(JSON.parse(messagesFor(scoped, response, true)[1].content).background, []);
  const cookie = await login(app);
  const backup = (await request(app, '/api/admin/backup', { cookie })).data;
  const target = new MemoryStore(); target.tables = { surveys: [], responses: [] };
  const targetApp = createApp({ store: target });
  assert.equal((await request(targetApp, '/api/admin/import', { method: 'POST', cookie: await login(targetApp), body: backup })).status, 200);
  assert.deepEqual(target.tables.surveys[0].questions[0].aiContext, context);
  for (const aiContext of [{ text: 'x'.repeat(12001) }, { files: [{ name: 'image.png', text: 'x' }] }, { files: [{ name: 'a.txt', text: '' }] }, { files: Array(4).fill({ name: 'a.txt', text: 'x' }) }]) {
    assert.throws(() => definition({ questions: [{ id: 'test', label: 'test', type: 'text', aiContext }] }));
  }
});

test('response capacity blocks new saves and AI, while allowing saved response retries', async () => {
  const store = new MemoryStore();
  store.tables.surveys = [definition({ expectedResponses: 1, responseLimitMultiplier: 1.2 })];
  let calls = 0;
  const app = createApp({ store, ai: async () => { calls++; return '質問'; } });
  const post = (action, body) => request(app, `/api/surveys/event-test/${action}`, { method: 'POST', body });
  const first = answers();
  assert.equal((await post('responses', first)).status, 200);
  assert.equal((await post('responses', answers())).status, 200);
  assert.equal((await post('responses', answers())).status, 403);
  assert.equal((await post('responses', first)).status, 200);
  assert.equal((await post('interview', { ...answers(), action: 'start' })).status, 403);
  assert.equal(calls, 0);
  assert.equal(store.tables.responses.length, 2);
  assert.throws(() => definition({ expectedResponses: -1 }));
  assert.throws(() => definition({ responseLimitMultiplier: 2.5 }));
});

test('concurrent interview requests for the same respondent do not call AI twice', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const app = createApp({ store: new MemoryStore(), ai: async () => { calls++; entered(); await waiting; return '質問'; } });
  const body = { ...answers(), action: 'start' };
  const post = () => request(app, '/api/surveys/event-test/interview', { method: 'POST', body });
  const first = post();
  await started;
  try { assert.equal((await post()).status, 429); }
  finally { release(); await first; }
  assert.equal(calls, 1);
});

test('attached interviews preserve choices, reasons, proofs, results and backup', async () => {
  const survey = definition({ questions: [{ id: 'choice', type: 'single', label: '満足度', options: ['満足', '不満'], required: true, followUp: { required: true, maxTurns: 1 } }] });
  const store = new MemoryStore(); store.tables.surveys = [survey]; let calls = 0;
  const app = createApp({ store, ai: async (context, response) => {
    calls++;
    assert.equal(context.questions.length, 1);
    const prompt = messagesFor(context, response)[1].content;
    assert.match(prompt, /不満/); assert.match(prompt, /時間が短い/);
    return '具体的には？';
  } });
  const body = { responseId: randomUUID(), answers: { choice: '不満' }, reasons: { choice: '時間が短い' } };
  const post = (action, value) => request(app, `/api/surveys/event-test/${action}`, { method: 'POST', body: value });
  assert.equal((await post('responses', { ...body, answers: {} })).status, 400);
  assert.equal((await post('responses', body)).status, 200); assert.equal(calls, 0);
  const next = { ...body, responseId: randomUUID() };
  assert.equal((await post('interview', { ...next, action: 'start', questionId: 'choice', answers: {} })).status, 400);
  const start = await post('interview', { ...next, action: 'start', questionId: 'choice' }); assert.equal(start.status, 200);
  const done = await post('interview', { token: start.data.token, questionId: 'choice', action: 'finishWithoutSummary' }); assert.equal(done.status, 200);
  const final = { ...next, questionTokens: { choice: done.data.token } };
  assert.equal((await post('responses', { ...final, answers: { choice: '満足' } })).status, 400);
  assert.equal((await post('responses', { ...final, reasons: { choice: '変更' } })).status, 400);
  assert.equal((await post('responses', final)).status, 200);
  const result = buildResults(survey, store.tables.responses);
  assert.equal(result.fields[0].rows.find(r => r.label === '不満').count, 2);
  assert.equal(result.fields[0].reasons.length, 2);
  assert.match(toCsv(survey, store.tables.responses), /満足度：理由/);
  const cookie = await login(app); const backup = (await request(app, '/api/admin/backup', { cookie })).data;
  const restored = new MemoryStore(); restored.tables = { surveys: [], responses: [] };
  const restoreApp = createApp({ store: restored });
  assert.equal((await request(restoreApp, '/api/admin/import', { method: 'POST', cookie: await login(restoreApp), body: backup })).status, 200);
  assert.deepEqual(restored.tables.responses[1].reasons, body.reasons);
});
test('per-survey backup excludes other surveys and changing populated destination is blocked', async () => {
  const store = new MemoryStore(); const app = createApp({ store });
  store.tables.surveys.push(definition({ id: 'other-event' }));
  await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: answers() });
  assert.equal((await request(app, '/api/admin/surveys/event-test/backup')).status, 401);
  const cookie = await login(app);
  const backup = await request(app, '/api/admin/surveys/event-test/backup', { cookie });
  assert.equal(backup.status, 200); assert.equal(backup.data.surveys.length, 1);
  assert.equal(backup.data.responses.length, 1);
  assert.equal(backup.data.surveys[0].id, 'event-test');
  assert.equal((await request(app, '/api/admin/surveys/event-test', { cookie, method: 'PUT', body: { ...store.tables.surveys[0], spreadsheetId: 'another-sheet-id' } })).status, 409);
  const target = new MemoryStore(); target.tables = { surveys: [], responses: [] };
  const targetApp = createApp({ store: target });
  assert.equal((await request(targetApp, '/api/admin/import', { cookie: await login(targetApp), method: 'POST', body: backup.data })).status, 200);
  assert.equal(target.tables.responses.length, 1);
});
test('Sheets routes response tabs per survey, merges legacy data and uses shared credentials', async () => {
  const a = definition(), b = definition({ id: 'other-event', spreadsheetId: 'separate-sheet' });
  const row = r => [r.id, r.surveyId || '', '', '', '', JSON.stringify(r)];
  const books = { common: { surveys: { rows: [row(a), row(b)] }, responses: { rows: [row({ id: 'legacy', surveyId: a.id })] } }, 'separate-sheet': {} };
  let headers; const calls = [];
  const client = { request: async input => {
    calls.push(input);
    const url = new URL(input.url); const path = decodeURIComponent(url.pathname);
    const id = path.split('/')[3].replace(':batchUpdate', ''); const book = books[id]; assert.ok(book);
    if (url.searchParams.has('fields')) return { data: { sheets: Object.keys(book).map(title => ({ properties: { title } })) } };
    if (path.endsWith(':batchUpdate')) {
      for (const r of input.data.requests) book[r.addSheet.properties.title] = { rows: [] };
      return { data: {} };
    }
    const match = path.match(/\/values\/'([^']+)'!(.+)$/); assert.ok(match);
    const table = book[match[1]]; assert.ok(table);
    if (match[2].startsWith('A1:')) {
      if (input.method === 'PUT') { table.headers = input.data.values[0]; headers = table.headers; }
      return { data: { values: table.headers ? [table.headers] : match[1] === 'responses' && headers ? [headers] : [] } };
    }
    if (match[2].includes(':append')) { table.rows.push(...input.data.values); return { data: {} }; }
    return { data: { values: table.rows } };
  } };
  const store = new SheetsStore({ client, spreadsheetId: 'common' });
  let synced = 0; store.syncTabular = async () => { synced++; };
  await store.append('responses', { id: 'new-a', surveyId: a.id });
  await store.append('responses', { id: 'new-b', surveyId: b.id });
  assert.ok(books.common['responses_event-test']); assert.ok(books['separate-sheet']['responses_other-event']);
  assert.equal(books.common.responses.rows.length, 1);
  assert.deepEqual((await store.records('responses', a.id)).map(r => r.id), ['legacy', 'new-a']);
  assert.equal((await store.records('responses')).length, 3);
  assert.ok(calls.every(c => c.retry === false));
  assert.equal(synced, 2);
});
test('tabular Sheets export uses CSV columns, RAW cells and refuses foreign headers', async () => {
  const calls = []; let foreign = false;
  const store = new SheetsStore({ spreadsheetId: 'common', client: { request: async input => {
    calls.push(input);
    if (input.url.includes('?fields=')) return { data: { sheets: [{ properties: { title: 'answers_event-test', sheetId: 10, gridProperties: { rowCount: 100, columnCount: 26 } } }] } };
    if (decodeURIComponent(input.url).includes('A1:B1')) return { data: { values: [foreign ? ['別のデータ'] : ['回答ID', '回答日時']] } };
    return { data: {} };
  } } });
  const response = { id: 'one', surveyId: 'event-test', answers: { satisfaction: 4, comment: '=danger()' }, summary: '', turns: [] };
  store.records = async () => [response];
  assert.equal((await store.syncTabular(definition())).count, 1);
  const write = calls.find(c => c.method === 'PUT');
  assert.match(write.url, /valueInputOption=RAW/);
  assert.deepEqual(write.data.values[0].slice(0, 4), ['回答ID', '回答日時', '満足度', '感想']);
  assert.equal(write.data.values[1][2], 4); assert.equal(write.data.values[1][3], '=danger()');
  assert.ok(calls.some(c => c.data?.requests?.[0]?.updateSheetProperties?.properties.gridProperties.frozenRowCount === 1));
  foreign = true; calls.length = 0;
  await assert.rejects(() => store.syncTabular(definition()), e => e.status === 409);
  assert.ok(!calls.some(c => c.method === 'PUT'));
});
test('duplicate copies only definition into a new draft with no dates or responses', async () => {
  const store = new MemoryStore(); const app = createApp({ store });
  const original = structuredClone(store.tables.surveys[0]);
  await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: answers() });
  const url = '/api/admin/surveys/event-test/duplicate';
  assert.equal((await request(app, url, { method: 'POST', body: {} })).status, 401);
  const cookie = await login(app);
  const result = await request(app, url, { cookie, method: 'POST', body: {} });
  assert.equal(result.status, 201);
  const copy = result.data.survey;
  assert.notEqual(copy.id, original.id); assert.equal(copy.status, 'draft');
  assert.equal(copy.startsAt, ''); assert.equal(copy.endsAt, '');
  assert.deepEqual(copy.questions, original.questions); assert.deepEqual(copy.interview, original.interview);
  assert.equal(copy.spreadsheetId, original.spreadsheetId);
  assert.deepEqual(store.tables.surveys[0], original);
  assert.equal(store.tables.responses.filter(r => r.surveyId === copy.id).length, 0);
  assert.equal((await request(app, `/api/surveys/${copy.id}`)).status, 404);
});
test('export groups each question answer, reason, summary and transcript in display order', () => {
  const survey = definition({ questions: [
    { id: 'first', label: '最初', type: 'single', options: ['はい'], followUp: { maxTurns: 1 } },
    { id: 'second', label: '次', type: 'aiInterview' },
    { id: 'last', label: '最後', type: 'text' }
  ] });
  const [headers, row] = responseTable(survey, [{ id: 'id', createdAt: 'date', answers: { first: 'はい', second: '感想', last: '末尾' }, reasons: { first: '理由' }, questionInterviews: { first: { summary: '要約1', turns: [{ role: 'user', content: '発言1' }] }, second: { summary: '要約2', turns: [] } } }]);
  assert.deepEqual(headers, ['回答ID', '回答日時', '最初', '最初：理由', '最初：AI要約', '最初：会話履歴', '次', '次：AI要約', '次：会話履歴', '最後', 'AI要約', 'AI会話履歴']);
  assert.deepEqual(row, ['id', 'date', 'はい', '理由', '要約1', '回答者: 発言1', '感想', '要約2', '', '末尾', '', '']);
});
test('attached interview starts without a reason but requires the original answer and actual dialogue', async () => {
  const store = new MemoryStore();
  store.tables.surveys = [definition({ questions: [{ id: 'rating', type: 'single', label: '満足度', options: ['満足', '不満'], followUp: { required: true, maxTurns: 2 } }] })];
  let calls = 0;
  const app = createApp({ store, ai: async (survey, response) => {
    calls++;
    assert.match(messagesFor(survey, response)[0].content, /理由はまだ記入されていません/);
    assert.match(messagesFor(survey, response)[1].content, /不満/);
    return 'どんな場面でそう感じましたか？';
  } });
  const base = { responseId: randomUUID(), answers: { rating: '不満' }, reasons: {} };
  const post = (path, body) => request(app, `/api/surveys/event-test/${path}`, { method: 'POST', body });
  assert.equal((await post('interview', { ...base, answers: {}, questionId: 'rating', action: 'start' })).status, 400);
  assert.equal(calls, 0);
  const start = await post('interview', { ...base, questionId: 'rating', action: 'start' });
  assert.equal(start.status, 200); assert.equal(calls, 1);
  assert.equal((await post('interview', { token: start.data.token, questionId: 'rating', action: 'finishWithoutSummary' })).status, 400);
  const finish = await post('interview', { token: start.data.token, questionId: 'rating', action: 'finishWithoutSummary', reply: '演習の時間が短かったです' });
  assert.equal(finish.status, 200);
  assert.equal((await post('responses', { ...base, questionTokens: { rating: finish.data.token } })).status, 200);
  assert.equal(store.tables.responses[0].reasons.rating, '');
  assert.equal(store.tables.responses[0].questionInterviews.rating.turns[1].content, '演習の時間が短かったです');
  assert.equal((await post('responses', { ...base, responseId: randomUUID() })).status, 200);
});
test('period includes start, excludes end, requires finite public schedule', () => {
  const survey = definition();
  assert.equal(availability(survey, Date.parse(survey.startsAt)), 'open');
  assert.equal(availability(survey, Date.parse(survey.endsAt)), 'closed');
  assert.equal(availability(survey, Date.parse(survey.startsAt) - 1), 'scheduled');
  assert.throws(() => definition({ endsAt: '' }));
  assert.throws(() => definition({ startsAt: 'invalid' }));
});
test('all admin operations require authentication; public responses omit provider', async () => {
  const app = createApp({ store: new MemoryStore() });
  for (const path of ['/api/admin/surveys', '/api/admin/backup', '/api/admin/settings', '/api/admin/surveys/event-test/results', '/api/admin/surveys/event-test/export']) assert.equal((await request(app, path)).status, 401);
  assert.equal((await request(app, '/api/admin/storage/initialize', { method: 'POST', body: {} })).status, 401);
  const response = await request(app, '/api/surveys/event-test');
  assert.equal(response.data.survey.interview.provider, undefined);
  const cookie = await login(app);
  assert.match(cookie, /^survey_admin=/);
  assert.equal((await request(app, '/api/admin/surveys', { cookie })).status, 200);
});
test('invalid password, cross-origin POST and forged cookies are rejected', async () => {
  const app = createApp({ store: new MemoryStore() });
  assert.equal((await request(app, '/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal((await request(app, '/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD }, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request(app, '/api/admin/backup', { cookie: 'survey_admin=forged' })).status, 401);
});
test('draft, future, expired and manually closed surveys block AI and saves', async () => {
  for (const overrides of [{ status: 'draft' }, { startsAt: new Date(now + 20000).toISOString() }, { endsAt: new Date(now - 1).toISOString() }, { status: 'closed' }]) {
    const store = new MemoryStore(); store.tables.surveys = [definition(overrides)];
    let calls = 0;
    const app = createApp({ store, ai: async () => { calls++; return 'question'; }, clock: () => now });
    for (const action of ['responses', 'interview']) {
      const result = await request(app, `/api/surveys/event-test/${action}`, { method: 'POST', body: { ...answers(), action: 'start' } });
      assert.ok([403, 404].includes(result.status));
    }
    assert.equal(calls, 0); assert.equal(store.tables.responses.length, 0);
  }
});
test('AI signed conversation enforces one question, summarizes, saves and deduplicates retries', async () => {
  const store = new MemoryStore(); let calls = 0;
  const app = createApp({ store, ai: async (s, r, summary) => { calls++; return summary ? '実践例が役に立った。' : 'どの実践例が役立ちましたか？'; } });
  const start = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...answers(), action: 'start' } });
  assert.equal(start.status, 200); assert.equal(start.data.ready, false);
  const forged = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: start.data.token + 'x', action: 'reply', reply: '事例です' } });
  assert.equal(forged.status, 401); assert.equal(calls, 1);
  const finish = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: start.data.token, action: 'reply', reply: 'CSVの集計です' } });
  assert.equal(finish.data.ready, true); assert.equal(calls, 2);
  assert.equal((await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: finish.data.token, action: 'reply', reply: '続き' } })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: { token: finish.data.token } })).status, 200);
  assert.equal(store.tables.responses.length, 1);
  assert.equal(store.tables.responses[0].turns[1].content, 'CSVの集計です');
});
test('end of period during an AI request rejects the completion', async () => {
  const store = new MemoryStore(); let clock = now;
  const app = createApp({ store, clock: () => clock, ai: async () => { clock = now + 60000; return '質問'; } });
  const r = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...answers(), action: 'start' } });
  assert.equal(r.status, 403);
});
test('AI disabled and survey revisions block direct calls', async () => {
  const store = new MemoryStore(); let calls = 0;
  const app = createApp({ store, ai: async () => { calls++; return '質問'; } });
  const r = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...answers(), action: 'start' } });
  store.tables.surveys[0].updatedAt = 'changed';
  assert.equal((await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: r.data.token, action: 'finish' } })).status, 409);
  store.tables.surveys[0].interview.enabled = false;
  assert.equal((await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...answers(), action: 'start' } })).status, 403);
  assert.equal(calls, 1);
});
test('required input validation and storage failure never return a saved response', async () => {
  const store = new MemoryStore(); const app = createApp({ store });
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: { responseId: randomUUID(), answers: {} } })).status, 400);
  store.append = async () => { throw new Error('secret internal detail'); };
  const failed = await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: answers() });
  assert.equal(failed.status, 500); assert.doesNotMatch(failed.raw, /secret internal detail/);
});
test('unfinished reply is retained when saving without AI summary', async () => {
  const store = new MemoryStore(); const app = createApp({ store, ai: async () => '質問' });
  const r = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...answers(), action: 'start' } });
  const saved = await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: { token: r.data.token, withoutSummary: true, reply: '最後の回答' } });
  assert.equal(saved.status, 200); assert.equal(store.tables.responses[0].turns.at(-1).content, '最後の回答');
});
test('Sheets appends RAW, splits long data, disables retries and maps quota error', async () => {
  const calls = [];
  const store = new SheetsStore({ spreadsheetId: 'test-sheet', client: { request: async input => { calls.push(input); return { data: {} }; } } });
  const record = { id: randomUUID(), surveyId: 'event-test', createdAt: new Date().toISOString(), summary: '=TEST()', turns: [{ role: 'user', content: 'あ'.repeat(35000) }] };
  await store.appendRow('responses_event-test', record);
  assert.match(calls[0].url, /valueInputOption=RAW/); assert.equal(calls[0].retry, false);
  assert.equal(JSON.parse(calls[0].data.values[0].slice(5).join('')).turns[0].content.length, 35000);
  store.client.request = async () => { throw { response: { status: 429 } }; };
  await assert.rejects(() => store.records('responses'), error => error.status === 429);
});
test('results and CSV preserve original answers without domain-specific weighting', () => {
  const survey = definition();
  const responses = [{ id: '1', answers: { satisfaction: 4, comment: '=danger()' }, attributes: {}, turns: [], summary: '' }];
  const result = buildResults(survey, responses);
  assert.equal(result.fields[0].average, 4);
  assert.equal(result.fields[0].rows.find(r => r.label === 4).count, 1);
  assert.match(toCsv(survey, responses), /'=danger/);
  assert.doesNotMatch(JSON.stringify(messagesFor(survey, responses[0])), /制服|kouchou|広聴/);
});
test('Sheets initialization recovers empty tabs without replacing incompatible headers', async () => {
  const calls = [];
  const store = new SheetsStore({ spreadsheetId: 'test-sheet', client: { request: async input => {
    calls.push(input);
    return { data: input.url.includes('?fields=') ? { sheets: [{ properties: { title: 'surveys' } }, { properties: { title: 'responses' } }] } : {} };
  } } });
  await store.initialize();
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  store.client.request = async input => ({ data: input.url.includes('?fields=') ? { sheets: [{ properties: { title: 'surveys' } }, { properties: { title: 'responses' } }] } : { values: [['foreign-data']] } });
  await assert.rejects(() => store.initialize(), error => error.status === 409);
});
test('backup import is merge-only, drafts imported surveys and is retry-safe', async () => {
  const source = new MemoryStore(); const sourceApp = createApp({ store: source }); const sourceCookie = await login(sourceApp);
  await request(sourceApp, '/api/surveys/event-test/responses', { method: 'POST', body: answers() });
  const backup = (await request(sourceApp, '/api/admin/backup', { cookie: sourceCookie })).data;
  const target = new MemoryStore(); target.tables = { surveys: [], responses: [] };
  const app = createApp({ store: target }); const cookie = await login(app);
  assert.equal((await request(app, '/api/admin/import', { method: 'POST', cookie, body: backup })).status, 200);
  assert.equal(target.tables.surveys[0].status, 'draft');
  const retry = await request(app, '/api/admin/import', { method: 'POST', cookie, body: backup });
  assert.equal(retry.data.responseCount, 0); assert.equal(target.tables.responses.length, 1);
});

function questionSurvey() {
  return definition({ interview: { enabled: false, provider: 'openai', maxTurns: 5 }, questions: [
    { id: 'learning', label: '学びを深掘りしてください', type: 'aiInterview', required: true, maxTurns: 1 },
    { id: 'improvement', label: '改善案を聞かせてください', type: 'aiInterview', required: false, maxTurns: 2 },
    { id: 'rating', label: '最後の評価', type: 'single', options: ['よい', '普通'], required: true }
  ] });
}
test('multiple question interviews are independently scoped and do not require later answers', async () => {
  const store = new MemoryStore(); store.tables.surveys = [questionSurvey()]; const calls = [];
  const app = createApp({ store, ai: async (s, r, summary) => { calls.push({ s, r: structuredClone(r), summary }); return summary ? '設問の要約' : '具体例を教えてください'; } });
  const id = randomUUID();
  const start = async questionId => request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { action: 'start', questionId, responseId: id, answers: { [questionId]: '最初の回答' } } });
  const first = await start('learning'); const second = await start('improvement');
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(calls[0].s.questions[0].id, 'learning'); assert.equal(calls[0].s.interview.maxTurns, 1);
  assert.equal(calls[1].s.questions[0].id, 'improvement'); assert.equal(calls[1].s.interview.maxTurns, 2);
  assert.equal(calls[0].r.turns[0].content, '最初の回答');
  const finish = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: first.data.token, questionId: 'learning', action: 'reply', reply: '深掘り回答' } });
  assert.equal(finish.data.ready, true);
  const payload = { responseId: id, answers: { learning: '最初の回答', rating: 'よい' }, questionTokens: { learning: finish.data.token } };
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: payload })).status, 200);
  assert.equal(store.tables.responses[0].questionInterviews.learning.summary, '設問の要約');
  assert.equal(store.tables.responses[0].questionInterviews.learning.turns.length, 3);
  assert.equal(store.tables.responses[0].questionInterviews.improvement, undefined);
  const result = buildResults(store.tables.surveys[0], store.tables.responses);
  assert.equal(result.interviewCount, 1); assert.equal(result.fields[0].texts[0], '設問の要約');
  assert.match(toCsv(store.tables.surveys[0], store.tables.responses), /学びを深掘りしてください：AI要約/);
  const cookie = await login(app);
  const backup = (await request(app, '/api/admin/backup', { cookie })).data;
  const restored = new MemoryStore(); restored.tables = { surveys: [], responses: [] };
  const restoreApp = createApp({ store: restored }); const restoreCookie = await login(restoreApp);
  assert.equal((await request(restoreApp, '/api/admin/import', { cookie: restoreCookie, method: 'POST', body: backup })).status, 200);
  assert.deepEqual(restored.tables.responses[0].questionInterviews, store.tables.responses[0].questionInterviews);
});
test('required interview and per-question proofs reject missing, unfinished, swapped or foreign sessions', async () => {
  const store = new MemoryStore(); store.tables.surveys = [questionSurvey()];
  const app = createApp({ store, ai: async () => '質問' }); const id = randomUUID();
  const base = { responseId: id, answers: { learning: '', rating: 'よい' } };
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: base })).status, 400);
  const started = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...base, action: 'start', questionId: 'learning' } });
  assert.equal(started.status, 200);
  assert.equal((await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: started.data.token, questionId: 'improvement', action: 'finish' } })).status, 400);
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: { ...base, questionTokens: { learning: started.data.token } } })).status, 400);
  const finished = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { token: started.data.token, questionId: 'learning', action: 'finishWithoutSummary', reply: '回答を残します' } });
  assert.equal(finished.status, 200); assert.equal(finished.data.ready, true);
  for (const body of [
    { ...base, responseId: randomUUID(), questionTokens: { learning: finished.data.token } },
    { ...base, questionTokens: { improvement: finished.data.token } },
    { token: finished.data.token }
  ]) assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body })).status, 400);
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: { ...base, questionTokens: { learning: finished.data.token } } })).status, 200);
});
test('required AI question accepts plain text without calling AI and survives backup', async () => {
  const store = new MemoryStore(); store.tables.surveys = [questionSurvey()];
  let calls = 0;
  const app = createApp({ store, ai: async () => { calls++; return '質問'; } });
  const body = { responseId: randomUUID(), answers: { learning: '実例が参考になりました', rating: 'よい' } };
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body })).status, 200);
  assert.equal(calls, 0);
  assert.equal(store.tables.responses[0].answers.learning, body.answers.learning);
  assert.deepEqual(store.tables.responses[0].questionInterviews, {});
  const cookie = await login(app);
  const backup = (await request(app, '/api/admin/backup', { cookie })).data;
  const restored = new MemoryStore(); restored.tables = { surveys: [], responses: [] };
  const restoreApp = createApp({ store: restored });
  const restoreCookie = await login(restoreApp);
  assert.equal((await request(restoreApp, '/api/admin/import', { cookie: restoreCookie, method: 'POST', body: backup })).status, 200);
  assert.equal(restored.tables.responses[0].answers.learning, body.answers.learning);
  assert.equal((await request(app, '/api/surveys/event-test/responses', { method: 'POST', body: { ...body, responseId: randomUUID(), answers: { ...body.answers, learning: '   ' } } })).status, 400);
});
test('question interviews require respondent speech and still respect closure', async () => {
  const store = new MemoryStore(); store.tables.surveys = [questionSurvey()]; let calls = 0;
  const app = createApp({ store, ai: async () => { calls++; return '質問'; } });
  const started = await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { responseId: randomUUID(), questionId: 'learning', action: 'start', answers: {} } });
  assert.equal(started.status, 200);
  const params = { token: started.data.token, questionId: 'learning', action: 'finish' };
  assert.equal((await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: params })).status, 400);
  assert.equal(calls, 1);
  store.tables.surveys[0].status = 'closed';
  assert.equal((await request(app, '/api/surveys/event-test/interview', { method: 'POST', body: { ...params, reply: '回答' } })).status, 403);
  assert.equal(calls, 1);
});
