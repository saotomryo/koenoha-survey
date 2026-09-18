import { randomUUID } from 'node:crypto';

// Restore the initial reason field and its required validation together.
export const SHOW_INITIAL_REASON = false;

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(condition, message, status = 400) {
  if (!condition) throw new AppError(status, message);
}
export function validId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(id); }
function string(value, max = 2000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function normalizeSurvey(input) {
  check(input && typeof input === 'object', 'アンケートの形式が不正です。');
  check(validId(input.id), 'URL用IDは半角英数字・ハイフンの3〜64文字で指定してください。');
  const status = input.status || 'draft';
  const expectedResponses = Number(input.expectedResponses ?? 100);
  const responseLimitMultiplier = Number(input.responseLimitMultiplier ?? 1.2);
  check(Number.isInteger(expectedResponses) && expectedResponses >= 1 && expectedResponses <= 100000, '想定回答数は1〜100000の整数で指定してください。');
  check(Number.isFinite(responseLimitMultiplier) && responseLimitMultiplier >= 1 && responseLimitMultiplier <= 1.9, '上限倍率は1.0〜1.9で指定してください。');
  check(['draft', 'public', 'closed'].includes(status), '公開状態が不正です。');
  const startsAt = input.startsAt ? new Date(input.startsAt).getTime() : NaN;
  const endsAt = input.endsAt ? new Date(input.endsAt).getTime() : NaN;
  check(!input.startsAt || Number.isFinite(startsAt), '開始日時が不正です。');
  check(!input.endsAt || Number.isFinite(endsAt), '終了日時が不正です。');
  check(status !== 'public' || (Number.isFinite(startsAt) && Number.isFinite(endsAt)), '公開するには受付開始・終了日時が必要です。');
  check(!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt < endsAt, '終了日時は開始日時より後にしてください。');
  const title = string(input.title, 200);
  const spreadsheetId = typeof input.spreadsheetId === 'string' ? input.spreadsheetId.trim() : '';
  check(!spreadsheetId || /^[a-zA-Z0-9_-]{10,200}$/.test(spreadsheetId), '保存先にはスプレッドシートIDを入力してください（URLではありません）。');
  check(title, 'タイトルを入力してください。');
  const fieldIds = new Set();
  const normalizeFields = (fields) => {
    check(Array.isArray(fields) && fields.length <= 30, '設問は30件までです。');
    return fields.map(field => {
      check(field && typeof field === 'object', '設問の形式が不正です。');
      const id = field.id || field.key;
      check(typeof id === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id) && !fieldIds.has(id), '設問IDが不正または重複しています。');
      fieldIds.add(id);
      check(['text', 'longText', 'single', 'multiple', 'slider', 'aiInterview'].includes(field.type), '設問の種類が不正です。');
      const label = string(field.label, 300);
      check(label, '設問名を入力してください。');
      const options = ['single', 'multiple'].includes(field.type) ? (Array.isArray(field.options) ? field.options : []).map(o => string(typeof o === 'object' ? o.label : o, 200)).filter(Boolean) : [];
      check(!['single', 'multiple'].includes(field.type) || (options.length > 0 && options.length <= 30 && new Set(options).size === options.length), '選択肢を重複なしで1〜30件指定してください。');
      const min = Number(field.min ?? 1), max = Number(field.max ?? 5);
      check(field.type !== 'slider' || (Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max <= 100 && max > min), '数値範囲は0〜100の整数で指定してください。');
      const maxTurns = Number(field.maxTurns ?? 5);
      check(field.type !== 'aiInterview' || (Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 10), '設問の深掘り回数は1〜10回です。');
      let followUp;
      if (field.followUp) {
        check(field.type !== 'aiInterview', '独立したAI設問には深掘りを追加できません。');
        const depth = Number(field.followUp.maxTurns ?? 5);
        check(Number.isInteger(depth) && depth >= 1 && depth <= 10, '深掘り回数は1〜10回です。');
        followUp = { required: Boolean(field.followUp.required), maxTurns: depth };
      }
      return { id, label, type: field.type, required: Boolean(field.required), options, min, max, ...(field.type === 'aiInterview' ? { maxTurns } : {}), ...(followUp ? { followUp } : {}) };
    });
  };
  const attributes = normalizeFields(input.attributes || []);
  check(attributes.every(f => f.type !== 'aiInterview' && !f.followUp), 'AIインタビューは属性ではなく設問に追加してください。');
  const questions = normalizeFields(input.questions || []);
  check(questions.length > 0, '設問を1つ以上追加してください。');
  const provider = input.interview?.provider || 'openai';
  check(['openai', 'anthropic'].includes(provider), 'AIプロバイダーが不正です。');
  const maxTurns = Number(input.interview?.maxTurns ?? 5);
  check(Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 10, 'AIの質問回数は1〜10回です。');
  return {
    id: input.id, title, description: string(input.description), status, spreadsheetId, expectedResponses, responseLimitMultiplier,
    startsAt: Number.isFinite(startsAt) ? new Date(startsAt).toISOString() : '',
    endsAt: Number.isFinite(endsAt) ? new Date(endsAt).toISOString() : '',
    attributes, questions,
    interview: { enabled: Boolean(input.interview?.enabled), provider, model: string(input.interview?.model, 100), maxTurns },
    updatedAt: new Date().toISOString()
  };
}
export function availability(survey, now = Date.now()) {
  if (survey.status === 'draft') return 'draft';
  if (survey.status === 'closed') return 'closed';
  if (!survey.startsAt || !survey.endsAt || !Number.isFinite(Date.parse(survey.startsAt)) || !Number.isFinite(Date.parse(survey.endsAt))) return 'closed';
  if (now < Date.parse(survey.startsAt)) return 'scheduled';
  if (now >= Date.parse(survey.endsAt)) return 'closed';
  return 'open';
}
export function responseLimit(survey) {
  return Math.ceil((survey.expectedResponses ?? 100) * (survey.responseLimitMultiplier ?? 1.2));
}
export function requireOpen(survey, now = Date.now()) {
  check(availability(survey, now) === 'open', '現在、このアンケートは受付期間外です。', 403);
}
export function publicSurvey(survey) {
  const { provider, model, ...interview } = survey.interview;
  return { id: survey.id, title: survey.title, description: survey.description, startsAt: survey.startsAt, endsAt: survey.endsAt, attributes: survey.attributes, questions: survey.questions, interview, showInitialReason: SHOW_INITIAL_REASON, availability: availability(survey) };
}
export function validateAnswers(survey, body) {
  const result = { attributes: {}, answers: {}, reasons: {} };
  for (const group of ['attributes', 'questions']) {
    const target = group === 'questions' ? 'answers' : group;
    const source = body?.[target] || {};
    for (const field of survey[group]) {
      let value = source[field.id];
      const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
      const required = field.required && field.type !== 'aiInterview';
      check(!required || !empty, `${field.label}に回答してください。`);
      if (empty) { result[target][field.id] = field.type === 'multiple' ? [] : ''; continue; }
      if (field.type === 'multiple') {
        check(Array.isArray(value) && value.length <= field.options.length && value.every(v => field.options.includes(v)), '選択肢が不正です。');
        value = [...new Set(value)];
      } else if (field.type === 'single') check(field.options.includes(value), '選択肢が不正です。');
      else if (field.type === 'slider') {
        check((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '', '数値が不正です。');
        value = Number(value);
        check(Number.isInteger(value) && value >= field.min && value <= field.max, '数値が範囲外です。');
      } else {
        check(typeof value === 'string' && value.length <= 3000, '自由記述は3000文字までです。');
        value = value.trim();
        check(!required || value, `${field.label}に回答してください。`);
      }
      result[target][field.id] = value;
    }
  }
  for (const field of survey.questions.filter(f => f.followUp)) {
    const reason = body?.reasons?.[field.id] ?? '';
    check(typeof reason === 'string' && reason.length <= 3000, '理由は3000文字までです。');
    result.reasons[field.id] = reason.trim();
  }
  check(JSON.stringify(result).length <= 40_000, '回答全体は40000文字以内で入力してください。');
  return result;
}
export function newResponse(survey, values, id = randomUUID()) {
  return { id, surveyId: survey.id, createdAt: new Date().toISOString(), ...values, turns: [], summary: '', questionInterviews: {} };
}
export function validateQuestionInterviews(survey, interviews = {}, answers = {}, reasons = {}) {
  check(interviews && typeof interviews === 'object' && !Array.isArray(interviews), '設問ごとの会話データが不正です。');
  const fields = survey.questions.filter(f => f.type === 'aiInterview' || f.followUp);
  check(Object.keys(interviews).every(id => fields.some(f => f.id === id)), '不明な設問の会話が含まれています。');
  const result = {};
  for (const field of fields) {
    const interview = interviews[field.id];
    check(!SHOW_INITIAL_REASON || !field.followUp?.required || reasons[field.id]?.trim() || interview, `${field.label}の理由を入力するか、AIインタビューに回答してください。`);
    check(field.type !== 'aiInterview' || !field.required || interview || (typeof answers[field.id] === 'string' && answers[field.id].trim()), `${field.label}に回答してください。`);
    if (!interview) continue;
    check(typeof interview.summary === 'string' && interview.summary.length <= 6000 && Array.isArray(interview.turns) && interview.turns.length <= 21, '会話データが不正です。');
    const turns = interview.turns.map(t => {
      check(t && ['user', 'assistant'].includes(t.role) && typeof t.content === 'string' && t.content.trim() && t.content.length <= (t.role === 'user' ? 3000 : 6000), '発言の形式が不正です。');
      return { role: t.role, content: t.content };
    });
    check(turns.some(t => t.role === 'user'), `${field.label}のAIインタビューに回答してください。`);
    result[field.id] = { summary: interview.summary, turns };
  }
  return result;
}
function questionText(response, field) {
  const interview = field.type === 'aiInterview' && response.questionInterviews?.[field.id];
  return interview ? interview.summary || interview.turns.filter(t => t.role === 'user').map(t => t.content).join('\n') : response.answers?.[field.id] ?? response.attributes?.[field.id];
}
export function buildResults(survey, responses) {
  return { survey, count: responses.length, interviewCount: responses.filter(r => r.turns?.length || Object.values(r.questionInterviews || {}).some(i => i.turns.length)).length,
    fields: [...survey.attributes, ...survey.questions].map(field => {
      const values = responses.map(r => questionText(r, field)).filter(v => v !== '' && v != null && (!Array.isArray(v) || v.length));
      const options = field.type === 'slider' ? Array.from({ length: field.max - field.min + 1 }, (_, i) => field.min + i) : field.options;
      return { ...field, answered: values.length,
        average: field.type === 'slider' && values.length ? values.reduce((s, v) => s + Number(v), 0) / values.length : null,
        rows: options.map(label => ({ label, count: values.filter(v => Array.isArray(v) ? v.includes(label) : v === label).length })),
        texts: ['text', 'longText', 'aiInterview'].includes(field.type) ? values : [],
        reasons: field.followUp ? responses.filter(r => r.reasons?.[field.id]).map(r => ({ answer: r.answers[field.id], reason: r.reasons[field.id] })) : [] };
    }), responses };
}
export function responseTable(survey, responses) {
  const fields = [...survey.attributes, ...survey.questions];
  const transcript = turns => (turns || []).map(t => `${t.role === 'assistant' ? 'AI' : '回答者'}: ${t.content}`).join('\n');
  const headers = fields.flatMap(f => [f.label, ...(f.followUp ? [`${f.label}：理由`] : []), ...(f.type === 'aiInterview' || f.followUp ? [`${f.label}：AI要約`, `${f.label}：会話履歴`] : [])]);
  const rows = [['回答ID', '回答日時', ...headers, 'AI要約', 'AI会話履歴'], ...responses.map(r => [r.id, r.createdAt, ...fields.flatMap(f => [r.answers?.[f.id] ?? r.attributes?.[f.id] ?? '', ...(f.followUp ? [r.reasons?.[f.id] || ''] : []), ...(f.type === 'aiInterview' || f.followUp ? [r.questionInterviews?.[f.id]?.summary || '', transcript(r.questionInterviews?.[f.id]?.turns)] : [])]), r.summary, transcript(r.turns)])];
  return rows.map(row => row.map(value => Array.isArray(value) ? value.join(' / ') : value ?? ''));
}
export function toCsv(survey, responses) {
  return '\uFEFF' + responseTable(survey, responses).map(row => row.map(value => {
    let text = Array.isArray(value) ? value.join(' / ') : String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
