const RELAY = 'https://ntfy.sh';
const TOPIC_PREFIX = 'snly';
const SELF_BEFORE_S = 15;
const SELF_AFTER_S = 5;
const SETTLE_MS = 20_000;
const VIEW_GAP_S = 120;
const KEEP_DAYS = 45;
const MAX_EMAILS = 300;
const MAX_HITS = 100;
const POLL_CHUNK = 40;
const SYNC_GAP_MS = 15_000;
const MARK_GAP_MS = 60_000;
const SHARE_PREFIX = 'e_';
const SHARE_HITS = 15;
const SHARE_MAX_BYTES = 90_000;

let lastSyncAt = 0;
let lastSyncOk = true;
let syncing = null;
let queue = Promise.resolve();

function serial(task) {
  const run = queue.then(task);
  queue = run.then(() => {}, () => {});
  return run;
}

function topicFor(id) {
  return TOPIC_PREFIX + id.replace(/-/g, '');
}

async function loadEmails() {
  const { emails } = await chrome.storage.local.get({ emails: {} });
  return emails;
}

function prune(emails) {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const list = Object.values(emails)
    .filter((email) => email.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_EMAILS);
  return Object.fromEntries(list.map((email) => [email.id, email]));
}

function shareRecord(email) {
  return {
    s: String(email.subject || '').slice(0, 150),
    f: email.from || '',
    r: (email.recipients || []).slice(0, 5).map((person) => [person.email, String(person.name || '').slice(0, 40)]),
    c: email.createdAt,
    k: email.sentMarked ? 1 : 0,
    g: email.sentGuessAt || 0,
    h: (email.hits || []).slice(-SHARE_HITS).map((hit) => [hit.id, hit.at, hit.kind, hit.firstSeen])
  };
}

function mergeShared(emails, id, record) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !record || !Number.isFinite(record.c)) return;
  const hits = (record.h || []).map(([hitId, at, kind, firstSeen]) => ({ id: hitId, at, kind, firstSeen }));
  const local = emails[id];
  if (!local) {
    emails[id] = {
      id,
      topic: topicFor(id),
      subject: record.s || '',
      recipients: (record.r || []).map(([email, name]) => ({ email, name })),
      from: record.f || '',
      createdAt: record.c,
      sentMarked: Boolean(record.k),
      sentGuessAt: record.g || 0,
      hits
    };
    return;
  }
  local.subject ||= record.s || '';
  local.from ||= record.f || '';
  if (!local.recipients?.length) local.recipients = (record.r || []).map(([email, name]) => ({ email, name }));
  local.createdAt = Math.min(local.createdAt || record.c, record.c);
  local.sentMarked = Boolean(local.sentMarked || record.k);
  const guesses = [local.sentGuessAt, record.g].filter(Boolean);
  local.sentGuessAt = guesses.length ? Math.min(...guesses) : 0;
  local.hits ||= [];
  const known = new Set(local.hits.map((hit) => hit.id));
  for (const hit of hits) {
    if (!known.has(hit.id)) local.hits.push(hit);
  }
  local.hits.sort((a, b) => a.at - b.at);
  if (local.hits.length > MAX_HITS) local.hits.splice(0, local.hits.length - MAX_HITS);
}

async function pullShared(emails) {
  try {
    const shared = await chrome.storage.sync.get(null);
    for (const [key, record] of Object.entries(shared)) {
      if (key.startsWith(SHARE_PREFIX)) mergeShared(emails, key.slice(SHARE_PREFIX.length), record);
    }
  } catch {
    // Chrome sync is off or unavailable; this device keeps working on its own.
  }
  return emails;
}

async function pushShared(emails) {
  try {
    const shared = await chrome.storage.sync.get(null);
    const changes = {};
    const keep = new Set();
    let bytes = 0;
    for (const email of Object.values(prune(emails))) {
      const key = SHARE_PREFIX + email.id;
      const record = shareRecord(email);
      const json = JSON.stringify(record);
      bytes += key.length + json.length;
      if (bytes > SHARE_MAX_BYTES) break;
      keep.add(key);
      if (JSON.stringify(shared[key]) !== json) changes[key] = record;
    }
    const stale = Object.keys(shared).filter((key) => key.startsWith(SHARE_PREFIX) && !keep.has(key));
    if (Object.keys(changes).length) await chrome.storage.sync.set(changes);
    if (stale.length) await chrome.storage.sync.remove(stale);
  } catch {
    // Sharing is best effort; local tracking is unaffected.
  }
}

async function publish(topic, message) {
  const response = await fetch(`${RELAY}/${topic}`, { method: 'POST', body: message, cache: 'no-store' });
  if (!response.ok) throw new Error(`relay answered ${response.status}`);
  const data = await response.json().catch(() => null);
  if (Number.isFinite(data?.time)) {
    await chrome.storage.local.set({ relaySkewS: Math.round(Date.now() / 1000 - data.time) });
  }
}

