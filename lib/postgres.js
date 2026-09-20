import pg from 'pg';
import { AppError, check, requireOpen, responseLimit } from './domain.js';

export function postgresConfig(env = process.env) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new AppError(503, 'DATABASE_URLにPostgreSQLの接続文字列を設定してください。'); }
  check(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1, 'DATABASE_URLの形式が不正です。', 503);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const mode = url.searchParams.get('sslmode');
  check(mode !== 'disable' || local, '外部DBにはTLS接続が必要です。', 503);
  check(!['sslcert', 'sslkey', 'sslrootcert'].some(key => url.searchParams.has(key)), '証明書はDATABASE_SSL_CAで指定してください。', 503);
  // Prevent URL options from overriding certificate verification in node-postgres.
  for (const key of ['sslmode', 'ssl', 'uselibpqcompat', 'channel_binding']) url.searchParams.delete(key);
  const max = Number(env.DATABASE_POOL_MAX || 3);
  check(Number.isInteger(max) && max >= 1 && max <= 10, 'DATABASE_POOL_MAXは1〜10で設定してください。', 503);
  return { connectionString: url.toString(), max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000,
    query_timeout: 15000, allowExitOnIdle: true, enableChannelBinding: true,
    ssl: local && mode === 'disable' ? false : { rejectUnauthorized: true, ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA.replaceAll('\\n', '\n') } : {}) } };
}

export function databaseError(error) {
  if (error instanceof AppError) return error;
  if (['28P01', '28000'].includes(error.code)) return new AppError(503, 'DB認証に失敗しました。接続ユーザーとパスワードを確認してください。');
  if (error.code === '42P01' || error.code === '3F000') return new AppError(503, 'DBが未初期化です。管理画面で保存先を初期化してください。');
  if (error.code === '42501') return new AppError(503, 'DBの操作権限が不足しています。接続ユーザーの権限を確認してください。');
  if (error.code === '23505') return new AppError(409, '同じIDのデータが既に保存されています。');
  if (['53300', '55P03', '57014', '40001', '40P01'].includes(error.code)) return new AppError(503, 'DBが混雑しています。入力を保持したまま時間をおいて再試行してください。');
  return new AppError(503, 'DBに接続または保存できませんでした。接続設定・TLS証明書・利用上限を確認してください。');
}

let shared;
export function createPostgresStore() {
  const config = postgresConfig();
  const key = JSON.stringify(config);
  if (!shared || shared.key !== key) {
    if (shared) void shared.pool.end().catch(() => {});
    const pool = new pg.Pool(config);
    // Idle disconnects must not crash the process or expose server error details.
    pool.on('error', () => {});
    shared = { key, pool };
  }
  return new PostgresStore(shared.pool);
}

export class PostgresStore {
  constructor(pool) { this.pool = pool; }
  async query(sql, values = []) {
    try { return await this.pool.query(sql, values); } catch (error) { throw databaseError(error); }
  }
  async transaction(work) {
    let client, discard = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '10s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw databaseError(error);
    } finally { client?.release(discard); }
  }
  async initialize() {
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(719204501)');
      await client.query(`CREATE TABLE IF NOT EXISTS public.koenoha_surveys (
        id text PRIMARY KEY, record jsonb NOT NULL,
        CHECK (record->>'id' = id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS public.koenoha_responses (
        survey_id text NOT NULL REFERENCES public.koenoha_surveys(id),
        id text NOT NULL, record jsonb NOT NULL,
        PRIMARY KEY (survey_id, id),
        CHECK (record->>'id' = id AND record->>'surveyId' = survey_id)
      )`);
    });
  }
  async records(table, surveyId) {
    check(['surveys', 'responses'].includes(table), '不正な保存先です。');
    const result = table === 'surveys'
      ? await this.query('SELECT record FROM public.koenoha_surveys ORDER BY id')
      : surveyId
        ? await this.query('SELECT record FROM public.koenoha_responses WHERE survey_id = $1 ORDER BY id', [surveyId])
        : await this.query('SELECT record FROM public.koenoha_responses ORDER BY survey_id, id');
    return result.rows.map(row => row.record);
  }
  async getSurvey(id) {
    const result = await this.query('SELECT record FROM public.koenoha_surveys WHERE id = $1', [id]);
    check(result.rows.length, 'アンケートが見つかりません。', 404);
    return result.rows[0].record;
  }
  async countResponses(id) {
    const result = await this.query('SELECT count(*)::integer AS count FROM public.koenoha_responses WHERE survey_id = $1', [id]);
    return result.rows[0].count;
  }
  async append(table, record) {
    check(JSON.stringify(record).length <= 240000, '保存データが大きすぎます。');
    if (table === 'surveys') {
      await this.query('INSERT INTO public.koenoha_surveys (id, record) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record', [record.id, JSON.stringify(record)]);
      return;
    }
    check(table === 'responses', '不正な保存先です。');
    // Admin import may restore closed surveys or historical data above the cap.
    await this.transaction(async client => {
      const result = await client.query('SELECT id FROM public.koenoha_surveys WHERE id = $1 FOR UPDATE', [record.surveyId]);
      check(result.rows.length, 'アンケートが見つかりません。', 404);
      await client.query('INSERT INTO public.koenoha_responses (survey_id, id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (survey_id, id) DO NOTHING', [record.surveyId, record.id, JSON.stringify(record)]);
    });
  }
  async saveResponse(survey, response, now) {
    return this.transaction(async client => {
      const result = await client.query('SELECT record FROM public.koenoha_surveys WHERE id = $1 FOR UPDATE', [survey.id]);
      check(result.rows.length, 'アンケートが見つかりません。', 404);
      const latest = result.rows[0].record;
      const existing = await client.query('SELECT id FROM public.koenoha_responses WHERE survey_id = $1 AND id = $2', [survey.id, response.id]);
      if (existing.rows.length) return;
      requireOpen(latest, now());
      check(latest.updatedAt === survey.updatedAt, '設定が変更されました。回答画面を開き直してください。', 409);
      const counts = await client.query('SELECT count(*)::integer AS count FROM public.koenoha_responses WHERE survey_id = $1', [survey.id]);
      check(counts.rows[0].count < responseLimit(latest), '回答数の上限に達したため、受付を終了しました。', 403);
      await client.query('INSERT INTO public.koenoha_responses (survey_id, id, record) VALUES ($1, $2, $3::jsonb)', [survey.id, response.id, JSON.stringify(response)]);
    });
  }
}
