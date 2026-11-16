import {
  loadState, send, applyTheme, esc, levelFor, thresholdsFor, isWatched, accountPeak, projectEta,
  fmtReset, fmtAgo, fmtDateTime, fmtDuration, maskKey, LEVEL_COLORS, saveSettings,
} from './shared.js';

const $ = (s) => document.querySelector(s);
const openDetails = new Set();
let state;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

async function render() {
  state = await loadState();
  const { settings: s, accounts, status, history } = state;
  applyTheme(s.theme);
  const now = Date.now();
  const list = $('#list');

  // Banner: paused / snoozed / best account
  const banner = [];
  if (s.paused) banner.push('⏸ Monitoring is <b style="color:var(--critical)">paused</b>.');
  else if (s.snoozeUntil > now) banner.push(`🔕 Alerts snoozed for ${fmtDuration(s.snoozeUntil - now)}.`);
  const ranked = accounts
    .filter((a) => a.enabled !== false && status[a.id]?.ok)
    .map((a) => ({ a, p: accountPeak(status[a.id], s) }))
    .filter((x) => x.p != null)
    .sort((x, y) => x.p - y.p);
  if (ranked.length > 1) banner.push(`Best account to use now: <b>${esc(ranked[0].a.label)}</b> · ${Math.round(ranked[0].p)}% used`);
  $('#banner').innerHTML = banner.join('<br>');
  $('#pauseToggle').textContent = s.paused ? 'Resume monitoring' : 'Pause monitoring';

  if (!accounts.length) {
    list.innerHTML = `<div class="empty">
      <div style="font-size:30px">📊</div>
      <h3>No accounts yet</h3>
      <p>Add each Claude account once and this popup will track all of them.</p>
      <button class="primary" id="addFirst">Add your first account</button></div>`;
    $('#addFirst').onclick = () => openOptions('accounts');
    $('#footLeft').textContent = '';
    $('#footRight').textContent = '';
    return;
  }

  let ordered = [...accounts];
  if (s.popupSort === 'usage') ordered.sort((a, b) => (accountPeak(status[b.id], s) ?? -1) - (accountPeak(status[a.id], s) ?? -1));
  if (s.popupSort === 'name') ordered.sort((a, b) => a.label.localeCompare(b.label));

  list.classList.toggle('compact', !!s.popupCompact);
  list.innerHTML = ordered.map((a) => card(a, status[a.id], history[a.id], s, now)).join('');

  list.querySelectorAll('[data-refresh]').forEach((b) => (b.onclick = () => refreshOne(b.dataset.refresh, b)));
  list.querySelectorAll('[data-fix]').forEach((b) => (b.onclick = () => openOptions('accounts')));
  list.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copyDetails(b.dataset.copy)));
  list.querySelectorAll('details.det').forEach((d) => (d.ontoggle = () => {
    const id = d.dataset.id;
    if (d.open) { openDetails.add(id); openDetails.delete('_closed_' + id); }
    else { openDetails.delete(id); openDetails.add('_closed_' + id); }
  }));

  const { lastPollAll } = await chrome.storage.local.get('lastPollAll');
  $('#footLeft').textContent = `Updated ${fmtAgo(lastPollAll, now)}`;
  const alarm = await chrome.alarms.get('poll');
  $('#footRight').textContent = s.paused ? 'Paused' : alarm ? `Next check in ${fmtDuration(Math.max(0, alarm.scheduledTime - now))}` : '';
}

