import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../lib/ai.js';

const survey = { title: 'テスト', attributes: [], questions: [], interview: { provider: 'openai', model: 'invalid-model', maxTurns: 1 } };
test('model, authentication, billing, and rate errors have distinct safe messages', async t => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret';
  t.after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
  for (const [status, code, pattern] of [
    [404, 'model_not_found', /指定されたAIモデルが見つからない/],
    [401, 'invalid_api_key', /APIキーの認証に失敗/],
    [429, 'insufficient_quota', /利用残高または利用上限/],
    [429, 'rate_limit_exceeded', /短時間の利用制限/],
    [400, 'unsupported_parameter', /送信設定/]
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code, message: 'DO_NOT_EXPOSE_RAW_ERROR_OR_KEY' } }), { status });
    await assert.rejects(() => generate(survey, { answers: {}, turns: [] }), error => pattern.test(error.message) && !error.message.includes('DO_NOT_EXPOSE'));
  }
});
