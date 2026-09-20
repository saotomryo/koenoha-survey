import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresConfig, PostgresStore, databaseError } from '../lib/postgres.js';

test('PostgreSQL configuration verifies TLS, bounds pooling, and never prints connection secrets', () => {
  const config = postgresConfig({ DATABASE_URL: 'postgresql://test:private@example.invalid/db?sslmode=require&channel_binding=require' });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.max, 3);
  assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
  assert.equal(postgresConfig({ DATABASE_URL: 'postgres://localhost/test?sslmode=disable' }).ssl, false);
  for (const env of [{}, { DATABASE_URL: 'https://example.com/db' }, { DATABASE_URL: 'postgres://example.com/db?sslmode=disable' }, { DATABASE_URL: 'postgres://example.com/db', DATABASE_POOL_MAX: '100' }]) assert.throws(() => postgresConfig(env));
  assert.equal(databaseError(new Error('secret-password')).message.includes('secret-password'), false);
  assert.match(databaseError({ code: '28P01' }).message, /認証/);
  assert.match(databaseError({ code: '42P01' }).message, /初期化/);
});

test('PostgreSQL transaction rolls back and releases the same client on failure', async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); return { rows: [] }; }, release: discard => calls.push(`release:${discard}`) };
  const store = new PostgresStore({ connect: async () => client });
  await assert.rejects(store.transaction(async () => { throw new Error('private details'); }), /DB/);
  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'release:false');
});

test('PostgreSQL capacity check holds a survey lock and skips duplicate retries', async () => {
  const survey = { id: 'test', status: 'public', startsAt: '2020-01-01', endsAt: '2099-01-01', updatedAt: 'v1', expectedResponses: 1, responseLimitMultiplier: 1 };
  let duplicate = false, count = 1;
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FOR UPDATE')) return { rows: [{ record: survey }] };
    if (sql.includes('SELECT id FROM')) return { rows: duplicate ? [{ id: 'response' }] : [] };
    if (sql.includes('count(*)')) return { rows: [{ count }] };
    return { rows: [] };
  }, release() {} };
  const store = new PostgresStore({ connect: async () => client });
  const response = { id: 'response', surveyId: survey.id };
  await assert.rejects(store.saveResponse(survey, response, Date.now), /上限/);
  assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
  duplicate = true;
  await store.saveResponse(survey, response, Date.now);
  duplicate = false; count = 0;
  await store.saveResponse(survey, response, Date.now);
  assert.ok(calls.find(c => c.sql.startsWith('INSERT')).values.includes(JSON.stringify(response)));
});
