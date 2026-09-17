import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { JWT } from 'google-auth-library';
import { AppError, check, responseTable } from './domain.js';

const HEADERS = ['id', 'survey_id', 'saved_at', 'title', 'summary', ...Array.from({ length: 8 }, (_, i) => `record_${i + 1}`)];
export class LocalStore {
  constructor(dir = process.env.DATA_DIR || path.resolve('data')) { this.dir = dir; }
  async records(table) {
    try { return (await readFile(path.join(this.dir, `${table}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async append(table, record) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, `${table}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  async initialize() { await mkdir(this.dir, { recursive: true }); }
}
export class SheetsStore {
  constructor({ client, spreadsheetId } = {}) {
    this.spreadsheetId = spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;
    this.client = client || new JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replaceAll('\\n', '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  }
  async request(endpoint, options = {}) {
    check(this.spreadsheetId, 'Googleスプレッドシートの接続設定が必要です。', 503);
    try {
      return (await this.client.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}${endpoint}`, timeout: 15_000, retry: false, ...options })).data;
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data;
      console.error('Sheets connection failed', JSON.stringify({ status, localCode: error.code, code: typeof detail?.error === 'string' ? detail.error : detail?.error?.status, reasons: detail?.error?.details?.map(d => d.reason).filter(Boolean), pemHeader: process.env.GOOGLE_PRIVATE_KEY?.startsWith('-----BEGIN PRIVATE KEY-----'), quotedKey: /^["']/.test(process.env.GOOGLE_PRIVATE_KEY || '') }));
      throw new AppError(status === 429 ? 429 : 503, status === 429
        ? '保存先の利用制限に達しました。時間をおいて再度お試しください。'
        : '保存先にアクセスできませんでした。接続設定を確認するか、時間をおいて再度お試しください。');
    }
  }
  async initialize(tables = ['surveys']) {
    const metadata = await this.request('?fields=sheets.properties.title');
    const existing = new Set((metadata.sheets || []).map(s => s.properties.title));
    const missing = tables.filter(t => !existing.has(t));
    if (missing.length) await this.request(':batchUpdate', { method: 'POST', data: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) } });
    // Recover from a partially completed initialization, without overwriting foreign data.
    for (const table of tables) {
      const range = encodeURIComponent(`'${table}'!A1:M1`);
      const first = await this.request(`/values/${range}`);
      if (!first.values?.[0]?.length) await this.request(`/values/${range}?valueInputOption=RAW`, { method: 'PUT', data: { values: [HEADERS] } });
      else check(JSON.stringify(first.values[0]) === JSON.stringify(HEADERS), '同名シートの形式が異なります。専用のスプレッドシートを指定してください。', 409);
    }
  }
  destination(survey) {
    return new SheetsStore({ client: this.client, spreadsheetId: survey.spreadsheetId || this.spreadsheetId });
  }
  async readOptional(table) {
    const metadata = await this.request('?fields=sheets.properties.title');
    if (!(metadata.sheets || []).some(s => s.properties.title === table)) return [];
    const first = await this.request(`/values/${encodeURIComponent(`'${table}'!A1:M1`)}`);
    check(JSON.stringify(first.values?.[0]) === JSON.stringify(HEADERS), '保存用タブの形式が異なります。管理者が保存先を確認してください。', 409);
    return this.readRows(table);
  }
  async records(table, surveyId) {
    if (table !== 'responses') return this.readRows(table);
    const surveys = (await getSurveys(this)).filter(s => !surveyId || s.id === surveyId);
    const rows = (await this.readOptional('responses')).filter(r => !surveyId || r.surveyId === surveyId);
    for (const survey of surveys) {
      const target = this.destination(survey);
      const records = await target.readOptional(`responses_${survey.id}`);
      check(records.every(r => r.surveyId === survey.id), '保存先タブに別のアンケートの回答が含まれています。', 409);
      rows.push(...records);
    }
    return rows;
  }
  async readRows(table) {
    const data = await this.request(`/values/${encodeURIComponent(`'${table}'!A2:M`)}`);
    return (data.values || []).filter(row => row[0]).map(row => {
      try { return JSON.parse(row.slice(5).join('')); }
      catch { throw new AppError(503, '保存データの形式が不正です。管理者がスプレッドシートを確認してください。'); }
    });
  }
  async append(table, record) {
    if (table === 'responses') {
      const survey = await getSurvey(this, record.surveyId);
      const target = this.destination(survey);
      const name = `responses_${survey.id}`;
      await target.initialize([name]);
      await target.appendRow(name, record);
      await this.syncTabular(survey);
      return;
    }
    return this.appendRow(table, record);
  }
  async appendRow(table, record) {
    const json = JSON.stringify(record);
    check(json.length <= 240_000, '回答データが大きすぎます。');
    const chunks = Array.from({ length: Math.ceil(json.length / 30_000) }, (_, i) => json.slice(i * 30_000, (i + 1) * 30_000));
    await this.request(`/values/${encodeURIComponent(`'${table}'!A:M`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', data: { values: [[record.id, record.surveyId || '', record.updatedAt || record.createdAt, record.title || '', (record.summary || '').slice(0, 30_000), ...chunks]] } });
  }
  async syncTabular(survey) {
    const responses = await getResponses(this, survey.id);
    const values = responseTable(survey, responses).map(row => row.map(value => typeof value === 'string' && value.length > 45000 ? value.slice(0, 45000) + '\n（続きはJSON出力で確認できます）' : value));
    const target = this.destination(survey);
    const title = `answers_${survey.id}`;
    const metadata = await target.request('?fields=sheets.properties');
    let sheet = (metadata.sheets || []).find(s => s.properties.title === title);
    if (!sheet) {
      const created = await target.request(':batchUpdate', { method: 'POST', data: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: Math.max(100, values.length), columnCount: Math.max(26, values[0].length) } } } }] } });
      sheet = created.replies[0].addSheet;
    } else {
      const first = await target.request(`/values/${encodeURIComponent(`'${title}'!A1:B1`)}`);
      check(!first.values?.[0]?.length || JSON.stringify(first.values[0]) === JSON.stringify(['回答ID', '回答日時']), '同名の表形式タブに別のデータがあります。上書きせず処理を中止しました。', 409);
    }
    const sheetId = sheet.properties.sheetId;
    await target.request(':batchUpdate', { method: 'POST', data: { requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(sheet.properties.gridProperties?.rowCount || 100, values.length), columnCount: Math.max(sheet.properties.gridProperties?.columnCount || 26, values[0].length), frozenRowCount: 1 } }, fields: 'gridProperties' } }] } });
    await target.request(`/values/${encodeURIComponent(`'${title}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', data: { values } });
    return { count: responses.length, tab: title };
  }
}
export function createStore() {
  const driver = process.env.STORAGE_DRIVER || (process.env.VERCEL ? 'sheets' : 'local');
  check(['local', 'sheets'].includes(driver), '保存先の設定が不正です。', 503);
  check(!process.env.VERCEL || driver === 'sheets', 'VercelではSheets保存を指定してください。', 503);
  return driver === 'sheets' ? new SheetsStore() : new LocalStore();
}
export async function getSurveys(store) {
  return [...new Map((await store.records('surveys')).map(s => [s.id, s])).values()];
}
export async function getSurvey(store, id) {
  const survey = (await getSurveys(store)).find(s => s.id === id);
  check(survey, 'アンケートが見つかりません。', 404);
  return survey;
}
export async function getResponses(store, surveyId) {
  // Append-only records allow retrying a save; aggregation counts each response ID once.
  return [...new Map((await store.records('responses', surveyId)).filter(r => !surveyId || r.surveyId === surveyId).map(r => [`${r.surveyId}:${r.id}`, r])).values()];
}