async function publishWithRetry(topic, message, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      await publish(topic, message);
      return true;
    } catch {
      if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return false;
}

async function relayNowS() {
  let { relaySkewS } = await chrome.storage.local.get({ relaySkewS: null });
  if (!Number.isFinite(relaySkewS)) {
    try {
      const response = await fetch(`${RELAY}/v1/health`, { cache: 'no-store' });
      const serverDate = Date.parse(response.headers.get('date') || '');
      if (Number.isFinite(serverDate)) {
        relaySkewS = Math.round((Date.now() - serverDate) / 1000);
        await chrome.storage.local.set({ relaySkewS });
      }
    } catch {
      return 0;
    }
  }
  return Number.isFinite(relaySkewS) ? Math.floor(Date.now() / 1000 - relaySkewS) : 0;
}

function isSelfSend(email) {
  const from = (email.from || '').toLowerCase();
  return Boolean(from) && email.recipients?.length > 0
    && email.recipients.every((person) => person.email.toLowerCase() === from);
}

function summarize(email) {
  const hits = email.hits || [];
  const sent = hits.filter((hit) => hit.kind === 's').map((hit) => hit.at);
  if (email.sentGuessAt) sent.push(email.sentGuessAt);
  const sentAt = sent.length ? Math.min(...sent) : 0;
  const marks = hits.filter((hit) => hit.kind === 'm').map((hit) => hit.at);
  const selfSend = isSelfSend(email);
  const now = Date.now();
  let opens = hits
    .filter((hit) => hit.kind === 'o')
    .filter((hit) => sentAt && hit.at >= sentAt)
    .sort((a, b) => a.at - b.at);
  if (!selfSend) {
    for (const markAt of marks) {
      let closest = -1;
      opens.forEach((hit, index) => {
        if (hit.at < markAt - SELF_BEFORE_S || hit.at > markAt + SELF_AFTER_S) return;
        if (closest === -1 || Math.abs(hit.at - markAt) < Math.abs(opens[closest].at - markAt)) closest = index;
      });
      if (closest !== -1) opens.splice(closest, 1);
    }
  }
  opens = opens.filter((hit) => now - hit.firstSeen >= SETTLE_MS);
  const views = [];
  for (const hit of opens) {
    const last = views.at(-1);
    if (last && hit.at - last.at < VIEW_GAP_S) continue;
    views.push(hit);
  }
  return {
    id: email.id,
    subject: email.subject,
    recipients: email.recipients,
    from: email.from || '',
    createdAt: email.createdAt,
    viewCount: views.length,
    firstOpenedAt: views[0]?.firstSeen || null,
    lastOpenedAt: views.at(-1)?.firstSeen || null
  };
}

async function pollRelay(emails) {
  const active = Object.values(emails).sort((a, b) => b.createdAt - a.createdAt);
  const byTopic = new Map(active.map((email) => [email.topic, email]));
  const now = Date.now();
  for (let i = 0; i < active.length; i += POLL_CHUNK) {
    const topics = active.slice(i, i + POLL_CHUNK).map((email) => email.topic).join(',');
    const response = await fetch(`${RELAY}/${topics}/json?poll=1&since=all`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`relay answered ${response.status}`);
    const serverDate = Date.parse(response.headers.get('date') || '');
    if (Number.isFinite(serverDate)) {
      await chrome.storage.local.set({ relaySkewS: Math.round((Date.now() - serverDate) / 1000) });
    }
    const lines = (await response.text()).split('\n').filter(Boolean);
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event !== 'message') continue;
      const email = byTopic.get(msg.topic);
      if (!email) continue;
      email.hits ||= [];
      if (email.hits.some((hit) => hit.id === msg.id)) continue;
      const kind = msg.message === 's' ? 's' : msg.message === 'm' ? 'm' : 'o';
      email.hits.push({ id: msg.id, at: msg.time, kind, firstSeen: now });
      if (email.hits.length > MAX_HITS) email.hits.splice(0, email.hits.length - MAX_HITS);
    }
  }
}

async function retrySentMarks(emails) {
  for (const email of Object.values(emails)) {
    if (email.sentMarked) continue;
    try {
      await publish(email.topic, 's');
      email.sentMarked = true;
    } catch {
      return;
    }
  }
}

