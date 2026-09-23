import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, check, normalizeSurvey, availability, publicSurvey, requireOpen, validId, validateAnswers, validateQuestionInterviews, newResponse, buildResults, toCsv, responseLimit, isInterviewRequired, hasInterviewReply } from './domain.js';
import { passwordMatches, signToken, verifyToken, isAdmin, adminCookie, requireSameOrigin } from './security.js';
import { createStore, getSurveys, getSurvey, getResponses, countResponses } from './storage.js';
import { generate } from './ai.js';

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
async function bodyOf(req) {
  check((req.headers['content-type'] || '').startsWith('application/json'), 'JSON形式で送信してください。', 415);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    check(Buffer.byteLength(raw) <= 2_000_000, '送信データが大きすぎます。', 413);
  }
  try { return JSON.parse(raw); } catch { throw new AppError(400, 'JSONの形式が不正です。'); }
}
function responseId(id) {
  check(typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id), '回答IDが不正です。');
  return id;
}
function ticket(response, survey, ready = false) {
  return signToken({ response, revision: survey.updatedAt, ready }, 'interview');
}
function readTicket(body, survey) {
  const data = verifyToken(body.token, 'interview');
  check(data.response.surveyId === survey.id && data.revision === survey.updatedAt, 'アンケートの設定が変更されました。回答画面を開き直してください。', 409);
  return data;
}
function attachQuestionInterviews(survey, response, tokens = {}) {
  check(tokens && typeof tokens === 'object' && !Array.isArray(tokens), '会話の署名が不正です。');
  const interviews = {};
  for (const [questionId, token] of Object.entries(tokens)) {
    check(survey.questions.some(q => q.id === questionId && (q.type === 'aiInterview' || q.followUp)), '不明な設問です。');
    const data = readTicket({ token }, survey);
    check(data.ready && data.response.questionId === questionId && data.response.id === response.id, '設問のAIインタビューを完了してください。');
    check(JSON.stringify(data.response.answers[questionId] ?? '') === JSON.stringify(response.answers[questionId] ?? '') && (data.response.reasons?.[questionId] || '') === (response.reasons?.[questionId] || ''), '最初の回答や理由が変更されています。設問のAIインタビューをやり直してください。');
    interviews[questionId] = { summary: data.response.summary, turns: data.response.turns };
  }
  response.questionInterviews = validateQuestionInterviews(survey, interviews, response.answers, response.reasons);
}
export function createApp({ store: injectedStore, ai = generate, clock = Date.now } = {}) {
  // Instance-local guard; Sheets does not provide cross-instance transactions.
  const inFlight = new Set();
  return async function app(req, res) {
    let lock;
    const acquire = key => {
      check(!inFlight.has(key), '処理中です。しばらく待ってから再度お試しください。', 429);
      inFlight.add(key); lock = key;
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.replace(/\/$/, '');
      const method = req.method;
      check(['GET', 'POST', 'PUT'].includes(method), '許可されていない操作です。', 405);
      if (method !== 'GET') requireSameOrigin(req);
      if (route === '/api/session' && method === 'GET') return json(res, 200, { authenticated: isAdmin(req) });
      if (route === '/api/login' && method === 'POST') {
        const body = await bodyOf(req);
        if (!passwordMatches(body.password)) { await delay(400); throw new AppError(401, 'パスワードが違います。'); }
        return json(res, 200, { ok: true }, { 'set-cookie': adminCookie(signToken({ admin: true }, 'admin')) });
      }
      if (route === '/api/logout' && method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': adminCookie('', true) });
      const admin = route.startsWith('/api/admin/');
      if (admin) check(isAdmin(req), '管理者ログインが必要です。', 401);
      const store = injectedStore || createStore();
      if (route === '/api/admin/settings' && method === 'GET') return json(res, 200, {
        storage: process.env.STORAGE_DRIVER || (process.env.VERCEL ? 'sheets' : 'local'),
        providers: [
          { id: 'openai', label: 'OpenAI', configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || 'gpt-6-luna' },
          { id: 'anthropic', label: 'Claude', configured: Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL), model: process.env.ANTHROPIC_MODEL || '' }
        ]
      });
      if (route === '/api/admin/storage/initialize' && method === 'POST') { await store.initialize(); return json(res, 200, { ok: true }); }
      if (route === '/api/admin/backup' && method === 'GET') return json(res, 200, { format: 'ai-survey-v1', surveys: await getSurveys(store), responses: await getResponses(store) }, { 'content-disposition': 'attachment; filename="ai-survey-backup.json"' });
      if (route === '/api/admin/import' && method === 'POST') {
        const data = await bodyOf(req);
        check(data.format === 'ai-survey-v1' && Array.isArray(data.surveys) && Array.isArray(data.responses) && data.surveys.length <= 100 && data.responses.length <= 5000, 'このアプリのバックアップJSONを指定してください。');
        const surveys = data.surveys.map(normalizeSurvey);
        check(new Set(surveys.map(s => s.id)).size === surveys.length, 'アンケートIDが重複しています。');
        const responseKeys = new Set();
        const responses = data.responses.map(r => {
          const survey = surveys.find(s => s.id === r.surveyId);
          check(survey, '回答に対応するアンケート定義がありません。');
          const id = responseId(r.id);
          const key = `${survey.id}:${id}`;
          check(!responseKeys.has(key), 'バックアップ内の回答IDが重複しています。'); responseKeys.add(key);
          const clean = newResponse(survey, validateAnswers(survey, r), id);
          check(Number.isFinite(Date.parse(r.createdAt)), '回答日時が不正です。'); clean.createdAt = r.createdAt;
          check(typeof r.summary === 'string' && r.summary.length <= 6000 && Array.isArray(r.turns) && r.turns.length <= 20, '会話データが不正です。');
          clean.summary = r.summary;
          clean.turns = r.turns.map(t => {
            check(['user', 'assistant'].includes(t.role) && typeof t.content === 'string' && t.content.length <= 6000, '発言の形式が不正です。');
            return { role: t.role, content: t.content };
          });
          clean.questionInterviews = validateQuestionInterviews(survey, r.questionInterviews, clean.answers, clean.reasons);
          return clean;
        });
        const savedSurveys = await getSurveys(store);
        for (const incoming of responses) {
          const saved = savedSurveys.find(s => s.id === incoming.surveyId);
          if (saved) {
            const imported = surveys.find(s => s.id === incoming.surveyId);
            check(isDeepStrictEqual([saved.attributes, saved.questions], [imported.attributes, imported.questions]), '同じIDで設問定義が異なります。別の保存先へ復元してください。', 409);
          }
        }
        const existingSurveys = new Set(savedSurveys.map(s => s.id));
        const existingResponses = new Set((await getResponses(store)).map(r => `${r.surveyId}:${r.id}`));
        let surveyCount = 0, responseCount = 0;
        // Merge only; if Sheets fails part-way, retrying skips already imported IDs.
        for (const survey of surveys) if (!existingSurveys.has(survey.id)) { await store.append('surveys', { ...survey, status: 'draft' }); surveyCount++; }
        for (const response of responses) if (!existingResponses.has(`${response.surveyId}:${response.id}`)) { await store.append('responses', response); responseCount++; }
        return json(res, 200, { surveyCount, responseCount });
      }
      if (['/api/surveys', '/api/admin/surveys'].includes(route) && method === 'GET') {
        const surveys = await getSurveys(store);
        if (admin) {
          const responses = await getResponses(store);
          return json(res, 200, { surveys: surveys.map(s => ({ ...s, availability: availability(s, clock()), responseCount: responses.filter(r => r.surveyId === s.id).length })) });
        }
        return json(res, 200, { surveys: surveys.filter(s => s.status === 'public' && availability(s, clock()) === 'open').map(s => ({ id: s.id, title: s.title, description: s.description, endsAt: s.endsAt })) });
      }
      if (route === '/api/admin/surveys' && method === 'POST') {
        const survey = normalizeSurvey(await bodyOf(req));
        check(!(await getSurveys(store)).some(s => s.id === survey.id), 'このURL用IDはすでに使われています。', 409);
        await store.append('surveys', survey); return json(res, 201, { survey });
      }
      const match = route.match(/^\/api\/(admin\/)?surveys\/([^/]+)(?:\/(duplicate|results|export|backup|sheet-export|interview|responses))?$/);
      check(match && validId(match[2]), 'ページが見つかりません。', 404);
      const survey = await getSurvey(store, match[2]);
      const action = match[3];
      if (admin && action === 'duplicate' && method === 'POST') {
        const copy = normalizeSurvey({ ...survey, id: `event-${randomUUID()}`, title: `${survey.title.slice(0, 195)}（複製）`, status: 'draft', startsAt: '', endsAt: '' });
        await store.append('surveys', copy);
        return json(res, 201, { survey: copy });
      }
      if (admin && action === 'sheet-export' && method === 'POST') {
        check(typeof store.syncTabular === 'function', 'Googleスプレッドシート保存時に利用できます。');
        return json(res, 200, await store.syncTabular(survey));
      }
      if (admin && !action && method === 'PUT') {
        const updated = normalizeSurvey(await bodyOf(req));
        check(updated.id === survey.id, 'URL用IDは変更できません。');
        if ((await getResponses(store, survey.id)).length) {
          check((updated.spreadsheetId || '') === (survey.spreadsheetId || ''), '回答があるアンケートの保存先は変更できません。', 409);
          const structure = s => [s.attributes, s.questions].map(fields => fields.map(({ id, type, options, min, max, required, followUp, interviewRequired }) => ({ id, type, options, min, max, required, followUp, interviewRequired: Boolean(interviewRequired) })));
          check(isDeepStrictEqual(structure(updated), structure(survey)), '回答があるアンケートの設問構造は変更できません。別のアンケートを作成してください。', 409);
        }
        await store.append('surveys', updated); return json(res, 200, { survey: updated });
      }
      if (admin && !action && method === 'GET') return json(res, 200, { survey });
      if (admin && action === 'backup' && method === 'GET') return json(res, 200, { format: 'ai-survey-v1', surveys: [survey], responses: await getResponses(store, survey.id) }, { 'content-disposition': `attachment; filename="${survey.id}-backup.json"` });
      if (admin && action === 'results' && method === 'GET') return json(res, 200, buildResults(survey, await getResponses(store, survey.id)));
      if (admin && action === 'export' && method === 'GET') {
        const csv = toCsv(survey, await getResponses(store, survey.id));
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${survey.id}-responses.csv"` }); return res.end(csv);
      }
      check(!admin && survey.status !== 'draft', 'アンケートが見つかりません。', 404);
      if (!action && method === 'GET') {
        const result = publicSurvey(survey);
        if (result.availability === 'open' && await countResponses(store, survey.id) >= responseLimit(survey)) result.availability = 'closed';
        return json(res, 200, { survey: result });
      }
      requireOpen(survey, clock());
      if (action === 'interview' && method === 'POST') {
        const body = await bodyOf(req);
        const question = body.questionId ? survey.questions.find(q => q.id === body.questionId && (q.type === 'aiInterview' || q.followUp)) : null;
        check(!body.questionId || question, 'AIインタビューの設問が見つかりません。');
        check(question || survey.interview.enabled, 'このアンケートではAIインタビューを利用できません。', 403);
        const contextSurvey = question ? { ...survey, attributes: [], questions: [question], interview: { ...survey.interview, maxTurns: question.followUp?.maxTurns ?? question.maxTurns } } : survey;
        let response;
        if (!body.token) {
          check(body.action === 'start', 'AIインタビューを開始してください。');
          response = newResponse(survey, validateAnswers(contextSurvey, body), responseId(body.responseId));
          if (question) {
            response.questionId = question.id;
            const initial = question.followUp ? response.reasons[question.id] : response.answers[question.id];
            if (question.followUp) {
              const answer = response.answers[question.id];
              check(answer !== '' && (!Array.isArray(answer) || answer.length), '先に元の設問に回答してください。');
            }
            if (initial) response.turns.push({ role: 'user', content: initial });
          }
        } else {
          const data = readTicket(body, survey);
          check(!data.ready, 'このインタビューは完了しています。', 409);
          response = data.response;
          check((response.questionId || null) === (question?.id || null), '設問の会話が一致しません。');
          check(['reply', 'finish', ...(question ? ['finishWithoutSummary'] : [])].includes(body.action), '操作が不正です。');
          if (body.action === 'reply' || (['finish', 'finishWithoutSummary'].includes(body.action) && typeof body.reply === 'string' && body.reply.trim())) {
            check(response.turns.at(-1)?.role === 'assistant', '質問への回答を送信してください。');
            check(typeof body.reply === 'string' && body.reply.trim() && body.reply.length <= 3000, '回答は1〜3000文字で入力してください。');
            response.turns.push({ role: 'user', content: body.reply.trim() });
          }
        }
        const questionCount = response.turns.filter(t => t.role === 'assistant').length;
        const withoutSummary = body.action === 'finishWithoutSummary';
        const summarize = ['finish', 'finishWithoutSummary'].includes(body.action) || (body.action === 'reply' && questionCount >= contextSurvey.interview.maxTurns);
        if (question && summarize) check(response.turns.some(t => t.role === 'user'), 'この設問に少なくとも1回回答してください。');
        if (question && summarize && isInterviewRequired(question)) check(hasInterviewReply(response.turns), 'AIの質問に少なくとも1回回答してください。');
        check(summarize || questionCount < contextSurvey.interview.maxTurns, '質問回数の上限に達しました。');
        acquire(`ai:${survey.id}:${response.id}`);
        check(await countResponses(store, survey.id) < responseLimit(survey), '回答数の上限に達したため、受付を終了しました。', 403);
        const content = withoutSummary ? '' : await ai(contextSurvey, response, summarize);
        // Re-read after an AI request so an administrator's manual closure also takes effect.
        const latest = await getSurvey(store, survey.id);
        requireOpen(latest, clock());
        check(latest.updatedAt === survey.updatedAt, '設定が変更されました。回答画面を開き直してください。', 409);
        if (summarize) response.summary = content;
        else response.turns.push({ role: 'assistant', content });
        return json(res, 200, { response, ready: summarize, token: ticket(response, survey, summarize) });
      }
      if (action === 'responses' && method === 'POST') {
        const body = await bodyOf(req);
        let response;
        if (body.token) {
          const data = readTicket(body, survey);
          check(!data.response.questionId, '設問の回答はアンケート全体と一緒に送信してください。');
          check(data.ready || body.withoutSummary === true, 'インタビューを終了してください。');
          response = data.response;
          if (!data.ready && body.withoutSummary && typeof body.reply === 'string' && body.reply.trim()) {
            check(typeof body.reply === 'string' && body.reply.length <= 3000 && response.turns.at(-1)?.role === 'assistant', '回答は3000文字以内で入力してください。');
            response.turns.push({ role: 'user', content: body.reply.trim() });
          }
        } else response = newResponse(survey, validateAnswers(survey, body), responseId(body.responseId));
        attachQuestionInterviews(survey, response, body.questionTokens);
        check(JSON.stringify(response).length <= 240_000, '会話全体の保存可能サイズを超えています。長い設問の会話を短くして再送信してください。', 413);
        if (store.saveResponse) {
          await store.saveResponse(survey, response, clock);
          return json(res, 200, { ok: true, responseId: response.id });
        }
        acquire(`save:${survey.id}`);
        const savedResponses = await getResponses(store, survey.id);
        const existing = savedResponses.find(r => r.id === response.id);
        if (!existing) {
          const latest = await getSurvey(store, survey.id);
          requireOpen(latest, clock());
          check(savedResponses.length < responseLimit(latest), '回答数の上限に達したため、受付を終了しました。', 403);
          await store.append('responses', response);
        } else if (store.syncTabular) await store.syncTabular(survey);
        return json(res, 200, { ok: true, responseId: response.id });
      }
      throw new AppError(404, 'ページが見つかりません。');
    } catch (error) {
      json(res, error.status || 500, { error: error instanceof AppError ? error.message : '処理に失敗しました。入力内容を保持したまま、時間をおいて再度お試しください。' });
    } finally {
      if (lock) inFlight.delete(lock);
    }
  };
}
