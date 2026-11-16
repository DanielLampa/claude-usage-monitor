// Shared constants and helpers used by the background worker, popup and options page.

export const DEFAULT_SETTINGS = {
  // Monitoring
  paused: false,
  pollIntervalMin: 5,
  refreshOnStartup: true,
  requestMode: 'auto', // auto | direct | tab
  utilizationScale: 'percent', // percent | fraction

  // Thresholds
  warningPct: 75,
  criticalPct: 90,
  notifyAtLimit: true,
  watch: {
    five_hour: true,
    seven_day: true,
    seven_day_opus: true,
    seven_day_sonnet: true,
    other: false,
  },

  // Notifications
  notificationsEnabled: true,
  notifyOnReset: true,
  repeatEveryMin: 0,
  projectionAlertMin: 30,
  suggestAlternative: true,
  requireInteractionCritical: true,
  notifySessionErrors: true,
  snoozeUntil: 0,

  // Sound
  soundEnabled: true,
  soundTone: 'chime', // chime | beep | alert | soft
  soundVolume: 60,

  // Quiet hours
  quietHoursEnabled: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  criticalBypassQuiet: true,

  // Display
  badgeMode: 'max', // max | best | count | off
  badgeShowErrors: true,
  theme: 'auto', // auto | light | dark
  timeFormat: '12h', // 12h | 24h
  popupSort: 'manual', // manual | usage | name
  popupCompact: false,
  showProjection: true,
  showDetailsByDefault: false,

  // Advanced
  historyHours: 48,
  debugLog: false,
};

export const WINDOW_META = {
  five_hour: { label: '5-hour session', short: '5h' },
  seven_day: { label: 'Weekly · all models', short: '7d' },
  seven_day_opus: { label: 'Weekly · Opus', short: 'Opus' },
  seven_day_sonnet: { label: 'Weekly · Sonnet', short: 'Sonnet' },
};
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

export const LEVELS = ['ok', 'warning', 'critical', 'limit'];
export const LEVEL_COLORS = {
  ok: '#2f9e6b',
  warning: '#d9a21b',
  critical: '#e8590c',
  limit: '#d6336c',
  error: '#868e96',
};
export const ACCOUNT_COLORS = ['#d97757', '#4c6ef5', '#12b886', '#be4bdb', '#fab005', '#15aabf', '#e64980', '#82c91e'];

