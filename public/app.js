const root = document.querySelector('#app');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (action, label, symbol, style = '') => `<button type="button" data-action="${action}" class="${style}">${symbol ? icon(symbol) : ''}${label}</button>`;
const tool = (action, label, symbol) => `<button type="button" data-action="${action}" class="icon-button" aria-label="${label}" title="${label}">${icon(symbol)}</button>`;
const dateLabel = value => value ? new Date(value).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '未設定';
const toLocal = value => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const fromLocal = value => value ? new Date(value).toISOString() : '';
const statuses = { draft: '下書き', open: '受付中', scheduled: '受付開始前', closed: '受付終了' };
const typeNames = { single: '単一選択', multiple: '複数選択', slider: '数値評価', text: '短文', longText: '自由記述', aiInterview: 'AIインタビュー' };
let state = { admin: false, survey: null, settings: null, response: null, interview: null, questionInterviews: {}, busy: false, timer: null };

async function api(url, method = 'GET', data) {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-survey-request': '1' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '通信に失敗しました。');
  return body;
}
function mount(content) {
  clearInterval(state.timer);
  root.innerHTML = `<header class="topbar"><a class="brand" href="/">${icon('messages-square')}<span>Koenoha Survey</span></a><nav><a href="/">アンケート</a><a href="/admin">管理</a>${state.admin ? button('logout', 'ログアウト', 'log-out', 'quiet') : ''}</nav></header><main>${content}<div id="notice" role="status" aria-live="polite"></div></main>`;
  lucide.createIcons();
}
function notice(message, success = false) {
  const node = document.querySelector('#notice');
  node.className = success ? 'notice success' : 'notice error'; node.textContent = message;
}
async function run(task, reportError = notice) {
  if (state.busy) return;
  state.busy = true;
  const controls = [...root.querySelectorAll('button, input, select, textarea')];
  const disabled = controls.map(el => el.disabled);
  controls.forEach(el => { el.disabled = true; });
  root.setAttribute('aria-busy', 'true');
  try { await task(); } catch (error) { reportError(error.message || '通信に失敗しました。時間をおいて再度お試しください。'); }
  finally { controls.forEach((el, i) => { if (el.isConnected) el.disabled = disabled[i]; }); state.busy = false; root.removeAttribute('aria-busy'); }
}
function heading(title, subtitle = '', actions = '') {
  return `<div class="page-heading"><div><h1>${escape(title)}</h1>${subtitle ? `<p>${escape(subtitle)}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
}
function period(survey) { return `${dateLabel(survey.startsAt)} 〜 ${dateLabel(survey.endsAt)}`; }
function badge(status) { return `<span class="badge ${status}">${statuses[status]}</span>`; }
function field(id = `q_${crypto.randomUUID().slice(0, 8)}`) { return { id, type: 'longText', label: '', required: false, options: [], min: 1, max: 5, maxTurns: 5 }; }
function template() {
  return { id: `event-${crypto.randomUUID().slice(0, 8)}`, title: '勉強会の振り返りアンケート', description: '本日はご参加ありがとうございました。今後の企画の参考に、感想やご意見をお聞かせください。', status: 'draft', startsAt: '', endsAt: '',
    attributes: [], questions: [
      { ...field('satisfaction'), type: 'slider', label: '今回の勉強会の満足度を教えてください。', required: true },
      { ...field('useful'), type: 'aiInterview', label: '印象に残ったことや、役に立ったことを教えてください。', maxTurns: 3 },
      { ...field('improvements'), type: 'longText', label: '改善してほしいことや、次回取り上げてほしいテーマはありますか。' }
    ], interview: { enabled: false, provider: 'openai', model: '', maxTurns: 5 } };
}
async function home() {
  const { surveys } = await api('/api/surveys');
  mount(heading('アンケート', '受付中のアンケート') + (surveys.length ? `<div class="survey-list">${surveys.map(s => `<article><div>${badge('open')}<h2><a href="/survey/${s.id}">${escape(s.title)}</a></h2><p>${escape(s.description)}</p><p class="muted">受付終了：${dateLabel(s.endsAt)}</p></div><a class="button primary" href="/survey/${s.id}">回答する ${icon('arrow-right')}</a></article>`).join('')}</div>` : '<div class="empty">現在、受付中のアンケートはありません。</div>'));
}
function login() {
  mount(`<section class="login"><h1>管理者ログイン</h1><form id="login"><label>パスワード<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><button class="primary" type="submit">${icon('log-in')}ログイン</button></form></section>`);
}
async function admin() {
  state.settings = await api('/api/admin/settings');
  let surveys = [], storageError = '';
  try { surveys = (await api('/api/admin/surveys')).surveys; } catch (error) { storageError = error.message; }
  mount(heading('アンケート管理', '', button('create', 'アンケートを作成', 'plus', 'primary')) +
    `<div class="admin-summary"><span>アンケート <strong>${surveys.length}</strong></span><span>回答 <strong>${surveys.reduce((s, x) => s + x.responseCount, 0)}</strong></span></div>` +
    `<div class="table-wrap"><table><thead><tr><th>アンケート</th><th>受付期間</th><th>状態</th><th>回答</th><th>操作</th></tr></thead><tbody>${surveys.map(s => `<tr><td><a href="/admin/edit/${s.id}">${escape(s.title)}</a></td><td>${escape(period(s))}</td><td>${badge(s.availability)}</td><td>${s.responseCount}</td><td><div class="actions"><a href="/admin/results/${s.id}" class="icon-button" aria-label="${escape(s.title)}の集計" title="集計">${icon('chart-no-axes-combined')}</a><a href="/survey/${s.id}" class="icon-button" aria-label="回答画面" title="回答画面">${icon('external-link')}</a><button data-action="copy" data-id="${s.id}" class="icon-button" title="回答URLをコピー" aria-label="回答URLをコピー">${icon('copy')}</button></div></td></tr>`).join('') || '<tr><td colspan="5">アンケートはまだありません。</td></tr>'}</tbody></table></div>
    <section class="settings"><h2>接続・データ管理</h2><div class="connection-list"><span>保存先：${state.settings.storage === 'sheets' ? 'Googleスプレッドシート' : 'ローカル'}</span>${state.settings.providers.map(p => `<span>${escape(p.label)}：${p.configured ? '設定済み' : '未設定'}</span>`).join('')}</div><div class="actions">${state.settings.storage === 'sheets' ? button('initialize', '保存用シートを初期化', 'database') : ''}<a href="/api/admin/backup" class="button" download>${icon('download')}全データJSON</a><label class="button file-button">${icon('upload')}JSONインポート<input id="import-file" type="file" accept="application/json,.json"></label></div></section>`);
  root.querySelectorAll('[data-action="copy"]').forEach(el => el.insertAdjacentHTML('afterend', `<button type="button" data-action="duplicate" data-id="${el.dataset.id}" class="icon-button" title="アンケートを複製" aria-label="アンケートを複製">${icon('copy-plus')}</button>`));
  lucide.createIcons();
  if (storageError) notice(storageError);
}
function editorField(f, index, group) {
  const types = Object.entries(typeNames).filter(([value]) => group === 'questions' || value !== 'aiInterview');
  return `<section class="field-editor" data-group="${group}" data-index="${index}">
    <div class="field-editor-head"><strong>${group === 'attributes' ? '属性' : '設問'} ${index + 1}</strong><div class="actions">${tool(`up-${group}-${index}`, '上へ移動', 'arrow-up')}${tool(`down-${group}-${index}`, '下へ移動', 'arrow-down')}${tool(`remove-${group}-${index}`, '削除', 'trash-2')}</div></div>
    <div class="editor-row"><label class="grow">項目名<input data-field="label" value="${escape(f.label)}" required maxlength="300"></label><label>回答形式<select data-field="type">${types.map(([value, label]) => `<option value="${value}" ${f.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="check"><input data-field="required" type="checkbox" ${f.required ? 'checked' : ''}>必須</label></div>
    ${['single', 'multiple'].includes(f.type) ? `<label>選択肢（1行に1つ）<textarea data-field="options" rows="3">${escape(f.options.join('\n'))}</textarea></label>` : ''}
    ${f.type === 'slider' ? `<div class="editor-row"><label>最小値<input data-field="min" type="number" min="0" max="99" value="${f.min}"></label><label>最大値<input data-field="max" type="number" min="1" max="100" value="${f.max}"></label></div>` : ''}
    ${f.type === 'aiInterview' ? `<label>深掘り回数<input data-field="maxTurns" type="number" min="1" max="10" value="${f.maxTurns ?? 5}" required></label>` : ''}
    ${group === 'questions' && f.type !== 'aiInterview' ? `<label class="check"><input data-followup="enabled" type="checkbox" ${f.followUp ? 'checked' : ''}>理由の自由記述と任意のAI深掘りを追加</label>${f.followUp ? `<div class="editor-row"><label class="check"><input data-followup="required" type="checkbox" ${f.followUp.required ? 'checked' : ''}>理由の入力を必須にする</label><label>深掘り回数<input data-followup="maxTurns" type="number" min="1" max="10" value="${f.followUp.maxTurns}" required></label></div>` : ''}` : ''}
  </section>`;
}
function editor() {
  const s = state.survey;
  const models = state.settings?.providers || [];
  mount(heading(state.editing ? 'アンケートを編集' : 'アンケートを作成', '', '<a href="/admin">一覧へ戻る</a>') + `<form id="editor"><section class="editor-basics"><label>タイトル<input name="title" required maxlength="200" value="${escape(s.title)}"></label><label>説明<textarea name="description" rows="3" maxlength="2000">${escape(s.description)}</textarea></label><div class="editor-row"><label class="grow">URL用ID<input name="id" value="${escape(s.id)}" pattern="[a-z0-9][a-z0-9-]{2,63}" required ${state.editing ? 'readonly' : ''}></label><label>公開状態<select name="status"><option value="draft" ${s.status === 'draft' ? 'selected' : ''}>下書き</option><option value="public" ${s.status === 'public' ? 'selected' : ''}>公開</option><option value="closed" ${s.status === 'closed' ? 'selected' : ''}>終了</option></select></label></div><h2>受付期間</h2><div class="editor-row"><label>受付開始<input type="datetime-local" name="startsAt" value="${toLocal(s.startsAt)}"></label><label>受付終了<input type="datetime-local" name="endsAt" value="${toLocal(s.endsAt)}"></label></div><p class="muted">タイムゾーン：${escape(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p></section>
    <section class="editor-section"><div class="section-heading"><h2>回答者の属性</h2>${button('add-attributes', '属性を追加', 'plus')}</div>${s.attributes.map((f, i) => editorField(f, i, 'attributes')).join('') || '<p class="muted">属性の収集なし</p>'}</section>
    <section class="editor-section"><div class="section-heading"><h2>設問</h2>${button('add-questions', '設問を追加', 'plus')}</div>${s.questions.map((f, i) => editorField(f, i, 'questions')).join('')}</section>
    <section class="editor-section"><h2>AI共通設定</h2><div class="editor-row"><label>プロバイダー<select name="provider"><option value="openai" ${s.interview.provider === 'openai' ? 'selected' : ''}>OpenAI</option><option value="anthropic" ${s.interview.provider === 'anthropic' ? 'selected' : ''}>Claude</option></select></label><label class="grow">モデル<input name="model" value="${escape(s.interview.model)}" placeholder="${escape(models.find(p => p.id === s.interview.provider)?.model || 'サーバーの既定値')}" maxlength="100"></label></div><div class="editor-row"><label class="check"><input name="aiEnabled" type="checkbox" ${s.interview.enabled ? 'checked' : ''}>最後にアンケート全体のAIインタビューも追加する</label><label>末尾インタビューの質問回数<input name="maxTurns" type="number" min="1" max="10" value="${s.interview.maxTurns}"></label></div></section><div class="save-bar"><button type="submit" class="primary">${icon('save')}保存する</button></div></form>`);
  document.querySelector('.editor-basics').insertAdjacentHTML('beforeend', `<label>回答保存先のスプレッドシートID（任意）<input name="spreadsheetId" value="${escape(s.spreadsheetId || '')}" maxlength="200" placeholder="未指定の場合は共通スプレッドシート"></label><p class="muted">${state.settings?.storage === 'sheets' ? '回答はアンケート専用タブに保存します。' : 'ローカル保存中です。この設定はGoogleスプレッドシート利用時に適用されます。'}</p>`);
  document.querySelector('.editor-basics').insertAdjacentHTML('beforeend', `<h2>回答数の上限</h2><div class="editor-row"><label>想定回答数<input name="expectedResponses" type="number" min="1" max="100000" step="1" required value="${s.expectedResponses ?? 100}"></label><label>上限倍率<input name="responseLimitMultiplier" type="number" min="1" max="1.9" step="0.1" required value="${s.responseLimitMultiplier ?? 1.2}"></label><label>受付上限<output id="response-limit"></output></label></div>`);
  const updateLimit = () => { document.querySelector('#response-limit').textContent = `${Math.ceil(Number(document.querySelector('[name="expectedResponses"]').value) * Number(document.querySelector('[name="responseLimitMultiplier"]').value))}件`; };
  for (const name of ['expectedResponses', 'responseLimitMultiplier']) document.querySelector(`[name="${name}"]`).addEventListener('input', updateLimit);
  updateLimit();
}
function captureEditor() {
  const form = document.querySelector('#editor');
  if (!form) return;
  const s = state.survey;
  s.spreadsheetId = form.elements.spreadsheetId.value.trim();
  s.expectedResponses = Number(form.elements.expectedResponses.value);
  s.responseLimitMultiplier = Number(form.elements.responseLimitMultiplier.value);
  for (const name of ['id', 'title', 'description', 'status']) s[name] = form.elements[name].value;
  for (const name of ['startsAt', 'endsAt']) s[name] = fromLocal(form.elements[name].value);
  s.interview = { enabled: form.elements.aiEnabled.checked, provider: form.elements.provider.value, model: form.elements.model.value, maxTurns: Number(form.elements.maxTurns.value) };
  form.querySelectorAll('.field-editor').forEach(el => {
    const f = s[el.dataset.group][Number(el.dataset.index)];
    const follow = el.querySelector('[data-followup="enabled"]');
    if (follow?.checked && el.querySelector('[data-field="type"]').value !== 'aiInterview') f.followUp = { required: Boolean(el.querySelector('[data-followup="required"]')?.checked), maxTurns: Number(el.querySelector('[data-followup="maxTurns"]')?.value || 5) };
    else delete f.followUp;
    el.querySelectorAll('[data-field]').forEach(input => {
      f[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.dataset.field === 'options' ? input.value.split('\n').map(v => v.trim()).filter(Boolean) : ['min', 'max', 'maxTurns'].includes(input.dataset.field) ? Number(input.value) : input.value;
    });
  });
}
function questionInput(f, group, value) {
  if (f.followUp && group === 'answers') {
    const base = questionInput({ ...f, followUp: null }, group, value);
    const locked = state.questionInterviews[f.id] ? 'disabled' : '';
    return `<div class="attached-question"><fieldset ${locked} class="answer-lock">${base}</fieldset>${questionInterviewInput({ ...f, required: f.followUp.required, maxTurns: f.followUp.maxTurns }, 'その回答の理由を教えてください', state.response.reasons?.[f.id] || '', true)}</div>`;
  }
  const name = `${group}:${f.id}`;
  const required = f.required ? 'required' : '';
  const label = `${escape(f.label)}${f.required ? '<span class="required">必須</span>' : ''}`;
  if (f.type === 'aiInterview') return questionInterviewInput(f, label, value);
  if (['single', 'multiple'].includes(f.type)) return `<fieldset class="question"><legend>${label}</legend><div class="choices">${f.options.map((o, i) => `<label class="choice"><input type="${f.type === 'single' ? 'radio' : 'checkbox'}" name="${name}" value="${escape(o)}" ${f.type === 'single' ? required : ''} ${Array.isArray(value) ? value.includes(o) ? 'checked' : '' : value === o ? 'checked' : ''}><span>${escape(o)}</span></label>`).join('')}</div></fieldset>`;
  if (f.type === 'slider') {
    const answered = value !== '' && value != null;
    return `<label class="question">${label}<div class="scale"><span>${f.min}</span><input type="range" name="${name}" min="${f.min}" max="${f.max}" step="1" value="${answered ? value : Math.round((f.min + f.max) / 2)}" data-range data-answered="${answered}"><span>${f.max}</span><output>${answered ? value : '未回答'}</output></div></label>`;
  }
  return `<label class="question">${label}${f.type === 'longText' ? `<textarea name="${name}" rows="3" maxlength="3000" ${required}>${escape(value)}</textarea>` : `<input name="${name}" maxlength="3000" value="${escape(value)}" ${required}>`}</label>`;
}
function questionInterviewInput(field, label, value, attached = false) {
  const session = state.questionInterviews[field.id];
  const showTitle = !attached || state.survey.showInitialReason;
  const count = session?.response.turns.filter(t => t.role === 'assistant').length || 0;
  const action = (name, text, symbol, style = '') => `<button type="button" class="${style}" data-action="qi-${name}" data-id="${field.id}">${icon(symbol)}${text}</button>`;
  return `<section class="question inline-interview" id="qi-${field.id}" aria-labelledby="qi-title-${field.id}">
    <div class="section-heading">${showTitle ? `<h2 id="qi-title-${field.id}">${label}</h2>` : ''}<span ${showTitle ? '' : `id="qi-title-${field.id}"`} class="muted">AIインタビュー${session ? ` · ${session.ready ? '回答済み' : `${count} / ${field.maxTurns}問`}` : ''}</span></div>
    <label ${attached && !state.survey.showInitialReason ? 'hidden' : ''}>${attached ? '理由' : '自由記述の回答'}<textarea name="${attached ? 'reasons' : 'answers'}:${field.id}" rows="3" maxlength="3000" ${session ? 'readonly' : ''}>${escape(value)}</textarea></label>
    ${session ? `<div class="question-transcript">${session.response.turns.filter((t, i) => !(i === 0 && t.role === 'user' && value)).map(t => `<div class="message ${t.role}"><span class="speaker">${t.role === 'assistant' ? 'AI' : 'あなた'}</span><p>${escape(t.content)}</p></div>`).join('')}</div>` : ''}
    ${session?.ready ? `${session.response.summary ? `<div class="summary"><h3>この設問の要約</h3><p>${escape(session.response.summary)}</p></div>` : '<p class="muted">要約なしで会話を残します。</p>'}<div class="actions">${action('reset', 'やり直す', 'rotate-ccw', 'quiet')}</div>` : session ?
      `<label>AIへの回答<textarea id="qi-reply-${field.id}" data-question-reply="${field.id}" rows="3" maxlength="3000">${escape(session.draftReply || '')}</textarea></label><div class="actions">${action('reply', '回答する', 'arrow-up', 'primary')}${action('finish', '終了して要約', 'check')}${action('finishWithoutSummary', '要約せず終了', 'check-check', 'quiet')}${action('reset', 'やり直す', 'rotate-ccw', 'quiet')}</div>` :
      `<div class="actions">${action('start', 'AIインタビューを利用してみる（任意）', 'messages-square')}</div>`}
    <p class="muted">AIインタビューを開始した場合のみ、この設問の回答をAIサービスに送信します。</p><div id="qi-notice-${field.id}" role="status" aria-live="polite"></div>
  </section>`;
}
function renderSurvey() {
  const s = state.survey;
  if (s.availability !== 'open' || Date.now() >= Date.parse(s.endsAt)) {
    mount(heading(s.title, s.description) + `<section class="empty"><h2>${s.availability === 'scheduled' ? '受付開始前です' : '受付は終了しました'}</h2><p>${escape(period(s))}</p></section>`); return;
  }
  mount(heading(s.title, s.description) + `<div class="survey-meta">${badge('open')}<span>匿名回答</span><span>受付終了：${dateLabel(s.endsAt)}</span></div><form id="answer"><div class="answer-layout ${s.attributes.length ? '' : 'without-attributes'}">${s.attributes.length ? `<aside><h2>回答者情報</h2>${s.attributes.map(f => questionInput(f, 'attributes', state.response.attributes[f.id])).join('')}</aside>` : ''}<section>${s.questions.map(f => questionInput(f, 'answers', state.response.answers[f.id])).join('')}</section></div><div class="answer-footer"><p class="muted">氏名や連絡先など、個人を特定できる情報は記入しないでください。</p><div class="actions"><button type="submit" name="mode" value="save" class="${s.interview.enabled ? '' : 'primary'}">${icon('send')}回答を送信</button>${s.interview.enabled ? `<button type="submit" name="mode" value="interview" class="primary">${icon('messages-square')}AIともう少し振り返る</button>` : ''}</div>${s.interview.enabled ? '<p class="muted">AIインタビューは任意です。選ぶと、回答内容が選択されたAIサービスに送信されます。</p>' : ''}</div></form>`);
  if (s.interview.enabled || s.questions.some(q => q.type === 'aiInterview' || q.followUp)) {
    document.querySelector('.survey-meta').insertAdjacentHTML('beforebegin', '<section class="ai-introduction" aria-labelledby="ai-introduction-title"><h2 id="ai-introduction-title">AIインタビュー</h2><p>AIとの対話を通じて回答の理由や背景の言語化をサポートする機能（利用は任意です）</p></section>');
  }
  watchDeadline();
}
function watchDeadline() {
  state.timer = setInterval(() => {
    if (Date.now() >= Date.parse(state.survey.endsAt)) {
      clearInterval(state.timer);
      root.querySelectorAll('button[type="submit"], [data-action^="qi-"], [data-action="finish"], [data-action="save-interview"], [data-action="save-without-summary"]').forEach(el => el.disabled = true);
      notice('受付期間が終了しました。AIの利用・回答送信はできません。入力内容はこの画面に残っています。');
    }
  }, 1000);
}
function collectResponse(form, partial = false) {
  const data = new FormData(form);
  for (const group of ['attributes', 'questions']) for (const f of state.survey[group]) {
    const target = group === 'questions' ? 'answers' : group;
    const key = `${target}:${f.id}`;
    const locked = f.followUp && state.questionInterviews[f.id];
    const value = locked ? state.response[target][f.id] : f.type === 'multiple' ? data.getAll(key) : f.type === 'slider' && form.elements.namedItem(key).dataset.answered !== 'true' ? '' : data.get(key) ?? '';
    if (f.followUp) {
      state.response.reasons ||= {};
      const reason = String(data.get(`reasons:${f.id}`) || '').trim();
      if (!partial && state.survey.showInitialReason && f.followUp.required && !reason && !locked?.ready) throw new Error(`${f.label}の理由を入力するか、AIインタビューに回答してください。`);
      if (!partial && locked && !locked.ready) throw new Error(`${f.label}のAIインタビューを終了してください。`);
      state.response.reasons[f.id] = reason;
    }
    if (!partial && f.type === 'aiInterview') {
      const session = state.questionInterviews[f.id];
      if (session && !session.ready) throw new Error(`${f.label}のAIインタビューを終了してください。`);
      if (f.required && !session?.ready && !String(value).trim()) throw new Error(`${f.label}に回答してください。`);
    } else if (!partial && f.required && (Array.isArray(value) ? !value.length : !String(value).trim())) throw new Error(`${f.label}に回答してください。`);
    state.response[target][f.id] = f.type === 'slider' && value !== '' ? Number(value) : value;
  }
}
async function saveResponse(payload) {
  const questionTokens = Object.fromEntries(Object.entries(state.questionInterviews).map(([id, session]) => [id, session.token]));
  await api(`/api/surveys/${state.survey.id}/responses`, 'POST', { ...payload, questionTokens });
  state.response = null; state.interview = null; state.questionInterviews = {};
  mount(`<section class="thanks">${icon('circle-check')}<h1>ご回答ありがとうございました</h1><p>回答を保存しました。</p><a href="/">アンケート一覧へ</a></section>`);
}
function renderInterview() {
  const interview = state.interview;
  const turns = interview.response.turns;
  const count = turns.filter(t => t.role === 'assistant').length;
  mount(heading(state.survey.title, interview.ready ? '回答内容の確認' : `AIインタビュー · ${count} / ${state.survey.interview.maxTurns}問`) + `<section class="conversation"><div class="transcript">${turns.map(t => `<div class="message ${t.role}"><span class="speaker">${t.role === 'assistant' ? 'AI' : 'あなた'}</span><p>${escape(t.content)}</p></div>`).join('')}</div>${interview.ready ? `<div class="summary"><h2>AIによる要約</h2><p>${escape(interview.response.summary)}</p></div><div class="actions">${button('save-interview', 'この内容で送信', 'send', 'primary')}</div>` : `<form id="reply"><label>あなたの回答<textarea name="reply" rows="3" required maxlength="3000"></textarea></label><div class="actions"><button type="submit" class="primary">${icon('arrow-up')}回答する</button>${button('finish', 'ここで終了して要約', 'check')}</div></form><div class="fallback">${button('save-without-summary', '要約せずに送信', 'send', 'quiet')}</div>`}</section>`);
  watchDeadline();
}
async function results(id) {
  state.settings = await api('/api/admin/settings');
  const data = await api(`/api/admin/surveys/${id}/results`);
  const reasonSections = data.fields.filter(f => f.followUp).map(f => `<section class="result-field"><h2>${escape(f.label)}：理由</h2><ul class="text-results">${f.reasons.map(r => `<li><strong>${escape(Array.isArray(r.answer) ? r.answer.join(' / ') : r.answer)}</strong><p>${escape(r.reason)}</p></li>`).join('') || '<li>理由の回答はまだありません。</li>'}</ul></section>`).join('');
  // Expand each answer into distinct interview entries, keeping legacy interviews visible.
  data.responses = data.responses.flatMap(r => [
    ...(r.turns?.length ? [{ ...r, summary: `全体の振り返り：${r.summary || '要約なし'}` }] : []),
    ...data.survey.questions.filter(q => r.questionInterviews?.[q.id]).map(q => ({
      createdAt: r.createdAt, turns: r.questionInterviews[q.id].turns,
      summary: `${q.label}：${r.questionInterviews[q.id].summary || '要約なし'}`
    }))
  ]);
  mount(heading(data.survey.title, '回答集計', `<a class="button" href="/api/admin/surveys/${id}/export" download>${icon('download')}CSV出力</a><a href="/admin">一覧へ戻る</a>`) + `<div class="result-totals"><div><span>回答数</span><strong>${data.count}</strong></div><div><span>AIインタビュー利用</span><strong>${data.interviewCount}</strong></div></div><div class="results-grid">${data.fields.map((f, i) => `<section class="result-field"><div class="section-heading"><h2>${escape(f.label)}</h2><span class="muted">${f.answered}件${f.average != null ? ` / 平均 ${f.average.toFixed(1)}` : ''}</span></div>${f.rows.length ? `<div class="chart">${f.rows.map(r => `<div class="chart-row"><span>${escape(r.label)}</span><div class="track"><div style="width:${f.answered ? r.count / f.answered * 100 : 0}%;background:var(--chart-${i % 4})"></div></div><span>${r.count}件 / ${f.answered ? Math.round(r.count / f.answered * 100) : 0}%</span></div>`).join('')}</div>${f.type === 'multiple' ? '<p class="muted">割合はこの設問の回答者数を分母としています（複数選択）。</p>' : ''}` : `<ul class="text-results">${f.texts.map(t => `<li>${escape(t)}</li>`).join('') || '<li>回答はまだありません。</li>'}</ul>`}</section>`).join('')}</div><section class="interview-results"><h2>AIインタビュー</h2>${data.responses.filter(r => r.turns?.length).map(r => `<details><summary>${escape(dateLabel(r.createdAt))} · ${escape(r.summary || '要約なし')}</summary>${r.turns.map(t => `<p><strong>${t.role === 'assistant' ? 'AI' : '回答者'}：</strong>${escape(t.content)}</p>`).join('')}</details>`).join('') || '<p class="muted">AIインタビューの回答はまだありません。</p>'}</section>`);
  document.querySelector('.results-grid').insertAdjacentHTML('beforeend', reasonSections);
  if (state.settings.storage === 'sheets') document.querySelector('.page-heading .actions').insertAdjacentHTML('afterbegin', `<button type="button" data-action="sheet-export" data-id="${id}">${icon('table-2')}スプレッドシートに表を出力</button>`);
  document.querySelector('.page-heading .actions').insertAdjacentHTML('afterbegin', `<a class="button" href="/api/admin/surveys/${id}/backup" download>${icon('download')}アンケートJSON出力</a>`);
  lucide.createIcons();
}
async function route() {
  const path = location.pathname;
  if (path.startsWith('/admin')) {
    state.admin = (await api('/api/session')).authenticated;
    if (!state.admin) return login();
    if (path === '/admin/new') { state.settings = await api('/api/admin/settings'); state.editing = false; state.survey = template(); return editor(); }
    const edit = path.match(/^\/admin\/edit\/([^/]+)$/);
    if (edit) { state.settings = await api('/api/admin/settings'); state.editing = true; state.survey = (await api(`/api/admin/surveys/${edit[1]}`)).survey; return editor(); }
    const result = path.match(/^\/admin\/results\/([^/]+)$/);
    if (result) return results(result[1]);
    return admin();
  }
  const answer = path.match(/^\/survey\/([^/]+)\/?$/);
  if (answer) {
    state.survey = (await api(`/api/surveys/${answer[1]}`)).survey;
    state.response = { responseId: crypto.randomUUID(), attributes: {}, answers: {} }; state.interview = null; state.questionInterviews = {};
    return renderSurvey();
  }
  return home();
}
root.addEventListener('input', event => {
  if (event.target.dataset.questionReply) state.questionInterviews[event.target.dataset.questionReply].draftReply = event.target.value;
  if (event.target.matches('[data-range]')) {
    event.target.dataset.answered = 'true';
    event.target.closest('.scale').querySelector('output').textContent = event.target.value;
  }
});
root.addEventListener('change', event => {
  if (event.target.matches('[data-field="type"], [data-followup="enabled"], select[name="provider"]')) { captureEditor(); editor(); }
  if (event.target.id === 'import-file') {
    const file = event.target.files[0];
    if (!file) return;
    run(async () => {
      if (file.size > 2_000_000) throw new Error('インポートは2MBまでです。');
      const result = await api('/api/admin/import', 'POST', JSON.parse(await file.text()));
      await admin(); notice(`アンケート${result.surveyCount}件・回答${result.responseCount}件を取り込みました。新しいアンケートは下書きです。`, true);
    });
  }
});
root.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const formId = form.getAttribute('id');
  const mode = event.submitter?.value;
  // Capture before run() disables controls; disabled form fields are omitted by FormData.
  let data;
  try {
    if (formId === 'answer') collectResponse(form);
    if (formId === 'editor') captureEditor();
    if (formId === 'login' || formId === 'reply') data = Object.fromEntries(new FormData(form));
  } catch (error) { notice(error.message); return; }
  run(async () => {
    if (formId === 'login') { await api('/api/login', 'POST', data); state.admin = true; await route(); }
    if (formId === 'editor') {
      const result = await api(state.editing ? `/api/admin/surveys/${state.survey.id}` : '/api/admin/surveys', state.editing ? 'PUT' : 'POST', state.survey);
      state.survey = result.survey; state.editing = true; history.replaceState(null, '', `/admin/edit/${result.survey.id}`); editor(); notice('保存しました。', true);
    }
    if (formId === 'answer') {
      if (mode === 'interview') { state.interview = await api(`/api/surveys/${state.survey.id}/interview`, 'POST', { ...state.response, action: 'start' }); renderInterview(); }
      else await saveResponse(state.response);
    }
    if (formId === 'reply') { state.interview = await api(`/api/surveys/${state.survey.id}/interview`, 'POST', { token: state.interview.token, action: 'reply', reply: data.reply }); renderInterview(); }
  });
});
root.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control || state.busy) return;
  const action = control.dataset.action;
  if (action.startsWith('qi-')) {
    const id = control.dataset.id, operation = action.slice(3);
    try { collectResponse(document.querySelector('#answer'), true); } catch (error) { notice(error.message); return; }
    const session = state.questionInterviews[id];
    if (operation === 'reset') { delete state.questionInterviews[id]; renderSurvey(); return; }
    const reply = session?.draftReply || '';
    if (operation === 'reply' && !reply.trim()) { notice('AIへの回答を入力してください。'); return; }
    run(async () => {
      const originalLabel = control.innerHTML;
      control.textContent = '処理中…';
      try {
      const payload = operation === 'start' ? { responseId: state.response.responseId, answers: { [id]: state.response.answers[id] }, reasons: { [id]: state.response.reasons?.[id] || '' } } : { token: session.token, reply };
      const result = await api(`/api/surveys/${state.survey.id}/interview`, 'POST', { ...payload, questionId: id, action: operation });
      state.questionInterviews[id] = result;
      const scroll = window.scrollY; renderSurvey(); window.scrollTo(0, scroll);
      } finally { if (control.isConnected) control.innerHTML = originalLabel; }
    }, message => {
      const target = document.getElementById(`qi-notice-${id}`);
      target.className = 'notice error'; target.textContent = message;
    });
    return;
  }
  const pendingReply = document.querySelector('#reply textarea')?.value || '';
  if (action === 'create') { location.href = '/admin/new'; return; }
  if (action.startsWith('add-') || /^(up|down|remove)-/.test(action)) {
    captureEditor();
    const [operation, group, rawIndex] = action.split('-');
    const index = Number(rawIndex), items = state.survey[group];
    if (operation === 'add' && items.length < 30) items.push(field());
    if (operation === 'remove') items.splice(index, 1);
    const other = operation === 'up' ? index - 1 : index + 1;
    if (['up', 'down'].includes(operation) && other >= 0 && other < items.length) [items[index], items[other]] = [items[other], items[index]];
    editor(); return;
  }
  run(async () => {
    if (action === 'sheet-export') {
      const result = await api(`/api/admin/surveys/${control.dataset.id}/sheet-export`, 'POST', {});
      notice(`${result.tab} に${result.count}件を表形式で出力しました。`, true);
    }
    if (action === 'logout') { await api('/api/logout', 'POST', {}); state.admin = false; login(); }
    if (action === 'duplicate') {
      const result = await api(`/api/admin/surveys/${control.dataset.id}/duplicate`, 'POST', {});
      location.href = `/admin/edit/${result.survey.id}`;
    }
    if (action === 'initialize') { await api('/api/admin/storage/initialize', 'POST', {}); await admin(); notice('保存用シートを準備しました。', true); }
    if (action === 'copy') { await navigator.clipboard.writeText(`${location.origin}/survey/${control.dataset.id}`); notice('回答URLをコピーしました。', true); }
    if (action === 'finish') { state.interview = await api(`/api/surveys/${state.survey.id}/interview`, 'POST', { token: state.interview.token, action: 'finish', reply: pendingReply }); renderInterview(); }
    if (action === 'save-interview') await saveResponse({ token: state.interview.token });
    if (action === 'save-without-summary') await saveResponse({ token: state.interview.token, withoutSummary: true, reply: pendingReply });
  });
});
mount('<div class="empty">読み込み中…</div>');
route().catch(error => { mount(heading('ページを表示できませんでした')); notice(error.message); });
