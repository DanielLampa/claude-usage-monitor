// Claude Usage Monitor — background service worker (Manifest V3)
import {
  DEFAULT_SETTINGS, LEVELS, LEVEL_COLORS, loadState, mergeDeep, parseUsage, levelFor, thresholdsFor,
  isWatched, windowLabel, projectEta, inQuietHours, accountPeak, fmtDuration, fmtReset,
  extractSessionKey, maskKey, ACCOUNT_COLORS,
} from './shared.js';

const ORIGIN = 'https://claude.ai';
const API = ORIGIN + '/api';
const TAG = '__cum';
const CF_COOKIE = /^(cf_|__cf|_cfuvid)/i;

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── lifecycle ─────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await clearSessionRules();
  const d = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: mergeDeep(structuredClone(DEFAULT_SETTINGS), d.settings || {}) });
  await schedule();
  await updateBadge();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await clearSessionRules();
  await schedule();
  const { settings } = await loadState();
  if (settings.refreshOnStartup && !settings.paused) pollAll('startup');
  else updateBadge();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'poll') pollAll('alarm');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
    if (o.pollIntervalMin !== n.pollIntervalMin || o.paused !== n.paused) schedule();
  }
  if (changes.settings || changes.accounts) updateBadge();
});

async function schedule() {
  const { settings } = await loadState();
  await chrome.alarms.clear('poll');
  if (settings.paused) return;
  const period = Math.min(120, Math.max(1, Number(settings.pollIntervalMin) || 5));
  await chrome.alarms.create('poll', { periodInMinutes: period, delayInMinutes: 0.5 });
}

// ───────────────────────── logging ─────────────────────────
async function log(level, msg, extra) {
  const { settings } = await loadState();
  if (!settings.debugLog && level !== 'error') return;
  const { log: arr = [] } = await chrome.storage.local.get('log');
  arr.push({ t: Date.now(), level, msg, extra: extra ? JSON.stringify(extra).slice(0, 2000) : undefined });
  await chrome.storage.local.set({ log: arr.slice(-300) });
}

// ───────────────────────── requests ─────────────────────────
let ruleSeq = Math.floor(Math.random() * 1e6) + 1;

async function clearSessionRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
}

async function cookieHeaderFor(sessionKey, orgId) {
  const parts = [`sessionKey=${sessionKey}`];
  if (orgId) parts.push(`lastActiveOrg=${orgId}`);
  try {
    // Re-use the browser's current Cloudflare cookies so requests look like normal claude.ai traffic.
    const cs = await chrome.cookies.getAll({ url: ORIGIN + '/' });
    for (const c of cs) if (CF_COOKIE.test(c.name)) parts.push(`${c.name}=${c.value}`);
  } catch {}
  return parts.join('; ');
}

async function directFetch(url) {
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' } });
  return { status: r.status, text: await r.text(), via: 'direct' };
}

async function tabFetch(url) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) return null;
  const tab = tabs.find((t) => !t.discarded) || tabs[0];
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (u) => {
      try {
        const r = await fetch(u, { credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' } });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: String(e) };
      }
    },
    args: [url],
  });
  return res?.result ? { ...res.result, via: 'tab' } : null;
}

const looksBlocked = (r) => !r || r.status === 0 || ((r.status === 403 || r.status === 503) && /<html|cloudflare|cf-chl|just a moment/i.test(r.text || ''));

