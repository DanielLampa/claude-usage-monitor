import {
  loadState, send, applyTheme, esc, getPath, setPath, saveSettings, fmtDateTime, fmtAgo, fmtDuration,
  thresholdsFor, levelFor, LEVEL_COLORS, maskKey, DEFAULT_SETTINGS,
} from './shared.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let state;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ───────── tabs ─────────
function showTab() {
  const tab = (location.hash || '#setup').slice(1);
  $$('section').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (!$(`#tab-${tab}`)) { location.hash = '#setup'; }
}
window.addEventListener('hashchange', showTab);
$$('[data-go]').forEach((b) => (b.onclick = () => (location.hash = '#' + b.dataset.go)));

// ───────── settings binding ─────────
function bindSettings() {
  for (const el of $$('[data-setting]')) {
    const path = el.dataset.setting;
    const v = getPath(state.settings, path);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
    el.onchange = async () => {
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number' || el.type === 'range') {
        val = Number(el.value);
        const min = el.min !== '' ? Number(el.min) : -Infinity, max = el.max !== '' ? Number(el.max) : Infinity;
        if (Number.isNaN(val)) val = getPath(DEFAULT_SETTINGS, path);
        val = Math.min(max, Math.max(min, val));
        el.value = val;
      } else val = el.value;
      if (path === 'warningPct' && val >= state.settings.criticalPct) { toast('Warning must be lower than critical'); el.value = state.settings.warningPct; return; }
      if (path === 'criticalPct' && val <= state.settings.warningPct) { toast('Critical must be higher than warning'); el.value = state.settings.criticalPct; return; }
      const patch = setPath({}, path, val);
      state.settings = await saveSettings(patch);
      if (path === 'theme') applyTheme(val);
      toast('Saved');
    };
    if (el.type === 'range') el.oninput = () => ($('#volVal').textContent = `${el.value}%`);
  }
  $('#volVal').textContent = `${state.settings.soundVolume}%`;
  const s = state.settings;
  $('#snoozeInfo').textContent = s.snoozeUntil > Date.now() ? `Alerts snoozed for ${fmtDuration(s.snoozeUntil - Date.now())}` : '';
}

// ───────── accounts list ─────────
function renderAccounts() {
  const { accounts, status, settings: s } = state;
  const box = $('#accountList');
  if (!accounts.length) {
    box.innerHTML = '<div class="panel muted">No accounts yet. Use one of the two methods above.</div>';
    return;
  }
  box.innerHTML = accounts.map((a, i) => {
    const st = status[a.id];
    const t = thresholdsFor(a, s);
    const mini = (st?.windows || []).map((w) => {
      const l = levelFor(w.utilization, t.warning, t.critical);
      return `<div><div>${esc(w.label)} · <b style="color:${LEVEL_COLORS[l]}">${Math.round(w.utilization)}%</b></div><div class="bar"><i style="width:${Math.min(100, w.utilization)}%;background:${LEVEL_COLORS[l]}"></i></div></div>`;
    }).join('');
    const orgSel = (a.orgs || []).length > 1
      ? `<label>Organization <select data-org="${a.id}">${a.orgs.map((o) => `<option value="${esc(o.uuid)}" ${o.uuid === a.orgId ? 'selected' : ''}>${esc(o.name)} (${esc(o.plan)})</option>`).join('')}</select></label>` : '';
    const exp = a.sessionExpires ? (a.sessionExpires > Date.now() ? `expires in ${fmtDuration(a.sessionExpires - Date.now())}` : 'expired') : 'expiry unknown';
    return `<div class="acct" data-id="${a.id}">
      <div class="head">
        <input type="color" value="${esc(a.color)}" data-color="${a.id}" title="Account color">
        <input type="text" value="${esc(a.label)}" data-label="${a.id}" title="Display name">
        <span class="pill">${esc(a.plan || '?')}</span>
        <span class="muted small">${esc(a.email || 'email unknown')}</span>
        <span class="spacer"></span>
        <button class="icon" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="icon" data-down="${i}" ${i === accounts.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button data-check="${a.id}">⟳ Check</button>
        <button class="danger" data-remove="${a.id}">Remove</button>
      </div>
      <div class="grid">
        <label><span class="switch"><input type="checkbox" data-enabled="${a.id}" ${a.enabled !== false ? 'checked' : ''}><span></span></span> Monitor this account</label>
        <label><span class="switch"><input type="checkbox" data-notify="${a.id}" ${a.notify !== false ? 'checked' : ''}><span></span></span> Send alerts</label>
        <label>Warning <input type="number" min="1" max="100" placeholder="${s.warningPct}" value="${a.thresholds?.warning ?? ''}" data-warn="${a.id}"> %</label>
        <label>Critical <input type="number" min="1" max="100" placeholder="${s.criticalPct}" value="${a.thresholds?.critical ?? ''}" data-crit="${a.id}"> %</label>
        ${orgSel}
      </div>
      <div class="mini">${mini}</div>
      <div class="meta">Org: ${esc(a.orgName || '—')} · Key ${esc(maskKey(a.sessionKey))} · from ${esc(a.source || '—')} · captured ${esc(fmtDateTime(a.capturedAt, s.timeFormat))} · ${esc(exp)} · last check ${esc(fmtAgo(st?.lastChecked))}</div>
      ${st?.ok === false ? `<div class="err">⚠ ${esc(st.error)}${st.errorCode === 'SESSION_EXPIRED' ? ' — sign in to this account again (incognito), then use <b>Detect</b> → <b>Update session</b>, or paste a fresh key.' : ''}</div>` : ''}
    </div>`;
  }).join('');

  const upd = (id, patch) => send('updateAccount', { id, patch }).then(() => toast('Saved')).catch((e) => toast(e.message));
  $$('[data-label]').forEach((el) => (el.onchange = () => upd(el.dataset.label, { label: el.value.trim() || 'Account' })));
  $$('[data-color]').forEach((el) => (el.onchange = () => upd(el.dataset.color, { color: el.value })));
  $$('[data-enabled]').forEach((el) => (el.onchange = () => upd(el.dataset.enabled, { enabled: el.checked })));
  $$('[data-notify]').forEach((el) => (el.onchange = () => upd(el.dataset.notify, { notify: el.checked })));
  const thr = (el, key) => {
    const v = el.value === '' ? null : Math.min(100, Math.max(1, Number(el.value)));
    upd(el.dataset[key === 'warning' ? 'warn' : 'crit'], { thresholds: { [key]: v } });
  };
  $$('[data-warn]').forEach((el) => (el.onchange = () => thr(el, 'warning')));
  $$('[data-crit]').forEach((el) => (el.onchange = () => thr(el, 'critical')));
  $$('[data-org]').forEach((el) => (el.onchange = () => upd(el.dataset.org, { orgId: el.value })));
  $$('[data-check]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Checking…';
    try { await send('pollOne', { id: b.dataset.check }); toast('Checked'); } catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = '⟳ Check';
  }));
  $$('[data-remove]').forEach((b) => (b.onclick = async () => {
    const a = state.accounts.find((x) => x.id === b.dataset.remove);
    if (!confirm(`Remove "${a.label}" from the monitor? (This does not sign you out of Claude.)`)) return;
    await send('removeAccount', { id: a.id });
    toast('Removed');
  }));
  const move = (i, d) => {
    const ids = state.accounts.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    send('reorderAccounts', { ids });
  };
  $$('[data-up]').forEach((b) => (b.onclick = () => move(Number(b.dataset.up), -1)));
  $$('[data-down]').forEach((b) => (b.onclick = () => move(Number(b.dataset.down), 1)));
}

