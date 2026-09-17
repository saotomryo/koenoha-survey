// Dedicated loopback-only test process: no real provider or production storage access.
import { createApp } from '../lib/app.js';
import { createWebServer } from '../server.js';
import { AppError, normalizeSurvey } from '../lib/domain.js';

process.env.ADMIN_PASSWORD = 'ui-fixture-password-only';
process.env.SESSION_SECRET = 'ui-fixture-session-secret-for-local-tests-only';
const survey = normalizeSurvey({
  id: 'question-interview-check', title: '設問別AIインタビューの動作確認', status: 'public',
  startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(),
  questions: [
    { id: 'learning', label: '今日の学びを教えてください。', type: 'aiInterview', required: true, maxTurns: 2 },
    { id: 'improvement', label: '次回への改善案を教えてください。', type: 'aiInterview', required: false, maxTurns: 1 },
    { id: 'rating', label: '最後に満足度を教えてください。', type: 'single', required: true, options: ['満足', '普通', '不満'], followUp: { required: true, maxTurns: 2 } }
  ], attributes: [], interview: { enabled: false, provider: 'openai', maxTurns: 5 }
});
const tables = { surveys: [survey], responses: [] };
const store = {
  async records(table) { return structuredClone(tables[table]); },
  async append(table, record) { tables[table].push(structuredClone(record)); },
  async initialize() {}
};
const ai = async (context, response, summary) => {
  if (response.turns.at(-1)?.content === '通信エラーテスト') throw new AppError(429, 'AIの利用制限に達しました。入力を保持しています。');
  const topic = context.questions[0].id === 'learning' ? '学び' : '改善案';
  return summary ? `${topic}の要約（テスト用）：${response.turns.filter(t => t.role === 'user').map(t => t.content).join('。')}` : `${topic}について、${response.turns.filter(t => t.role === 'assistant').length ? 'ほかに印象に残った点はありますか？' : '具体例を1つ教えてください。'}`;
};
createWebServer(createApp({ store, ai })).listen(5178, '127.0.0.1', () => console.log('UI fixture: http://localhost:5178/survey/question-interview-check'));