async function apiGet(path, sessionKey, orgId, mode = 'auto') {
  const tag = crypto.randomUUID().replace(/-/g, '');
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}${TAG}=${tag}`;
  ruleSeq = (ruleSeq % 2000000000) + 1;
  const id = ruleSeq;
  const cookie = await cookieHeaderFor(sessionKey, orgId);

  // A one-off rule injects this account's cookie only into this single request.
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'cookie', operation: 'set', value: cookie },
          { header: 'origin', operation: 'set', value: ORIGIN },
          { header: 'referer', operation: 'set', value: ORIGIN + '/' },
        ],
      },
      condition: { urlFilter: `${TAG}=${tag}`, resourceTypes: ['xmlhttprequest', 'other'] },
    }],
  });

  try {
    let r = null, err = null;
    if (mode !== 'tab') {
      try { r = await directFetch(url); } catch (e) { err = e; }
    }
    if (mode === 'tab' || (mode === 'auto' && looksBlocked(r))) {
      try {
        const t = await tabFetch(url);
        if (t) r = t;
        else if (mode === 'tab') throw new ApiError('NO_TAB', 'Request mode is "Through claude.ai tab" but no claude.ai tab is open.');
      } catch (e) { err = err || e; if (mode === 'tab') throw e; }
    }
    if (!r) throw err instanceof ApiError ? err : new ApiError('NETWORK', err?.message || 'Network error');
    return parseResponse(r);
  } finally {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

function parseResponse(r) {
  if (r.status === 0) throw new ApiError('NETWORK', `Network error: ${r.text}`);
  let json = null;
  try { json = JSON.parse(r.text); } catch {}
  if (r.status >= 200 && r.status < 300) {
    if (json == null) throw new ApiError('BAD_RESPONSE', 'Unexpected non-JSON response from claude.ai');
    return json;
  }
  const body = json ? JSON.stringify(json) : '';
  if (r.status === 401 || (r.status === 403 && /session|auth|permission|login/i.test(body))) {
    throw new ApiError('SESSION_EXPIRED', 'Session expired or signed out — re-capture this account in Settings → Accounts.', r.status);
  }
  if (r.status === 403 || r.status === 503) {
    throw new ApiError('BLOCKED', 'Blocked by claude.ai protection. Open claude.ai in a tab and retry, or set Request mode to "Through claude.ai tab".', r.status);
  }
  if (r.status === 429) throw new ApiError('RATE_LIMITED', 'claude.ai is rate-limiting checks. Increase the check interval.', r.status);
  if (r.status === 404) throw new ApiError('NOT_FOUND', 'Usage endpoint not found — wrong organization or claude.ai changed its API.', r.status);
  throw new ApiError('HTTP', `claude.ai returned HTTP ${r.status}`, r.status);
}

// ───────────────────────── identity ─────────────────────────
function planLabel(o) {
  const caps = o.capabilities || [];
  const tier = String(o.rate_limit_tier || '').toLowerCase();
  const m = tier.match(/max_(\d+)x/);
  if (m) return `Max ${m[1]}x`;
  if (caps.includes('claude_max') || tier.includes('max')) return 'Max';
  if (caps.includes('claude_pro') || tier.includes('pro')) return 'Pro';
  if (caps.includes('raven') || tier.includes('raven') || tier.includes('team') || tier.includes('enterprise')) return 'Team / Enterprise';
  if (caps.includes('api') && !caps.includes('chat')) return 'API';
  return 'Free';
}

async function identify(sessionKey, mode) {
  const orgsRaw = await apiGet('/organizations', sessionKey, null, mode);
  const orgs = (Array.isArray(orgsRaw) ? orgsRaw : []).map((o) => ({
    uuid: o.uuid,
    name: o.name,
    capabilities: o.capabilities || [],
    tier: o.rate_limit_tier || null,
    billing: o.billing_type || null,
    plan: planLabel(o),
  })).filter((o) => o.uuid);
  if (!orgs.length) throw new ApiError('NO_ORG', 'No organizations found for this session.');
  const preferred = orgs.find((o) => o.capabilities.includes('chat')) || orgs[0];

  let email = null, name = null, accountUuid = null;
  for (const p of ['/account', '/bootstrap']) {
    try {
      const a = await apiGet(p, sessionKey, preferred.uuid, mode);
      const acct = a?.account || a;
      email = acct?.email_address || acct?.email || null;
      name = acct?.full_name || acct?.display_name || acct?.name || null;
      accountUuid = acct?.uuid || null;
      if (email) break;
    } catch {}
  }
  return { orgs, orgId: preferred.uuid, email, name, accountUuid };
}

// ───────────────────────── polling ─────────────────────────
let chain = Promise.resolve();
function withLock(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

let pollingAll = null;
function pollAll(reason) {
  if (pollingAll) return pollingAll;
  pollingAll = (async () => {
    const { accounts, settings } = await loadState();
    if (settings.paused && reason === 'alarm') return;
    const list = accounts.filter((a) => a.enabled !== false);
    for (let i = 0; i < list.length; i++) {
      await pollOne(list[i].id);
      if (i < list.length - 1) await sleep(500);
    }
    await chrome.storage.local.set({ lastPollAll: Date.now() });
    await updateBadge();
  })().finally(() => { pollingAll = null; });
  return pollingAll;
}

function pollOne(id) {
  return withLock(async () => {
    const st = await loadState();
    const acc = st.accounts.find((a) => a.id === id);
    if (!acc) return;
    const s = st.settings;
    const now = Date.now();
    const prev = st.status[id] || {};
    let status;

    try {
      const data = await apiGet(`/organizations/${acc.orgId}/usage`, acc.sessionKey, acc.orgId, s.requestMode);
      const windows = parseUsage(data, s.utilizationScale);
      if (!windows.length) throw new ApiError('BAD_RESPONSE', 'No usage windows in the response (claude.ai may have changed its format).');
      status = {
        ok: true, lastChecked: now, lastSuccess: now, windows, error: null, errorCode: null,
        consecutiveErrors: 0, raw: s.debugLog ? data : undefined,
      };
      await log('info', `Polled ${acc.label}`, windows);
    } catch (e) {
      status = {
        ...prev, ok: false, lastChecked: now, error: e.message || String(e), errorCode: e.code || 'ERROR',
        consecutiveErrors: (prev.consecutiveErrors || 0) + 1,
      };
      await log('error', `Poll failed for ${acc.label}: ${status.error}`);
    }

    // history
    const hist = (st.history[id] || []).filter((p) => now - p.t <= s.historyHours * 3600000);
    if (status.ok) {
      const w = {}, r = {};
      for (const x of status.windows) { w[x.key] = x.utilization; r[x.key] = x.resetsAt; }
      hist.push({ t: now, w, r });
    }
    st.history[id] = hist.slice(-3000);
    st.status[id] = status;

    const notes = evaluateAlerts(acc, status, st);
    await chrome.storage.local.set({ status: st.status, history: st.history, alertState: st.alertState });
    if (notes.length) await deliver(notes, s);
    return status;
  });
}

// ───────────────────────── alerts ─────────────────────────
function bestAlternative(excludeId, st) {
  const s = st.settings;
  let best = null;
  for (const a of st.accounts) {
    if (a.id === excludeId || a.enabled === false) continue;
    const status = st.status[a.id];
    if (!status?.ok) continue;
    const peak = accountPeak(status, s);
    if (peak == null) continue;
    const { warning } = thresholdsFor(a, s);
    if (peak >= warning) continue;
    if (!best || peak < best.peak) best = { label: a.label, peak };
  }
  return best;
}

function evaluateAlerts(acc, status, st) {
  const s = st.settings;
  const now = Date.now();
  const as = (st.alertState[acc.id] ||= {});
  const notes = [];
  const allowed = acc.notify !== false;

  if (!status.ok) {
    if (status.errorCode === 'SESSION_EXPIRED' && s.notifySessionErrors && !as._session && allowed) {
      notes.push({ level: 'critical', accId: acc.id, kind: 'session', title: `${acc.label}: session expired`, message: 'Re-capture this account in Settings → Accounts to resume monitoring.' });
      as._session = now;
    }
    if (status.errorCode !== 'SESSION_EXPIRED' && status.consecutiveErrors === 3 && s.notifySessionErrors && allowed) {
      notes.push({ level: 'warning', accId: acc.id, kind: 'error', title: `${acc.label}: can't read usage`, message: status.error });
    }
    return notes;
  }
  delete as._session;

  const { warning, critical } = thresholdsFor(acc, s);
  const hist = st.history[acc.id] || [];
  const alt = s.suggestAlternative ? bestAlternative(acc.id, st) : null;
  const altText = alt ? ` Switch to ${alt.label} (${Math.round(alt.peak)}% used).` : '';

  for (const w of status.windows) {
    if (!isWatched(w.key, s)) { delete as[w.key]; continue; }
    const prev = as[w.key] || { level: 'ok' };
    const lvl = levelFor(w.utilization, warning, critical);
    const rank = LEVELS.indexOf(lvl), prank = LEVELS.indexOf(prev.level);
    const newWindow = prev.resetsAt && w.resetsAt && prev.resetsAt !== w.resetsAt;
    const next = { level: lvl, resetsAt: w.resetsAt, notifiedAt: prev.notifiedAt || 0, projNotified: newWindow ? false : !!prev.projNotified };
    const pct = Math.round(w.utilization);
    const reset = fmtReset(w.resetsAt, s.timeFormat, now);

    if (allowed) {
      if (rank > prank && rank > 0 && !(lvl === 'limit' && !s.notifyAtLimit)) {
        const head = lvl === 'limit' ? 'limit reached' : lvl === 'critical' ? 'almost at limit' : 'approaching limit';
        notes.push({ level: lvl, accId: acc.id, kind: 'threshold', title: `${acc.label} · ${w.label} ${head} (${pct}%)`, message: `${capital(reset)}.${altText}` });
        next.notifiedAt = now;
      } else if (rank > 0 && rank === prank && s.repeatEveryMin > 0 && now - (prev.notifiedAt || 0) >= s.repeatEveryMin * 60000) {
        notes.push({ level: lvl, accId: acc.id, kind: 'repeat', title: `${acc.label} · ${w.label} still at ${pct}%`, message: `${capital(reset)}.${altText}` });
        next.notifiedAt = now;
      } else if (rank === 0 && prank > 0 && s.notifyOnReset) {
        notes.push({ level: 'ok', accId: acc.id, kind: 'reset', title: `${acc.label} · ${w.label} available again`, message: `Usage is back to ${pct}%.` });
      }
      if (s.projectionAlertMin > 0 && rank < 2 && !next.projNotified) {
        const eta = projectEta(hist, w.key, w.resetsAt, now);
        if (eta != null && eta <= s.projectionAlertMin) {
          notes.push({ level: 'warning', accId: acc.id, kind: 'projection', title: `${acc.label} · ${w.label} on pace to hit the limit`, message: `At the current pace you'll hit 100% in ~${fmtDuration(eta * 60000)} (now ${pct}%).${altText}` });
          next.projNotified = true;
        }
      }
    }
    as[w.key] = next;
  }
  return notes;
}