// ───────── add: detect ─────────
function foundCard(item, idx, kind) {
  const orgSel = (item.orgs || []).length > 1
    ? `<select data-${kind}-org="${idx}">${item.orgs.map((o) => `<option value="${esc(o.uuid)}" ${o.uuid === item.orgId ? 'selected' : ''}>${esc(o.name)} (${esc(o.plan)})</option>`).join('')}</select>` : '';
  const org = (item.orgs || []).find((o) => o.uuid === item.orgId);
  if (item.error) {
    return `<div class="found"><b>${esc(item.source || 'Session')}</b> <span class="muted small">${esc(item.preview)}</span><div class="err" style="color:var(--limit)">⚠ ${esc(item.error)}</div></div>`;
  }
  const btn = item.existingId
    ? (item.sameKey ? '<span class="pill ok">Already added</span>' : `<button class="primary" data-${kind}-add="${idx}">Update session for “${esc(item.existingLabel)}”</button>`)
    : `<button class="primary" data-${kind}-add="${idx}">Add</button>`;
  return `<div class="found">
    <div><b>${esc(item.email || item.name || 'Unknown account')}</b> ${org ? `<span class="pill">${esc(org.plan)}</span>` : ''}</div>
    <div class="small muted">${esc(item.source || 'Pasted key')} · ${esc(item.preview)}${item.expires ? ` · expires ${esc(fmtDateTime(item.expires, state.settings.timeFormat))}` : ''}</div>
    <div class="row" style="margin-top:8px">
      ${item.sameKey ? '' : `<input type="text" placeholder="Label (e.g. Work)" data-${kind}-label="${idx}" value="${esc(item.existingLabel || '')}">`}
      ${orgSel}${btn}
    </div></div>`;
}

let detected = [];
$('#detect').onclick = async () => {
  const b = $('#detect'), out = $('#detectOut');
  b.disabled = true; b.textContent = 'Detecting…';
  try {
    const r = await send('detectSessions');
    detected = r.items;
    let html = detected.map((it, i) => foundCard(it, i, 'det')).join('');
    if (!detected.length) html = '<p class="muted small">No signed-in Claude session found. Sign in at claude.ai (normal or incognito window) and try again.</p>';
    if (!r.incognitoAllowed) html += '<p class="small warn">Incognito access is off, so incognito sessions can\'t be seen. Enable “Allow in Incognito” for this extension in chrome://extensions.</p>';
    out.innerHTML = html;
    wireAdd('det', detected);
  } catch (e) { out.innerHTML = `<p class="err" style="color:var(--limit)">${esc(e.message)}</p>`; }
  b.disabled = false; b.textContent = 'Detect signed-in sessions';
};