function sync(force = false) {
  if (syncing) return syncing;
  if (!force && Date.now() - lastSyncAt < SYNC_GAP_MS) return Promise.resolve();
  syncing = serial(async () => {
    const emails = prune(await pullShared(await loadEmails()));
    try {
      await retrySentMarks(emails);
      await pollRelay(emails);
      lastSyncOk = true;
    } catch {
      lastSyncOk = false;
    }
    lastSyncAt = Date.now();
    await chrome.storage.local.set({ emails });
    await pushShared(emails);
  }).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function listEmails() {
  const emails = await loadEmails();
  return Object.values(emails)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(summarize);
}

async function register(payload) {
  const id = String(payload?.id || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('Missing a valid tracking id.');
  }
  const topic = topicFor(id);
  const clickedAt = await relayNowS();
  const sentMarked = await publishWithRetry(topic, 's');
  await serial(async () => {
    const emails = await loadEmails();
    const existing = emails[id];
    emails[id] = {
      id,
      topic,
      subject: String(payload.subject || '').slice(0, 500),
      recipients: Array.isArray(payload.recipients) ? payload.recipients.slice(0, 50) : [],
      from: String(payload.from || '').toLowerCase(),
      createdAt: existing?.createdAt || Date.now(),
      sentMarked: sentMarked || Boolean(existing?.sentMarked),
      sentGuessAt: existing?.sentGuessAt || (sentMarked ? 0 : clickedAt),
      hits: existing?.hits || []
    };
    await chrome.storage.local.set({ emails: prune(emails) });
    await pushShared(emails);
  });
}

async function selfView(ids) {
  const emails = await loadEmails();
  const { lastMark } = await chrome.storage.local.get({ lastMark: {} });
  const now = Date.now();
  for (const raw of ids || []) {
    const email = emails[String(raw).toLowerCase()];
    if (!email || now - (lastMark[email.id] || 0) < MARK_GAP_MS) continue;
    try {
      await publish(email.topic, 'm');
      lastMark[email.id] = now;
    } catch {
      // The view is reported again on the next scan.
    }
  }
  for (const id of Object.keys(lastMark)) {
    if (!emails[id]) delete lastMark[id];
  }
  await chrome.storage.local.set({ lastMark });
}

async function refreshBadge() {
  try {
    const list = await listEmails();
    const { seen, accounts, connectedEmail } = await chrome.storage.local.get({ seen: {}, accounts: null, connectedEmail: '' });
    const mine = Array.isArray(accounts) ? accounts : connectedEmail ? [connectedEmail] : [];
    const unseen = list.filter((email) => {
      if (mine.length && email.from && !mine.includes(email.from)) return false;
      if (!email.lastOpenedAt) return false;
      return !seen[email.id] || seen[email.id] < email.lastOpenedAt;
    }).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#14624D' });
    await chrome.action.setBadgeText({ text: unseen ? String(Math.min(unseen, 99)) : '' });
  } catch {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function handle(msg) {
  if (msg?.type === 'status') return { ok: true, relayOk: lastSyncOk, checkedAt: lastSyncAt };
  if (msg?.type === 'list') {
    await sync(Boolean(msg.force));
    await refreshBadge();
    return { ok: true, relayOk: lastSyncOk, checkedAt: lastSyncAt, emails: await listEmails() };
  }
  if (msg?.type === 'register') {
    await register(msg.payload);
    return { ok: true };
  }
  if (msg?.type === 'selfView') {
    await selfView(msg.ids);
    return { ok: true };
  }
  if (msg?.type === 'markSeen') {
    const seen = {};
    for (const email of msg.emails || []) {
      if (email.lastOpenedAt) seen[email.id] = email.lastOpenedAt;
    }
    await chrome.storage.local.set({ seen });
    await refreshBadge();
    return { ok: true };
  }
  if (msg?.type === 'openLog') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(chrome.runtime.getManifest().action.default_popup) });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown request.' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Something went wrong.' }));
  return true;
});

function schedule() {
  chrome.alarms.create('poll', { periodInMinutes: 1 });
  sync(true).then(refreshBadge);
}

async function importMigration() {
  const { migrated } = await chrome.storage.local.get({ migrated: false });
  if (migrated) return;
  let data;
  try {
    const response = await fetch(chrome.runtime.getURL('extension/migrate.json'));
    if (!response.ok) return;
    data = await response.json();
  } catch {
    return;
  }
  await serial(async () => {
    const stored = await chrome.storage.local.get({ emails: {}, accounts: null, guideDone: false, seen: {} });
    const emails = { ...(data.emails || {}), ...stored.emails };
    const accounts = new Set(stored.accounts || []);
    if (data.connectedEmail) accounts.add(data.connectedEmail);
    await chrome.storage.local.set({
      emails: prune(emails),
      accounts: [...accounts],
      guideDone: stored.guideDone || Boolean(data.guideDone),
      seen: { ...(data.seen || {}), ...stored.seen },
      migrated: true
    });
    await pushShared(emails);
  });
}

chrome.runtime.onInstalled.addListener(() => importMigration().finally(schedule));
chrome.runtime.onStartup.addListener(schedule);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !Object.keys(changes).some((key) => key.startsWith(SHARE_PREFIX))) return;
  serial(async () => {
    const emails = await pullShared(await loadEmails());
    await chrome.storage.local.set({ emails: prune(emails) });
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') sync(true).then(refreshBadge);
});