const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);

async function deliver(notes, s) {
  if (!s.notificationsEnabled) return;
  const now = Date.now();
  const snoozed = s.snoozeUntil && s.snoozeUntil > now;
  const quiet = inQuietHours(s);
  const urgent = (n) => n.level === 'critical' || n.level === 'limit' || n.kind === 'session';
  const toSend = notes.filter((n) => {
    if (snoozed) return false;
    if (quiet) return s.criticalBypassQuiet && urgent(n);
    return true;
  });
  if (!toSend.length) return;

  for (const n of toSend.slice(0, 4)) {
    const icon = { ok: '✅', warning: '⚠️', critical: '🔶', limit: '⛔' }[n.level] || '';
    chrome.notifications.create(`cum|${n.accId}|${n.kind}|${now}|${Math.random().toString(36).slice(2, 6)}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${icon} ${n.title}`.trim(),
      message: n.message || '',
      contextMessage: 'Claude Usage Monitor',
      priority: urgent(n) ? 2 : 1,
      requireInteraction: !!(s.requireInteractionCritical && urgent(n)),
      buttons: [{ title: 'Open Claude' }, { title: 'Snooze 1 hour' }],
    });
  }
  const top = toSend.reduce((a, n) => (LEVELS.indexOf(n.level) > LEVELS.indexOf(a.level) ? n : a), toSend[0]);
  await playSound(s, top.level);
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.tabs.create({ url: ORIGIN + '/new' });
  chrome.notifications.clear(id);
});
chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  if (idx === 0) chrome.tabs.create({ url: ORIGIN + '/new' });
  if (idx === 1) {
    const { settings } = await loadState();
    settings.snoozeUntil = Date.now() + 3600000;
    await chrome.storage.local.set({ settings });
  }
  chrome.notifications.clear(id);
});

