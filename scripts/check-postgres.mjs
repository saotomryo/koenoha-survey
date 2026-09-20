// Explicit write test: creates one random survey, then deletes only its own rows.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresConfig, PostgresStore, databaseError } from '../lib/postgres.js';
import { normalizeSurvey, newResponse, buildResults, toCsv } from '../lib/domain.js';

let pool, created = false;
const id = `db-check-${randomUUID()}`;
try {
  pool = new pg.Pool(postgresConfig());
  pool.on('error', () => {});
  const store = new PostgresStore(pool);
  const other = new PostgresStore(pool);
  const survey = normalizeSurvey({ id, title: 'DB接続検証用（自動削除）', status: 'public',
    startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 600000).toISOString(),
    expectedResponses: 2, responseLimitMultiplier: 1,
    questions: [{ id: 'comment', type: 'text', label: '感想', aiContext: { text: '参考資料' } }] });
  await store.append('surveys', survey); created = true;
  assert.deepEqual(await other.getSurvey(id), survey);
  const responses = Array.from({ length: 8 }, () => newResponse(survey, { attributes: {}, answers: { comment: '日本語の回答' }, reasons: {} }, randomUUID()));
  const attempts = await Promise.allSettled(responses.map((response, index) => (index % 2 ? store : other).saveResponse(survey, response, Date.now)));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 2);
  assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.status === 403));
  assert.equal(await other.countResponses(id), 2);
  const saved = await store.records('responses', id);
  await other.saveResponse(survey, saved[0], Date.now);
  assert.equal(await store.countResponses(id), 2);
  assert.equal(buildResults(survey, saved).count, 2);
  assert.match(toCsv(survey, saved), /日本語の回答/);
  await other.append('surveys', { ...survey, status: 'closed', updatedAt: 'closed-version' });
  await assert.rejects(store.saveResponse(survey, responses.find(r => !saved.some(s => s.id === r.id)), Date.now), /受付期間外/);
  console.log('PASS: PostgreSQL CRUD, JSON round-trip, 8 concurrent saves / cap 2, retry deduplication, results/CSV, manual closure');
} catch (error) {
  console.error(error.name === 'AssertionError' ? 'DB検証の期待値が一致しませんでした。' : databaseError(error).message);
  process.exitCode = 1;
} finally {
  if (pool && created) {
    try {
      await pool.query('DELETE FROM public.koenoha_responses WHERE survey_id = $1', [id]);
      await pool.query('DELETE FROM public.koenoha_surveys WHERE id = $1', [id]);
      console.log('Test survey and responses: removed');
    } catch { console.error(`検証データの削除に失敗しました。管理者確認が必要です: ${id}`); process.exitCode = 1; }
  }
  await pool?.end();
}