let pasted = [];
$('#verifyKey').onclick = async () => {
  const b = $('#verifyKey'), out = $('#pasteOut');
  b.disabled = true; b.textContent = 'Verifying…';
  try {
    const r = await send('identify', { input: $('#pasteKey').value });
    const ex = state.accounts.find((a) => a.sessionKey === r.sessionKey) || state.accounts.find((a) => r.email && a.email === r.email);
    pasted = [{ ...r, source: 'Pasted session key', existingId: ex?.id || null, existingLabel: ex?.label || null, sameKey: ex?.sessionKey === r.sessionKey }];
    out.innerHTML = foundCard(pasted[0], 0, 'pst');
    wireAdd('pst', pasted);
  } catch (e) { out.innerHTML = `<p style="color:var(--limit)" class="small">⚠ ${esc(e.message)}</p>`; }
  b.disabled = false; b.textContent = 'Verify';
};

function wireAdd(kind, items) {
  $$(`[data-${kind}-add]`).forEach((btn) => (btn.onclick = async () => {
    const i = Number(btn.dataset[`${kind}Add`]);
    const it = items[i];
    const label = $(`[data-${kind}-label="${i}"]`)?.value.trim();
    const orgId = $(`[data-${kind}-org="${i}"]`)?.value || it.orgId;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await send('addAccount', { account: {
        sessionKey: it.sessionKey, label, orgId, source: it.source, expires: it.expires || null, existingId: it.existingId,
        identity: { orgs: it.orgs, orgId: it.orgId, email: it.email, name: it.name, accountUuid: it.accountUuid },
      } });
      btn.outerHTML = `<span class="pill ok">${r.updated ? 'Session updated ✓' : 'Added ✓'}</span>`;
      if (kind === 'pst') $('#pasteKey').value = '';
      toast(r.updated ? 'Session updated' : 'Account added');
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Retry'; }
  }));
}

// ───────── misc buttons ─────────
const testAlert = async () => { try { await send('testNotification'); toast('Test alert sent — check your notifications'); } catch (e) { toast(e.message); } };
$('#testNotif').onclick = testAlert;
$('#setupTest').onclick = testAlert;
$('#testSound').onclick = () => send('testSound', { tone: $('[data-setting="soundTone"]').value, volume: Number($('[data-setting="soundVolume"]').value) });
$('#refreshAll').onclick = async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
  try { await send('pollAll'); toast('All accounts checked'); } catch (err) { toast(err.message); }
  b.disabled = false; b.textContent = '⟳ Check all now';
};
$('#clearHistory').onclick = async () => { await send('clearHistory'); toast('History cleared'); };
$('#resetAlerts').onclick = async () => { await send('resetAlerts'); toast('Alert state reset — alerts can fire again'); };
$('#showLog').onclick = async () => {
  const log = await send('getLog');
  const pre = $('#logOut');
  pre.hidden = false;
  pre.textContent = log.length ? log.slice().reverse().map((l) => `[${new Date(l.t).toLocaleString()}] ${l.level.toUpperCase()} ${l.msg}${l.extra ? '\n   ' + l.extra : ''}`).join('\n') : 'Log is empty. Turn on debug logging to record every check (errors are always recorded).';
};
$('#clearLog').onclick = async () => { await send('clearLog'); $('#logOut').textContent = ''; toast('Log cleared'); };
$('#resetAll').onclick = async () => {
  if (!confirm('Remove every account and restore default settings?')) return;
  await send('resetAll');
  toast('Everything reset');
};
$('#exportBtn').onclick = async () => {
  const st = await loadState();
  const withKeys = $('#exportKeys').checked;
  const data = {
    app: 'claude-usage-monitor', version: 1, exportedAt: new Date().toISOString(),
    settings: { ...st.settings, snoozeUntil: 0 },
    accounts: st.accounts.map((a) => (withKeys ? a : { ...a, sessionKey: undefined })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `claude-usage-monitor-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await send('importData', { data });
    toast(`Imported · ${r.accounts} account(s)`);
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
};

async function incogStatus() {
  const ok = await chrome.extension.isAllowedIncognitoAccess();
  $('#incogStatus').innerHTML = ok ? '✅ <b>Incognito access is on.</b>' : '❌ <b>Incognito access is off.</b> Turn it on to capture extra accounts.';
}

// ───────── boot ─────────
async function refresh() {
  state = await loadState();
  applyTheme(state.settings.theme);
  bindSettings();
  renderAccounts();
}
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  // Avoid clobbering an input the user is typing in.
  const active = document.activeElement;
  if (active && active.closest('.acct') && (c.accounts && !c.status)) return;
  refresh();
});
showTab();
incogStatus();
refresh();