async function playSound(s, level = 'warning') {
  if (!s.soundEnabled) return;
  try {
    const existing = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
    if (!existing.length) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Play alert sounds for usage notifications' });
    }
  } catch {}
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'play', tone: s.soundTone, volume: (Number(s.soundVolume) || 60) / 100, level });
  } catch {}
}

// ───────────────────────── badge ─────────────────────────
async function updateBadge() {
  const st = await loadState();
  const s = st.settings;
  const enabled = st.accounts.filter((a) => a.enabled !== false);
  let text = '', color = LEVEL_COLORS.ok;
  const lines = ['Claude Usage Monitor'];

  if (s.paused) {
    text = 'II'; color = LEVEL_COLORS.error;
    lines.push('Monitoring paused');
  } else if (!enabled.length) {
    text = ''; lines.push('No accounts yet — click to add one');
  } else {
    const peaks = [];
    let errors = 0;
    for (const a of enabled) {
      const status = st.status[a.id];
      if (status && !status.ok) errors++;
      const p = accountPeak(status, s);
      lines.push(`${a.label}: ${status?.ok === false ? 'error' : p == null ? '—' : Math.round(p) + '%'}`);
      if (p != null) peaks.push({ a, p });
    }
    if (s.badgeMode === 'max' && peaks.length) {
      const v = Math.max(...peaks.map((x) => x.p));
      text = String(Math.round(v)); color = LEVEL_COLORS[levelFor(v, s.warningPct, s.criticalPct)];
    } else if (s.badgeMode === 'best' && peaks.length) {
      const v = Math.min(...peaks.map((x) => x.p));
      text = String(Math.round(v)); color = LEVEL_COLORS[levelFor(v, s.warningPct, s.criticalPct)];
    } else if (s.badgeMode === 'count') {
      const n = peaks.filter((x) => { const t = thresholdsFor(x.a, s); return x.p >= t.warning; }).length;
      text = n ? String(n) : ''; color = n ? LEVEL_COLORS.warning : LEVEL_COLORS.ok;
    }
    if (s.badgeShowErrors && errors && (errors === enabled.length || !text)) {
      text = '!'; color = LEVEL_COLORS.critical;
    }
    if (s.snoozeUntil > Date.now()) lines.push(`Alerts snoozed until ${new Date(s.snoozeUntil).toLocaleTimeString()}`);
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: lines.join('\n') });
}

