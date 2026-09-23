import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../lib/ai.js';

const survey = { title: 'テスト', attributes: [], questions: [], interview: { provider: 'openai', model: 'invalid-model', maxTurns: 1 } };
test('OpenAI defaults to GPT-6 Luna while respecting environment and survey overrides', async t => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [['OPENAI_API_KEY', originalKey], ['OPENAI_MODEL', originalModel]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret';
  delete process.env.OPENAI_MODEL;
  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'テスト応答' } }] }));
  };
  const defaultSurvey = { ...survey, interview: { ...survey.interview, model: '' } };
  for (const summary of [false, true]) {
    await generate(defaultSurvey, { answers: {}, turns: [] }, summary);
    assert.equal(sent.model, 'gpt-6-luna');
  }
  process.env.OPENAI_MODEL = 'environment-model';
  await generate(defaultSurvey, { answers: {}, turns: [] });
  assert.equal(sent.model, 'environment-model');
  await generate(survey, { answers: {}, turns: [] });
  assert.equal(sent.model, 'invalid-model');
});
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
