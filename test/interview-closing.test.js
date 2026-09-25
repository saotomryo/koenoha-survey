import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesFor } from '../lib/ai.js';

test('only the final available question closes the interview, including one-question interviews', () => {
  const survey = { title: '感想', attributes: [], questions: [{ id: 'q', label: '満足度', followUp: {} }], interview: { maxTurns: 3 } };
  const response = { questionId: 'q', answers: { q: '満足' }, turns: [{ role: 'user', content: '最初の理由' }] };
  assert.doesNotMatch(messagesFor(survey, response)[0].content, /今回が最後の質問/);
  response.turns.push({ role: 'assistant', content: '理由は？' }, { role: 'user', content: '実践的' });
  assert.doesNotMatch(messagesFor(survey, response)[0].content, /今回が最後の質問/);
  response.turns.push({ role: 'assistant', content: '具体的には？' }, { role: 'user', content: '演習' });
  const closing = messagesFor(survey, response)[0].content;
  assert.match(closing, /今回が最後の質問/);
  assert.match(closing, /特定の結論や合意へ誘導しない/);
  assert.match(closing, /新しい論点/);
  assert.doesNotMatch(messagesFor(survey, response, true)[0].content, /今回が最後の質問/);
  assert.match(messagesFor({ ...survey, interview: { maxTurns: 1 } }, { ...response, turns: [] })[0].content, /今回が最後の質問/);
  assert.match(messagesFor(survey, { ...response, questionId: undefined })[0].content, /今回が最後の質問/);
});