// ───────────────────────── session capture ─────────────────────────
async function detectSessions() {
  const st = await loadState();
  const stores = await chrome.cookies.getAllCookieStores();
  const items = [];
  for (const store of stores) {
    const sk = await chrome.cookies.get({ url: ORIGIN + '/', name: 'sessionKey', storeId: store.id });
    if (!sk?.value) continue;
    const incognito = store.id !== '0';
    const item = {
      storeId: store.id,
      source: incognito ? 'Incognito window' : 'Main browser window',
      sessionKey: sk.value,
      preview: maskKey(sk.value),
      expires: sk.expirationDate ? Math.round(sk.expirationDate * 1000) : null,
    };
    try { Object.assign(item, await identify(sk.value, st.settings.requestMode)); }
    catch (e) { item.error = e.message; }
    const match = st.accounts.find((a) => a.sessionKey === sk.value)
      || st.accounts.find((a) => item.email && a.email === item.email);
    item.existingId = match?.id || null;
    item.sameKey = match?.sessionKey === sk.value;
    item.existingLabel = match?.label || null;
    items.push(item);
  }
  let incognitoAllowed = false;
  try { incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess(); } catch {}
  return { items, incognitoAllowed };
}

async function addAccount(input) {
  const st = await loadState();
  const sessionKey = extractSessionKey(input.sessionKey);
  if (!sessionKey) throw new Error('That does not look like a valid sessionKey.');
  let ident = input.identity;
  if (!ident?.orgs) ident = await identify(sessionKey, st.settings.requestMode);
  const orgId = input.orgId || ident.orgId;
  const org = ident.orgs.find((o) => o.uuid === orgId) || ident.orgs[0];

  const existing = st.accounts.find((a) => (input.existingId && a.id === input.existingId)
    || (ident.email && a.email === ident.email && a.orgId === org.uuid));
  const base = {
    sessionKey,
    orgId: org.uuid,
    orgName: org.name,
    plan: org.plan,
    tier: org.tier,
    billing: org.billing,
    orgs: ident.orgs.map(({ uuid, name, plan }) => ({ uuid, name, plan })),
    email: ident.email,
    name: ident.name,
    accountUuid: ident.accountUuid,
    source: input.source || 'Pasted session key',
    sessionExpires: input.expires || null,
    capturedAt: Date.now(),
  };
  let id;
  if (existing) {
    Object.assign(existing, base);
    if (input.label) existing.label = input.label;
    id = existing.id;
  } else {
    id = crypto.randomUUID();
    st.accounts.push({
      id,
      label: input.label || ident.name?.split(' ')[0] || ident.email?.split('@')[0] || `Account ${st.accounts.length + 1}`,
      color: ACCOUNT_COLORS[st.accounts.length % ACCOUNT_COLORS.length],
      enabled: true,
      notify: true,
      thresholds: { warning: null, critical: null },
      addedAt: Date.now(),
      ...base,
    });
  }
  delete st.status[id];
  delete st.alertState[id];
  await chrome.storage.local.set({ accounts: st.accounts, status: st.status, alertState: st.alertState });
  await pollOne(id);
  await updateBadge();
  return { id, updated: !!existing };
}