export function windowLabel(key) {
  return WINDOW_META[key]?.label || String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function windowShort(key) {
  return WINDOW_META[key]?.short || windowLabel(key);
}
export function watchKey(key) {
  return WINDOW_META[key] ? key : 'other';
}
export function isWatched(key, s) {
  return !!(s.watch && s.watch[watchKey(key)]);
}

export function levelFor(u, warn, crit) {
  if (u == null || Number.isNaN(u)) return 'ok';
  if (u >= 100) return 'limit';
  if (u >= crit) return 'critical';
  if (u >= warn) return 'warning';
  return 'ok';
}

export function thresholdsFor(acc, s) {
  const w = acc?.thresholds?.warning;
  const c = acc?.thresholds?.critical;
  return {
    warning: typeof w === 'number' && !Number.isNaN(w) ? w : s.warningPct,
    critical: typeof c === 'number' && !Number.isNaN(c) ? c : s.criticalPct,
  };
}

/** Parse the /usage response into an ordered list of windows. Defensive: any key with a numeric utilization counts. */
export function parseUsage(data, scale = 'percent') {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  for (const [key, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    let u = v.utilization ?? v.percent_used ?? v.usage_percent;
    if (typeof u !== 'number' || Number.isNaN(u)) continue;
    if (scale === 'fraction') u *= 100;
    out.push({
      key,
      label: windowLabel(key),
      utilization: Math.max(0, Math.round(u * 10) / 10),
      resetsAt: v.resets_at || v.reset_at || v.resetsAt || null,
    });
  }
  out.sort((a, b) => {
    const ia = WINDOW_ORDER.indexOf(a.key), ib = WINDOW_ORDER.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.key.localeCompare(b.key);
  });
  return out;
}

/** Highest utilization among watched windows for an account status, or null. */
export function accountPeak(status, s) {
  if (!status?.windows?.length) return null;
  const vals = status.windows.filter((w) => isWatched(w.key, s)).map((w) => w.utilization);
  return vals.length ? Math.max(...vals) : null;
}

/** Minutes until a window is projected to hit 100%, based on recent history in the same reset window. */
export function projectEta(hist, key, resetsAt, now = Date.now()) {
  if (!Array.isArray(hist)) return null;
  const pts = hist.filter(
    (p) => p.w && typeof p.w[key] === 'number' && now - p.t <= 90 * 60000 && (!resetsAt || !p.r || p.r[key] === resetsAt)
  );
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const mins = (last.t - first.t) / 60000;
  if (mins < 5) return null;
  const slope = (last.w[key] - first.w[key]) / mins; // % per minute
  if (slope <= 0.01) return null;
  const eta = (100 - last.w[key]) / slope;
  if (eta <= 0) return 0;
  if (resetsAt) {
    const toReset = (new Date(resetsAt).getTime() - now) / 60000;
    if (toReset > 0 && eta > toReset) return null; // will reset first
  }
  return Math.round(eta);
}

export function extractSessionKey(input) {
  if (!input) return null;
  const t = String(input).trim();
  const m = t.match(/sessionKey=([^;\s]+)/);
  if (m) return m[1];
  const m2 = t.match(/sk-ant-[A-Za-z0-9_\-]+/);
  if (m2) return m2[0];
  if (/^[A-Za-z0-9_\-]{20,}$/.test(t)) return t;
  return null;
}

export function maskKey(k) {
  if (!k) return '—';
  return k.length <= 16 ? '••••' : `${k.slice(0, 13)}…${k.slice(-4)}`;
}

export function inQuietHours(s, d = new Date()) {
  if (!s.quietHoursEnabled) return false;
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = toMin(s.quietStart), b = toMin(s.quietEnd);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const neg = ms < 0;
  ms = Math.abs(ms);
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  let s;
  if (d > 0) s = `${d}d ${h}h`;
  else if (h > 0) s = `${h}h ${mm}m`;
  else s = `${mm}m`;
  return neg ? `-${s}` : s;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const diff = now - ts;
  if (diff < 45000) return 'just now';
  return `${fmtDuration(diff)} ago`;
}

export function fmtDateTime(ts, fmt = '12h') {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: fmt !== '24h',
  });
}

export function fmtReset(resetsAt, fmt = '12h', now = Date.now()) {
  if (!resetsAt) return 'reset time unknown';
  const t = new Date(resetsAt).getTime();
  if (Number.isNaN(t)) return 'reset time unknown';
  if (t <= now) return 'resetting now';
  const ms = t - now;
  return ms < 24 * 3600000 ? `resets in ${fmtDuration(ms)}` : `resets ${fmtDateTime(t, fmt)}`;
}

export function mergeDeep(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeDeep(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] ??= {};
  o[keys[keys.length - 1]] = value;
  return obj;
}

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function loadState() {
  const d = await chrome.storage.local.get(['settings', 'accounts', 'status', 'history', 'alertState']);
  return {
    settings: mergeDeep(structuredClone(DEFAULT_SETTINGS), d.settings || {}),
    accounts: d.accounts || [],
    status: d.status || {},
    history: d.history || {},
    alertState: d.alertState || {},
  };
}

export async function saveSettings(patch) {
  const { settings } = await loadState();
  const next = mergeDeep(settings, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (!res.ok) return reject(Object.assign(new Error(res.error), { code: res.code }));
      resolve(res.data);
    });
  });
}

export function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