function card(a, st, hist, s, now) {
  const { warning, critical } = thresholdsFor(a, s);
  const peak = accountPeak(st, s);
  const lvl = st && !st.ok ? 'error' : peak == null ? 'ok' : levelFor(peak, warning, critical);
  const statusPill = a.enabled === false ? '<span class="pill">Disabled</span>'
    : st?.ok === false ? '<span class="pill error">Error</span>'
    : peak == null ? '<span class="pill">Waiting…</span>'
    : `<span class="pill ${lvl}">${{ ok: 'OK', warning: 'Warning', critical: 'Critical', limit: 'Limit hit' }[lvl]}</span>`;

  const windows = (st?.windows || []).filter((w) => isWatched(w.key, s) || s.watch.other);
  const wins = windows.map((w) => {
    const l = levelFor(w.utilization, warning, critical);
    const eta = s.showProjection ? projectEta(hist, w.key, w.resetsAt, now) : null;
    return `<div class="win">
      <div class="top"><span>${esc(w.label)}</span><span class="pct" style="color:${LEVEL_COLORS[l]}">${Math.round(w.utilization)}%</span></div>
      <div class="bar"><i style="width:${Math.min(100, w.utilization)}%;background:${LEVEL_COLORS[l]}"></i></div>
      <div class="meta"><span>${esc(fmtReset(w.resetsAt, s.timeFormat, now))}</span>${eta != null && l !== 'limit' ? `<span class="proj">· limit in ~${fmtDuration(eta * 60000)} at this pace</span>` : ''}</div>
    </div>`;
  }).join('');

  const open = openDetails.has(a.id) || (s.showDetailsByDefault && !openDetails.has('_closed_' + a.id));
  const expiresIn = a.sessionExpires ? a.sessionExpires - now : null;
  const details = `<details class="det" data-id="${a.id}" ${open ? 'open' : ''}>
    <summary>Session details</summary>
    <dl>
      <dt>Email</dt><dd>${esc(a.email || 'unknown')}</dd>
      <dt>Name</dt><dd>${esc(a.name || '—')}</dd>
      <dt>Organization</dt><dd>${esc(a.orgName || '—')}</dd>
      <dt>Org ID</dt><dd>${esc(a.orgId)}</dd>
      <dt>Plan</dt><dd>${esc(a.plan || '—')}${a.tier ? ` <span class="muted">(${esc(a.tier)})</span>` : ''}</dd>
      <dt>Billing</dt><dd>${esc(a.billing || '—')}</dd>
      <dt>Session key</dt><dd>${esc(maskKey(a.sessionKey))}</dd>
      <dt>Captured from</dt><dd>${esc(a.source || '—')}</dd>
      <dt>Captured on</dt><dd>${esc(fmtDateTime(a.capturedAt, s.timeFormat))}</dd>
      <dt>Session expires</dt><dd>${a.sessionExpires ? `${esc(fmtDateTime(a.sessionExpires, s.timeFormat))} <span class="muted">(${expiresIn > 0 ? 'in ' + fmtDuration(expiresIn) : 'expired'})</span>` : 'unknown'}</dd>
      <dt>Last checked</dt><dd>${esc(fmtAgo(st?.lastChecked, now))}</dd>
      <dt>Last success</dt><dd>${esc(fmtAgo(st?.lastSuccess, now))}</dd>
      <dt>Thresholds</dt><dd>warn ${warning}% · critical ${critical}%${a.notify === false ? ' · alerts off' : ''}</dd>
    </dl>
  </details>`;

  const err = st?.ok === false ? `<div class="err">${esc(st.error)}${st.errorCode === 'SESSION_EXPIRED' ? ' <a href="#" data-fix="1">Fix →</a>' : ''}</div>` : '';
  const stale = st?.ok === false && st.windows?.length ? '<div class="small muted" style="margin-top:4px">Showing last known values.</div>' : '';

  return `<div class="card ${a.enabled === false ? 'disabled' : ''}">
    <div class="row">
      <span class="dot" style="background:${esc(a.color)}"></span>
      <span class="title">${esc(a.label)}</span>
      ${a.plan ? `<span class="pill">${esc(a.plan)}</span>` : ''}
      <span class="spacer"></span>${statusPill}
      <button class="icon ghost" data-refresh="${a.id}" title="Refresh this account">⟳</button>
    </div>
    <div class="sub">${esc(a.email || a.orgName || '')}</div>
    ${err}${wins}${stale}
    ${details}
    <div class="acts"><button data-copy="${a.id}">Copy details</button></div>
  </div>`;
}

async function refreshOne(id, btn) {
  btn.innerHTML = '<span class="spin">⟳</span>';
  try { await send('pollOne', { id }); } catch (e) { toast(e.message); }
  render();
}

async function copyDetails(id) {
  const a = state.accounts.find((x) => x.id === id);
  const st = state.status[id];
  const s = state.settings;
  const lines = [
    `${a.label} — ${a.email || ''} (${a.plan || ''})`,
    `Org: ${a.orgName} [${a.orgId}]`,
    ...(st?.windows || []).map((w) => `${w.label}: ${Math.round(w.utilization)}% — ${fmtReset(w.resetsAt, s.timeFormat)}`),
    `Last checked: ${fmtDateTime(st?.lastChecked, s.timeFormat)}`,
  ];
  await navigator.clipboard.writeText(lines.join('\n'));
  toast('Copied');
}

function openOptions(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash ? '#' + hash : ''}`) });
  window.close();
}

$('#settings').onclick = () => openOptions();
$('#refresh').onclick = async (e) => {
  const b = e.currentTarget;
  b.innerHTML = '<span class="spin">⟳</span>';
  try { await send('pollAll'); } catch (err) { toast(err.message); }
  b.textContent = '⟳';
  render();
};
document.querySelectorAll('[data-snooze]').forEach((b) => (b.onclick = async () => {
  let m = b.dataset.snooze;
  if (m === 'tomorrow') {
    const d = new Date(); d.setHours(8, 0, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    m = Math.ceil((d - Date.now()) / 60000);
  }
  await send('snooze', { minutes: Number(m) });
  $('#menu').open = false;
  toast(Number(m) ? 'Alerts snoozed' : 'Alerts resumed');
}));
$('#pauseToggle').onclick = async () => {
  await saveSettings({ paused: !state.settings.paused });
  $('#menu').open = false;
};

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && render());
setInterval(render, 30000);
render();