// ───────────────────────── messages ─────────────────────────
const handlers = {
  pollAll: () => pollAll('manual'),
  pollOne: async ({ id }) => { const r = await pollOne(id); await updateBadge(); return r; },
  detectSessions,
  identify: async ({ input }) => {
    const sk = extractSessionKey(input);
    if (!sk) throw new Error('Paste the sessionKey value (starts with sk-ant-) or the full Cookie header.');
    const { settings } = await loadState();
    return { sessionKey: sk, preview: maskKey(sk), ...(await identify(sk, settings.requestMode)) };
  },
  addAccount: ({ account }) => addAccount(account),
  updateAccount: async ({ id, patch }) => {
    const st = await loadState();
    const a = st.accounts.find((x) => x.id === id);
    if (!a) throw new Error('Account not found');
    mergeDeep(a, patch);
    if (patch.orgId) {
      const o = (a.orgs || []).find((x) => x.uuid === patch.orgId);
      if (o) { a.orgName = o.name; a.plan = o.plan; }
      delete st.status[id]; delete st.alertState[id];
    }
    await chrome.storage.local.set({ accounts: st.accounts, status: st.status, alertState: st.alertState });
    if (patch.orgId || patch.enabled === true) await pollOne(id);
    await updateBadge();
    return a;
  },
  reorderAccounts: async ({ ids }) => {
    const st = await loadState();
    st.accounts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    await chrome.storage.local.set({ accounts: st.accounts });
  },
  removeAccount: async ({ id }) => {
    const st = await loadState();
    st.accounts = st.accounts.filter((a) => a.id !== id);
    delete st.status[id]; delete st.history[id]; delete st.alertState[id];
    await chrome.storage.local.set(st);
    await updateBadge();
  },
  testNotification: async () => {
    const { settings } = await loadState();
    await deliver([{ level: 'warning', accId: 'test', kind: 'test', title: 'Test · 5-hour session approaching limit (78%)', message: 'This is how alerts will look. Resets in 1h 12m.' }],
      { ...settings, notificationsEnabled: true, snoozeUntil: 0, quietHoursEnabled: false });
  },
  testSound: async ({ tone, volume }) => {
    const { settings } = await loadState();
    await playSound({ ...settings, soundEnabled: true, soundTone: tone || settings.soundTone, soundVolume: volume ?? settings.soundVolume }, 'warning');
  },
  snooze: async ({ minutes }) => {
    const { settings } = await loadState();
    settings.snoozeUntil = minutes > 0 ? Date.now() + minutes * 60000 : 0;
    await chrome.storage.local.set({ settings });
    await updateBadge();
    return settings.snoozeUntil;
  },
  clearHistory: async () => { await chrome.storage.local.set({ history: {} }); },
  resetAlerts: async () => { await chrome.storage.local.set({ alertState: {} }); },
  getLog: async () => (await chrome.storage.local.get('log')).log || [],
  clearLog: async () => { await chrome.storage.local.set({ log: [] }); },
  resetAll: async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ settings: structuredClone(DEFAULT_SETTINGS) });
    await schedule();
    await updateBadge();
  },
  importData: async ({ data }) => {
    if (!data || typeof data !== 'object') throw new Error('Invalid file');
    const st = await loadState();
    const settings = mergeDeep(structuredClone(DEFAULT_SETTINGS), data.settings || {});
    let accounts = st.accounts;
    if (Array.isArray(data.accounts)) {
      for (const inc of data.accounts) {
        const ex = accounts.find((a) => a.id === inc.id || (inc.email && a.email === inc.email && a.orgId === inc.orgId));
        if (ex) { const key = ex.sessionKey; Object.assign(ex, inc); if (!inc.sessionKey) ex.sessionKey = key; }
        else if (inc.sessionKey) accounts.push(inc);
      }
    }
    await chrome.storage.local.set({ settings, accounts });
    await schedule();
    await updateBadge();
    return { accounts: accounts.length };
  },
  rebuildBadge: () => updateBadge(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  const h = handlers[msg.type];
  if (!h) return;
  Promise.resolve()
    .then(() => h(msg))
    .then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: e?.message || String(e), code: e?.code }));
  return true;
});
