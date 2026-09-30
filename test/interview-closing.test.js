import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesFor } from '../lib/ai.js';

test('only the final available question closes the interview, including one-question interviews', () => {
  const survey = { title: '感想', attributes: [], questions: [{ id: 'q', label: '満足度', followUp: {} }], interview: { maxTurns: 3 } };
  const response = { questionId: 'q', answers: { q: '満足' }, turns: [{ role: 'user', content: '最初の理由' }] };
  const state = (s, r) => JSON.parse(messagesFor(s, r)[1].content).interviewState;
  const fixed = messagesFor(survey, response)[0].content;
  assert.equal(state(survey, response).closing, false);
  response.turns.push({ role: 'assistant', content: '理由は？' }, { role: 'user', content: '実践的' });
  assert.equal(state(survey, response).closing, false);
  response.turns.push({ role: 'assistant', content: '具体的には？' }, { role: 'user', content: '演習' });
  const closing = messagesFor(survey, response)[0].content;
  assert.equal(state(survey, response).closing, true);
  assert.equal(closing, fixed);
  assert.match(closing, /特定の結論や合意へ誘導しない/);
  assert.match(closing, /新しい論点/);
  assert.doesNotMatch(messagesFor(survey, response, true)[0].content, /今回が最後の質問/);
  assert.equal(state({ ...survey, interview: { maxTurns: 1 } }, { ...response, turns: [] }).closing, true);
  assert.equal(state(survey, { ...response, questionId: undefined }).closing, true);
});

test('fixed prompt is identical across respondents and excludes their answers and conversation', () => {
  const survey = { title: '勉強会', description: '感想', attributes: [], questions: [{ id: 'q', label: '満足度', options: ['満足', '不満'], followUp: {}, aiContext: { text: '共通資料' } }], interview: { maxTurns: 3 } };
  const first = messagesFor(survey, { questionId: 'q', answers: { q: '参加者Aの感想' }, turns: [] });
  const second = messagesFor(survey, { questionId: 'q', answers: { q: '参加者Bの感想' }, turns: [{ role: 'assistant', content: '質問' }, { role: 'user', content: '個別回答' }] });
  assert.equal(first[0].content, second[0].content);
  assert.match(first[0].content, /共通資料/);
  assert.doesNotMatch(first[0].content, /参加者Aの感想|参加者Bの感想|個別回答/);
  assert.notEqual(first[1].content, second[1].content);
});
