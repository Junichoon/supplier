/**
 * Supplier Worker — full CRUD on top of D1
 *
 * Routes:
 *   GET  /                  -> SPA shell (the original "冠好供應商通訊錄" UI)
 *   GET  /api/categories    -> {counts, sheets}
 *   GET  /api/meta          -> {counts, sheets, sheet_cols, total}
 *   GET  /api/search        -> {counts, returned, rows}  (?sheet=xxx&q=yyy&limit=&offset=)
 *   GET  /api/record/:id    -> row
 *   POST /api/create        -> create (basic auth required)
 *   POST /api/update        -> update (basic auth required)
 *   DELETE /api/delete/:id  -> delete (basic auth required)
 *   POST /api/seed          -> bulk insert (basic auth required, one-time)
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    // Auth gate (write methods)
    const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
    if (isWrite) {
      // /api/seed accepts x-seed-token (or basic auth) for one-time bulk import
      if (path === '/api/seed') {
        const token = request.headers.get('x-seed-token');
        const seedOk = env.SUPPLIER_SEED_TOKEN && token === env.SUPPLIER_SEED_TOKEN;
        if (!seedOk && !checkBasic(request, env)) return unauthorized();
      } else if (!checkBasic(request, env)) {
        return unauthorized();
      }
    }

    try {
      if (path === '/' || path === '/index.html') return htmlResponse(shellHTML());

      if (path === '/api/categories' && method === 'GET') return json(await categories(env));
      if (path === '/api/meta' && method === 'GET') return json(await meta(env));
      if (path === '/api/search' && method === 'GET') return json(await search(url, env));
      if (path.startsWith('/api/record/') && method === 'GET') return json(await record(path, env));
      if (path === '/api/create' && method === 'POST') return json(await create(request, env));
      if (path === '/api/update' && method === 'POST') return json(await update(request, env));
      if (path.startsWith('/api/delete/') && method === 'DELETE') return json(await del(path, env));
      if (path === '/api/seed' && method === 'POST') return json(await seed(request, env));

      return json({ error: 'not_found', message: 'Route not found' }, 404);
    } catch (e) {
      return json({ error: 'server_error', message: String(e && e.message || e) }, 500);
    }
  }
};

function checkBasic(request, env) {
  const h = request.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let user = '', pass = '';
  try { const b = atob(h.slice(6)); const i = b.indexOf(':'); if (i >= 0) { user = b.slice(0, i); pass = b.slice(i + 1); } } catch { return false; }
  return user === env.SUPPLIER_USER && pass === env.SUPPLIER_PASS;
}
function unauthorized() {
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="supplier"', ...corsHeaders() } });
}
function corsHeaders() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,x-seed-token' };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() } });
}
function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...corsHeaders() } });
}

// Build WHERE + params for ?sheet + ?q
function buildFilter(url) {
  const sheet = url.searchParams.get('sheet') || '';
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  const conds = [];
  const binds = [];
  if (sheet) { conds.push('_sheet = ?'); binds.push(sheet); }
  if (q) {
    conds.push(`(
      廠商名稱 LIKE ? OR
      聯絡人 LIKE ? OR
      聯絡電話 LIKE ? OR
      Email LIKE ? OR
      手機 LIKE ? OR
      傳真 LIKE ? OR
      廠商 LIKE ? OR
      廠商代號 LIKE ? OR
      廠商代碼 LIKE ? OR
      產品 LIKE ? OR
      網站 LIKE ? OR
      備註 LIKE ? OR
      職稱 LIKE ? OR
      職務 LIKE ? OR
      計價日 LIKE ? OR
      類別 LIKE ? OR
      分機 LIKE ? OR
      地址 LIKE ?
    )`);
    for (let i = 0; i < 18; i++) binds.push(`%${q}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, binds, limit, offset, sheet, q };
}

async function counts(env) {
  const { results } = await env.DB.prepare(
    `SELECT _sheet, COUNT(*) AS n FROM suppliers GROUP BY _sheet ORDER BY n DESC`
  ).all();
  const map = {};
  let total = 0;
  for (const r of results) { map[r._sheet] = r.n; total += r.n; }
  return { counts: map, total, sheets: Object.keys(map) };
}

async function categories(env) {
  const c = await counts(env);
  return { counts: c.counts, sheets: c.sheets };
}

async function meta(env) {
  const c = await counts(env);
  // columns per sheet (from a sample of 200 rows)
  const sheetCols = {};
  for (const sheet of c.sheets) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM suppliers WHERE _sheet = ? LIMIT 200`
    ).bind(sheet).all();
    const cols = new Set();
    if (results.length) for (const k of Object.keys(results[0])) {
      if (!k.startsWith('_')) cols.add(k);
    }
    sheetCols[sheet] = Array.from(cols);
  }
  return { counts: c.counts, sheets: c.sheets, total: c.total, sheet_cols: sheetCols };
}

async function search(url, env) {
  const f = buildFilter(url);
  const { results } = await env.DB.prepare(
    `SELECT * FROM suppliers ${f.where} ORDER BY _sheet, 廠商名稱, _id LIMIT ? OFFSET ?`
  ).bind(...f.binds, f.limit, f.offset).all();
  const c = await counts(env);
  return { counts: c.counts, returned: results.length, total: c.total, limit: f.limit, offset: f.offset, rows: results };
}

async function record(path, env) {
  const id = parseInt(path.split('/').pop(), 10);
  if (!id) return { error: 'bad_id' };
  const row = await env.DB.prepare(`SELECT * FROM suppliers WHERE _id = ?`).bind(id).first();
  if (!row) return { error: 'not_found' };
  return row;
}

const ALLOWED = ['Email','備註','傳真','分機','廠商代號','廠商名稱','手機','產品','聯絡人','聯絡電話','職稱','網站','計價日','類別','職務','地址','廠商代碼','廠商'];

function pickFields(obj) {
  const out = {};
  for (const k of ALLOWED) if (obj[k] != null && obj[k] !== '') out[k] = obj[k];
  return out;
}

async function create(request, env) {
  const body = await request.json();
  if (!body._sheet) return { error: 'missing_sheet' };
  const f = pickFields(body);
  const cols = Object.keys(f);
  const placeholders = cols.map(() => '?').join(',');
  const vals = cols.map(c => f[c]);
  const sql = `INSERT INTO suppliers (_sheet, ${cols.join(',')}) VALUES (?, ${placeholders})`;
  const res = await env.DB.prepare(sql).bind(body._sheet, ...vals).run();
  return { ok: true, _id: res.meta?.last_row_id || res.lastInsertRowid };
}

async function update(request, env) {
  const body = await request.json();
  if (!body._id) return { error: 'missing_id' };
  const f = pickFields(body);
  const cols = Object.keys(f);
  if (!cols.length) return { error: 'no_fields' };
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const sql = `UPDATE suppliers SET ${sets}, _updated_at = datetime('now') WHERE _id = ?`;
  const vals = cols.map(c => f[c]);
  const res = await env.DB.prepare(sql).bind(...vals, body._id).run();
  return { ok: true, changes: res.meta?.changes || 0 };
}

async function del(path, env) {
  const id = parseInt(path.split('/').pop(), 10);
  if (!id) return { error: 'bad_id' };
  const res = await env.DB.prepare(`DELETE FROM suppliers WHERE _id = ?`).bind(id).run();
  return { ok: true, changes: res.meta?.changes || 0 };
}

async function seed(request, env) {
  const body = await request.json();
  if (!Array.isArray(body.rows) || !body.sheet) return { error: 'bad_payload' };
  const stmt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM suppliers WHERE _sheet = ?`).bind(body.sheet).first();
  if (stmt.n > 0 && !body.force) return { error: 'sheet_has_data', count: stmt.n, hint: 'use force:true to overwrite' };
  if (body.force) await env.DB.prepare(`DELETE FROM suppliers WHERE _sheet = ?`).bind(body.sheet).run();
  let inserted = 0;
  for (const r of body.rows) {
    const f = pickFields(r);
    const cols = Object.keys(f);
    if (!cols.length) continue;
    const placeholders = cols.map(() => '?').join(',');
    const sql = `INSERT INTO suppliers (_sheet, ${cols.join(',')}) VALUES (?, ${placeholders})`;
    await env.DB.prepare(sql).bind(body.sheet, ...cols.map(c => f[c])).run();
    inserted++;
  }
  return { ok: true, sheet: body.sheet, inserted };
}

function shellHTML() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>冠好供應商通訊錄</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#1C1917; --surface:#292524; --surface2:#242120;
  --primary:#F97316; --primary-hover:#EA580C; --primary-glow:rgba(249,115,22,0.15);
  --text:#E7E5E4; --text-dim:#A8A29E; --text-muted:#78716C;
  --border:#3D3834; --border-light:#44403C;
  --danger:#EF4444; --danger-hover:#DC2626; --danger-bg:rgba(239,68,68,0.10);
  --highlight:rgba(249,115,22,0.18);
  --overlay:rgba(0,0,0,0.65);
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Nunito','Noto Sans TC',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);font-size:16px;min-height:100vh;-webkit-font-smoothing:antialiased;}
.header{background:rgba(29,25,23,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 28px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}
.header-brand{display:flex;align-items:center;gap:10px;}
.header-logo{width:32px;height:32px;background:var(--primary);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:#1C1917;}
.header-title{font-size:18px;font-weight:800;color:var(--text);}
.header-sub{font-size:13px;color:var(--text-muted);}
.search-bar{display:flex;gap:6px;align-items:center;}
.search-input{width:280px;padding:8px 16px;border:1.5px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.07);color:#FEF3C7;font-size:15px;font-family:inherit;outline:none;transition:all .2s ease;}
.search-input::placeholder{color:rgba(255,255,255,.35);font-weight:400;}
.search-input:focus{border-color:rgba(249,115,22,.6);background:rgba(255,255,255,.11);box-shadow:0 0 0 4px rgba(249,115,22,.12),0 0 20px rgba(249,115,22,.06);outline:none;}
.btn{padding:7px 14px;border:none;border-radius:6px;font-size:15px;font-family:inherit;cursor:pointer;transition:all .15s;font-weight:700;letter-spacing:.01em;}
.btn-primary{background:var(--primary);color:#1C1917;}
.btn-primary:hover{background:var(--primary-hover);}
.btn-ghost{background:transparent;color:var(--text-dim);border:1.5px solid var(--border-light);}
.btn-ghost:hover{background:var(--surface2);color:var(--text);border-color:var(--primary);}
.tabs{padding:0 28px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;gap:4px;overflow-x:auto;position:sticky;top:56px;z-index:90;}
.tab{padding:14px 18px;font-size:14.5px;font-weight:700;color:var(--text-dim);cursor:pointer;border-bottom:3px solid transparent;transition:all .15s;white-space:nowrap;display:flex;align-items:center;gap:8px;}
.tab:hover{color:var(--text);background:var(--surface2);}
.tab.active{color:var(--primary);border-bottom-color:var(--primary);background:var(--surface2);}
.tab .count{font-size:11.5px;background:rgba(255,255,255,.07);color:var(--text-dim);padding:1.5px 7px;border-radius:10px;font-weight:700;}
.tab.active .count{background:var(--primary);color:#1C1917;}
main{padding:28px;max-width:1280px;margin:0 auto;}
.search-row{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;align-items:center;}
.add-btn{margin-left:auto;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;}
.supplier-card{background:var(--surface);border:1.5px solid var(--border);border-radius:10px;padding:18px 18px 16px;cursor:pointer;transition:all .15s;position:relative;display:flex;flex-direction:column;gap:8px;}
.supplier-card:hover{background:var(--surface2);border-color:var(--border-light);transform:translateY(-1px);}
.supplier-card .name{font-size:17px;font-weight:800;color:var(--text);}
.supplier-card .meta{font-size:12.5px;color:var(--text-muted);font-weight:600;}
.supplier-card .row{display:flex;gap:6px;align-items:center;font-size:13.5px;color:var(--text-dim);}
.supplier-card .row .lbl{color:var(--text-muted);min-width:48px;font-size:12px;font-weight:700;}
.supplier-card .row .val{color:var(--text);font-weight:600;}
.supplier-card .actions{position:absolute;top:10px;right:10px;display:none;gap:4px;}
.supplier-card:hover .actions{display:flex;}
.icon-btn{background:rgba(255,255,255,.05);border:1px solid var(--border-light);color:var(--text-dim);width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;}
.icon-btn:hover{background:var(--primary);color:#1C1917;border-color:var(--primary);}
.empty{text-align:center;padding:60px 20px;color:var(--text-muted);}
.empty .em{font-size:48px;margin-bottom:12px;opacity:.4;}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);color:var(--text);padding:12px 24px;border-radius:8px;border:1px solid var(--primary);font-size:14.5px;font-weight:700;z-index:1000;opacity:0;transition:all .25s;pointer-events:none;box-shadow:0 10px 30px rgba(0,0,0,.4);}
.toast.show{opacity:1;transform:translateX(-50%) translateY(-6px);}
.toast.error{border-color:var(--danger);background:rgba(239,68,68,.15);}
.modal{position:fixed;inset:0;background:var(--overlay);display:none;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);}
.modal.show{display:flex;}
.modal-box{background:var(--surface);border:1px solid var(--border-light);border-radius:12px;width:min(560px,92vw);max-height:88vh;overflow:auto;padding:24px;}
.modal-title{font-size:18px;font-weight:800;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--text);}
.modal-title::before{content:'';width:4px;height:18px;background:var(--primary);border-radius:2px;}
.field{margin-bottom:12px;}
.field label{display:block;font-size:12.5px;color:var(--text-muted);margin-bottom:4px;font-weight:700;}
.field input,.field textarea{width:100%;padding:8px 12px;background:var(--bg);color:var(--text);border:1.5px solid var(--border-light);border-radius:6px;font-family:inherit;font-size:14px;outline:none;transition:border-color .15s;}
.field input:focus,.field textarea:focus{border-color:var(--primary);}
.field textarea{min-height:60px;resize:vertical;}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid var(--border);}
.btn-danger{background:var(--danger);color:#fff;}
.btn-danger:hover{background:var(--danger-hover);}
.danger-confirm{color:var(--text-dim);font-size:13px;margin-right:auto;}
@media(max-width:768px){.header{padding:0 14px;height:auto;min-height:56px;flex-wrap:wrap;gap:8px;}.search-input{width:160px;}.tabs{padding:0 14px;top:56px;}.tab{padding:12px 14px;font-size:13.5px;}main{padding:18px 14px;}.grid{grid-template-columns:1fr;}}
</style>
</head>
<body>
<header class="header">
  <div class="header-brand">
    <div class="header-logo">冠</div>
    <div>
      <div class="header-title">冠好供應商通訊錄</div>
      <div class="header-sub">供應商資料查詢 · 完整 CRUD</div>
    </div>
  </div>
  <div class="search-bar">
    <input id="q" class="search-input" placeholder="🔍 搜尋廠商 / 聯絡人 / 電話...">
    <button class="btn btn-primary" id="addBtn">+ 新增</button>
  </div>
</header>
<nav class="tabs" id="tabs"></nav>
<main>
  <div class="grid" id="grid"></div>
</main>
<div class="toast" id="toast"></div>
<div class="modal" id="modal">
  <div class="modal-box">
    <div class="modal-title" id="modalTitle">新增供應商</div>
    <div id="modalBody"></div>
    <div class="modal-actions">
      <span class="danger-confirm" id="delHint" style="display:none"></span>
      <button class="btn btn-ghost" id="modalCancel">取消</button>
      <button class="btn btn-danger" id="modalDelete" style="display:none">刪除</button>
      <button class="btn btn-primary" id="modalSave">儲存</button>
    </div>
  </div>
</div>
<script>
const FIELDS = ['類別','廠商名稱','廠商代號','聯絡人','職稱','聯絡電話','分機','手機','傳真','Email','網站','產品','計價日','職務','地址','備註'];
let state = { sheet:'', q:'', meta:null, rows:[] };
const $ = id => document.getElementById(id);

function toast(msg, type='') {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (type ? ' '+type : '');
  setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(path, opts={}) {
  const u = new URL(path, location.origin);
  if (state.sheet) u.searchParams.set('sheet', state.sheet);
  if (state.q) u.searchParams.set('q', state.q);
  if (opts.limit) u.searchParams.set('limit', opts.limit);
  const r = await fetch(u, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', ...(opts.headers||{}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { toast('需要登入 (basic auth)', 'error'); throw new Error('auth'); }
  return r.json();
}

async function loadMeta() {
  state.meta = await api('/api/meta');
  renderTabs();
}
function renderTabs() {
  const sheets = state.meta.sheets || [];
  const tabs = $('tabs');
  tabs.innerHTML = '';
  for (const s of sheets) {
    const n = state.meta.counts[s] || 0;
    const div = document.createElement('div');
    div.className = 'tab' + (s === state.sheet ? ' active' : '');
    div.innerHTML = s + ' <span class="count">' + n + '</span>';
    div.onclick = () => { state.sheet = (s === state.sheet ? '' : s); renderTabs(); load(); };
    tabs.appendChild(div);
  }
  const all = document.createElement('div');
  all.className = 'tab' + (state.sheet === '' ? ' active' : '');
  all.innerHTML = '全部 <span class="count">' + (state.meta.total || 0) + '</span>';
  all.onclick = () => { state.sheet = ''; renderTabs(); load(); };
  tabs.insertBefore(all, tabs.firstChild);
}

async function load() {
  const d = await api('/api/search', { limit: 500 });
  state.rows = d.rows;
  render();
}
function render() {
  const g = $('grid');
  if (!state.rows.length) { g.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="em">📭</div>沒有資料</div>'; return; }
  g.innerHTML = state.rows.map(r => \`
    <div class="supplier-card" data-id="\${r._id}">
      <div class="actions">
        <button class="icon-btn" data-act="edit" data-id="\${r._id}">✎</button>
        <button class="icon-btn" data-act="del" data-id="\${r._id}">🗑</button>
      </div>
      <div class="name">\${esc(r['廠商名稱'] || r['廠商'] || r['聯絡人'] || '(未命名)')}</div>
      <div class="meta">\${esc(r._sheet || '')} \${r['類別'] ? ' · ' + esc(r['類別']) : ''}</div>
      \${r['聯絡人'] ? \`<div class="row"><span class="lbl">聯絡人</span><span class="val">\${esc(r['聯絡人'])}\${r['職稱'] ? ' · ' + esc(r['職稱']) : ''}</span></div>\` : ''}
      \${r['聯絡電話'] ? \`<div class="row"><span class="lbl">電話</span><span class="val">\${esc(r['聯絡電話'])}</span></div>\` : ''}
      \${r['Email'] ? \`<div class="row"><span class="lbl">Email</span><span class="val">\${esc(r['Email'])}</span></div>\` : ''}
      \${r['產品'] ? \`<div class="row"><span class="lbl">產品</span><span class="val">\${esc(r['產品'])}</span></div>\` : ''}
    </div>\`).join('');
  g.querySelectorAll('[data-act="edit"]').forEach(b => b.onclick = e => { e.stopPropagation(); openModal(parseInt(b.dataset.id)); });
  g.querySelectorAll('[data-act="del"]').forEach(b => b.onclick = e => { e.stopPropagation(); del(parseInt(b.dataset.id)); });
  g.querySelectorAll('.supplier-card').forEach(c => c.onclick = () => openModal(parseInt(c.dataset.id)));
}
function esc(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

let editing = null;
function openModal(id) {
  const r = id ? state.rows.find(x => x._id === id) : null;
  editing = r;
  $('modalTitle').textContent = id ? '編輯供應商' : '新增供應商';
  $('modalDelete').style.display = id ? '' : 'none';
  $('delHint').style.display = id ? '' : 'none';
  $('delHint').textContent = id ? '將從資料庫刪除' : '';
  const sheets = state.meta.sheets || [];
  const sheetOpts = sheets.map(s => \`<option value="\${esc(s)}" \${r && r._sheet === s ? 'selected' : ''}>\${esc(s)}</option>\`).join('');
  $('modalBody').innerHTML = \`
    <div class="field"><label>分頁 (sheet)</label><select id="f_sheet" style="width:100%;padding:8px;background:var(--bg);color:var(--text);border:1.5px solid var(--border-light);border-radius:6px;font-family:inherit;font-size:14px"><option value="">-- 選 --</option>\${sheetOpts}</select></div>
    \${FIELDS.map(f => \`<div class="field"><label>\${f}</label><input id="f_\${f}" value="\${r && r[f] ? esc(r[f]) : ''}"></div>\`).join('')}
  \`;
  $('modal').classList.add('show');
}
function closeModal() { $('modal').classList.remove('show'); editing = null; }

async function save() {
  const body = { _sheet: $('f_sheet').value };
  for (const f of FIELDS) {
    const v = $('f_'+f).value.trim();
    if (v) body[f] = v;
  }
  if (!body._sheet) { toast('請選 sheet', 'error'); return; }
  if (editing) { body._id = editing._id; await api('/api/update', { method: 'POST', body }); }
  else { await api('/api/create', { method: 'POST', body }); }
  toast(editing ? '已更新' : '已新增');
  closeModal();
  await loadMeta(); await load();
}

async function del(id) {
  if (!confirm('確定刪除 #' + id + '？')) return;
  const r = await fetch(new URL('/api/delete/'+id, location.origin), { method: 'DELETE' });
  if (r.status === 401) { toast('需要登入', 'error'); return; }
  toast('已刪除');
  await loadMeta(); await load();
}

$('q').addEventListener('input', e => { state.q = e.target.value; load(); });
$('addBtn').onclick = () => openModal();
$('modalCancel').onclick = closeModal;
$('modalSave').onclick = save;
$('modalDelete').onclick = async () => { if (!editing) return; await del(editing._id); closeModal(); };

(async () => { await loadMeta(); await load(); })();
</script>
</body>
</html>`;
}
