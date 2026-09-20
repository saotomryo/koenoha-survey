import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { SheetsStore, getSurveys, getResponses } from '../lib/storage.js';
import { postgresConfig, PostgresStore, databaseError } from '../lib/postgres.js';
import { createApp } from '../lib/app.js';
import { signToken } from '../lib/security.js';
import { normalizeSurvey, validateAnswers, check } from '../lib/domain.js';

let pool;
try {
  const source = new SheetsStore();
  const backup = { format: 'ai-survey-v1', surveys: await getSurveys(source), responses: await getResponses(source) };
  const directory = resolve('data/backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = resolve(directory, `sheets-before-postgres-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(filename, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ backup: filename, surveys: backup.surveys.length, responses: backup.responses.length }));
  pool = new pg.Pool(postgresConfig());
  pool.on('error', () => {});
  const target = new PostgresStore(pool);
  const app = createApp({ store: target });
  const request = Readable.from([JSON.stringify(backup)]);
  request.url = '/api/admin/import'; request.method = 'POST';
  const origin = process.env.APP_ORIGIN || 'http://localhost';
  request.headers = { 'content-type': 'application/json', 'x-survey-request': '1', host: new URL(origin).host, origin, cookie: `survey_admin=${signToken({ admin: true }, 'admin')}` };
  let status, body;
  await app(request, { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } });
  check(status === 200, body?.error || '移行に失敗しました。', status);
  console.log(JSON.stringify({ imported: body }));
  const surveys = await getSurveys(target), responses = await getResponses(target);
  const comparable = value => { const { updatedAt, status, ...record } = normalizeSurvey(value); return record; };
  for (const survey of backup.surveys) {
    const saved = surveys.find(s => s.id === survey.id);
    check(saved && isDeepStrictEqual(comparable(saved), comparable(survey)), '移行後の設問定義が一致しません。');
  }
  for (const response of backup.responses) {
    const saved = responses.find(r => r.id === response.id && r.surveyId === response.surveyId);
    const survey = backup.surveys.find(s => s.id === response.surveyId);
    const expected = { ...response, ...validateAnswers(survey, response), questionInterviews: response.questionInterviews || {} };
    check(saved && isDeepStrictEqual(saved, expected), '移行後の回答・会話が一致しません。');
  }
  console.log(JSON.stringify({ verified: true, matchedSurveys: backup.surveys.length, matchedResponses: backup.responses.length, targetSurveys: surveys.length, targetResponses: responses.length, draftSurveys: surveys.filter(s => s.status === 'draft').length }));
} catch (error) {
  console.error(databaseError(error).message);
  process.exitCode = 1;
} finally { await pool?.end(); }
