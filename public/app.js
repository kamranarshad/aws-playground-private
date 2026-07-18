/* global CodeMirror */
'use strict';

const api = {
  async health() { return (await fetch('/api/health')).json(); },
  async list() { return (await fetch('/api/functions')).json(); },
  async create(body) {
    const r = await fetch('/api/functions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error);
    return r.json();
  },
  async update(id, patch) {
    const r = await fetch(`/api/functions/${id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    return r.json();
  },
  async remove(id) { await fetch(`/api/functions/${id}`, { method: 'DELETE' }); },
  async detect(dir) {
    const r = await fetch('/api/detect', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) });
    return r.json();
  },
  async invoke(body) {
    const r = await fetch('/api/invoke', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error);
    return r.json();
  },
};

const EVENT_TEMPLATES = {
  'Empty': {},
  'API Gateway proxy': {
    resource: '/{proxy+}', path: '/hello', httpMethod: 'GET',
    headers: { Accept: '*/*' }, queryStringParameters: { name: 'world' },
    pathParameters: { proxy: 'hello' }, body: null, isBase64Encoded: false,
  },
  'S3 put': { Records: [{ eventVersion: '2.1', eventSource: 'aws:s3',
    awsRegion: 'us-east-1', eventName: 'ObjectCreated:Put',
    s3: { bucket: { name: 'example-bucket', arn: 'arn:aws:s3:::example-bucket' },
      object: { key: 'test/key.txt', size: 1024 } } }] },
  'SQS message': { Records: [{ messageId: '19dd0b57-b21e-4ac1-bd88-01bbb068cb78',
    receiptHandle: 'MessageReceiptHandle', body: 'Hello from SQS!',
    attributes: { ApproximateReceiveCount: '1' }, eventSource: 'aws:sqs',
    awsRegion: 'us-east-1' }] },
  'EventBridge': { version: '0', id: 'fdd6cb98-d2e2-4ecf-a6f6-1d8b0f4e327a',
    'detail-type': 'Scheduled Event', source: 'aws.events',
    time: '2026-01-01T00:00:00Z', region: 'us-east-1', detail: {} },
  'DynamoDB stream': { Records: [{ eventID: '1', eventName: 'INSERT',
    eventSource: 'aws:dynamodb', awsRegion: 'us-east-1',
    dynamodb: { Keys: { Id: { N: '101' } },
      NewImage: { Id: { N: '101' }, Message: { S: 'hello' } },
      StreamViewType: 'NEW_AND_OLD_IMAGES' } }] },
};

const state = { functions: [], selectedId: null, history: [], health: null };
const $ = (id) => document.getElementById(id);
let editor;

function selected() { return state.functions.find(f => f.id === state.selectedId) || null; }

async function refresh() {
  state.functions = (await api.list()).functions;
  if (!selected()) state.selectedId = state.functions[0]?.id || null;
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const ul = $('fn-list');
  ul.innerHTML = '';
  for (const fn of state.functions) {
    const li = document.createElement('li');
    if (fn.id === state.selectedId) li.className = 'active';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = fn.runtime;
    li.appendChild(badge);
    li.appendChild(document.createTextNode(fn.name));
    if (state.health && state.health[fn.runtime] && !state.health[fn.runtime].available) {
      const warn = document.createElement('span');
      warn.textContent = '⚠';
      warn.title = `${fn.runtime} runtime not found on this machine`;
      li.appendChild(warn);
    }
    li.onclick = () => {
      state.selectedId = fn.id;
      state.history = [];
      renderSidebar();
      renderMain();
    };
    ul.appendChild(li);
  }
}

function renderMain() {
  const fn = selected();
  $('empty-state').classList.toggle('hidden', !!fn);
  $('fn-view').classList.toggle('hidden', !fn);
  if (!fn) return;
  $('runtime-badge').textContent = fn.runtime;
  $('cfg-handler').value = fn.handler;
  $('cfg-timeout').value = fn.timeoutMs;
  $('cfg-memory').value = fn.memoryMb;
  $('cfg-jar').value = fn.jarPath || '';
  $('cfg-jar-label').classList.toggle('hidden', fn.runtime !== 'java');
  renderEnvRows(fn.env);
  renderSavedSelect();
  renderHistory();
}

function envRow(k, v) {
  const row = document.createElement('div');
  row.className = 'env-row';
  const key = document.createElement('input');
  key.className = 'env-k'; key.placeholder = 'KEY'; key.value = k;
  const val = document.createElement('input');
  val.className = 'env-v'; val.placeholder = 'value'; val.value = v;
  const del = document.createElement('button');
  del.className = 'ghost env-del'; del.type = 'button'; del.textContent = '✕';
  del.onclick = () => { row.remove(); saveEnv(); };
  key.onchange = saveEnv; val.onchange = saveEnv;
  row.append(key, val, del);
  return row;
}

function renderEnvRows(env) {
  const box = $('env-rows');
  box.innerHTML = '';
  for (const [k, v] of Object.entries(env || {})) box.appendChild(envRow(k, v));
}

function collectEnv() {
  const env = {};
  for (const row of document.querySelectorAll('#env-rows .env-row')) {
    const k = row.querySelector('.env-k').value.trim();
    if (k) env[k] = row.querySelector('.env-v').value;
  }
  return env;
}

async function saveEnv() {
  const fn = selected();
  if (!fn) return;
  fn.env = collectEnv();
  await api.update(fn.id, { env: fn.env });
}

function renderSavedSelect() {
  const fn = selected();
  const sel = $('saved-select');
  sel.innerHTML = '<option value="">Saved events&hellip;</option>';
  for (const ev of fn?.savedEvents || []) {
    const opt = document.createElement('option');
    opt.value = ev.name;
    opt.textContent = ev.name;
    sel.appendChild(opt);
  }
}

function renderHistory() {
  const ul = $('history');
  ul.innerHTML = '';
  for (const h of state.history) {
    const li = document.createElement('li');
    const status = document.createElement('span');
    status.className = h.result.ok ? 'h-ok' : 'h-err';
    status.textContent = h.result.ok ? 'OK' : (h.result.error?.type || 'Error');
    const time = document.createElement('span');
    time.textContent = h.at;
    const dur = document.createElement('span');
    dur.textContent = h.result.report ? `${h.result.report.durationMs} ms` : '';
    li.append(time, status, dur);
    li.onclick = () => showResult(h.result);
    ul.appendChild(li);
  }
}

function setTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.tab === name);
  }
  for (const p of ['response', 'logs', 'report']) {
    $(`pane-${p}`).classList.toggle('hidden', p !== name);
  }
}

function showResult(r) {
  const resp = $('pane-response');
  if (r.ok) {
    resp.className = 'pane ok';
    resp.textContent = JSON.stringify(r.response, null, 2);
  } else {
    resp.className = 'pane err';
    const initNote = r.phase === 'init'
      ? '— function failed before the handler ran (init phase)\n\n' : '';
    resp.textContent = initNote + JSON.stringify({
      errorType: r.error.type,
      errorMessage: r.error.message,
      stackTrace: r.error.stackTrace,
    }, null, 2);
  }
  $('pane-logs').textContent = r.logs || '(no log output)';
  $('pane-report').textContent = r.report ? [
    `REPORT RequestId: ${r.report.requestId}`,
    `Duration: ${r.report.durationMs} ms`,
    `Billed Duration: ${r.report.billedMs} ms`,
    `Memory Size: ${r.report.memoryMb} MB`,
    `Status: ${r.report.timedOut ? 'Timeout' : r.ok ? 'OK' : 'Error'}`,
  ].join('\t') : '(no report)';
  setTab('response');
}

async function doInvoke() {
  const fn = selected();
  if (!fn) return;
  let event;
  try {
    event = JSON.parse(editor.getValue());
  } catch (e) {
    showResult({ ok: false, phase: 'invoke', logs: '', report: null,
      error: { type: 'InvalidEventJson', message: e.message, stackTrace: [] } });
    return;
  }
  const btn = $('invoke-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const result = await api.invoke({
      functionId: fn.id,
      handler: $('cfg-handler').value,
      event,
      envVars: collectEnv(),
      timeoutMs: parseInt($('cfg-timeout').value, 10) || 30000,
      memoryMb: parseInt($('cfg-memory').value, 10) || 128,
    });
    state.history.unshift({ at: new Date().toLocaleTimeString(), result });
    renderHistory();
    showResult(result);
  } catch (e) {
    showResult({ ok: false, phase: 'invoke', logs: '', report: null,
      error: { type: 'RequestFailed', message: e.message, stackTrace: [] } });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Invoke ▶';
  }
}

async function renderHealth() {
  const { runtimes } = await api.health();
  state.health = runtimes;
  renderSidebar();
  const strip = $('health-strip');
  strip.innerHTML = '';
  for (const [name, info] of Object.entries(runtimes)) {
    const chip = document.createElement('span');
    chip.className = `chip ${info.available ? 'ok' : 'missing'}`;
    chip.textContent = info.available ? `${name} ${info.version}` : `${name} ✕`;
    chip.title = info.available ? '' : `${name} runtime not found on this machine`;
    strip.appendChild(chip);
  }
}

function bindConfig() {
  const save = async (patch) => {
    const fn = selected();
    if (fn) Object.assign(fn, await api.update(fn.id, patch));
  };
  $('cfg-handler').onchange = () => save({ handler: $('cfg-handler').value });
  $('cfg-timeout').onchange = () => save({ timeoutMs: parseInt($('cfg-timeout').value, 10) || 30000 });
  $('cfg-memory').onchange = () => save({ memoryMb: parseInt($('cfg-memory').value, 10) || 128 });
  $('cfg-jar').onchange = () => save({ jarPath: $('cfg-jar').value || null });
  $('delete-btn').onclick = async () => {
    const fn = selected();
    if (fn && confirm(`Remove '${fn.name}' from the playground? (Your code is untouched.)`)) {
      await api.remove(fn.id);
      state.selectedId = null;
      refresh();
    }
  };
}

function bindAddForm() {
  $('add-btn').onclick = () => $('add-form').classList.toggle('hidden');
  $('add-cancel').onclick = () => $('add-form').classList.add('hidden');
  $('add-path').onblur = async () => {
    const dir = $('add-path').value.trim();
    if (!dir) return;
    const d = await api.detect(dir);
    $('add-error').textContent = d.error ? `Not a directory: ${dir}` : '';
    if (d.error) return;
    if (d.runtime) $('add-runtime').value = d.runtime;
    if (!$('add-name').value) $('add-name').value = dir.split('/').filter(Boolean).pop();
    const box = $('add-suggestions');
    box.innerHTML = '';
    for (const cand of d.handlerCandidates.slice(0, 6)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = cand;
      b.onclick = () => { $('add-handler').value = cand; };
      box.appendChild(b);
    }
    if (d.handlerCandidates.length === 1) $('add-handler').value = d.handlerCandidates[0];
  };
  $('add-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const fn = await api.create({
        name: $('add-name').value.trim(),
        path: $('add-path').value.trim(),
        runtime: $('add-runtime').value,
        handler: $('add-handler').value.trim(),
      });
      $('add-form').classList.add('hidden');
      $('add-form').reset();
      $('add-suggestions').innerHTML = '';
      state.selectedId = fn.id;
      refresh();
    } catch (err) {
      $('add-error').textContent = err.message;
    }
  };
}

function bindEvents() {
  const tpl = $('tpl-select');
  for (const name of Object.keys(EVENT_TEMPLATES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    tpl.appendChild(opt);
  }
  tpl.onchange = () => {
    const t = EVENT_TEMPLATES[tpl.value];
    if (t) editor.setValue(JSON.stringify(t, null, 2));
  };
  $('saved-select').onchange = () => {
    const fn = selected();
    const ev = fn?.savedEvents.find(x => x.name === $('saved-select').value);
    if (ev) editor.setValue(ev.json);
  };
  $('save-event').onclick = async () => {
    const fn = selected();
    if (!fn) return;
    const name = prompt('Save event as:');
    if (!name) return;
    const events = fn.savedEvents.filter(x => x.name !== name);
    events.push({ name, json: editor.getValue() });
    Object.assign(fn, await api.update(fn.id, { savedEvents: events }));
    renderSavedSelect();
  };
  $('env-add').onclick = () => $('env-rows').appendChild(envRow('', ''));
  $('invoke-btn').onclick = doInvoke;
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => setTab(t.dataset.tab);
  }
}

function init() {
  editor = CodeMirror.fromTextArea($('event-editor'), {
    mode: { name: 'javascript', json: true },
    theme: 'material-darker',
    lineNumbers: true,
  });
  bindConfig();
  bindAddForm();
  bindEvents();
  renderHealth();
  refresh();
}

init();
