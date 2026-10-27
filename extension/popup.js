const appEl = document.querySelector('#app');
const guideEl = document.querySelector('#guide');
const guideBtn = document.querySelector('#guide-btn');
let guideForced = false;

const statusEl = document.querySelector('#status');
const warningEl = document.querySelector('#warning');
const legendEl = document.querySelector('#legend');
const connectEl = document.querySelector('#connect');
const accountEl = document.querySelector('#account');
const accountListEl = document.querySelector('#account-list');
const liveEl = document.querySelector('#live');
const liveTitleEl = document.querySelector('#live-title');
let checkedAt = 0;
let relayOk = true;

function renderLive() {
  if (liveEl.hidden) return;
  liveEl.classList.toggle('paused', !relayOk);
  if (!relayOk) {
    liveTitleEl.textContent = 'Paused · trying again';
    return;
  }
  const seconds = checkedAt ? Math.max(0, Math.round((Date.now() - checkedAt) / 1000)) : null;
  if (seconds === null) liveTitleEl.textContent = 'Watching for opens';
  else if (seconds < 5) liveTitleEl.textContent = 'Watching for opens · checked just now';
  else if (seconds < 60) liveTitleEl.textContent = `Watching for opens · checked ${seconds} s ago`;
  else liveTitleEl.textContent = `Watching for opens · checked ${Math.round(seconds / 60)} min ago`;
}

function ask(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: 'Reload the extension, then try again.' });
        return;
      }
      resolve(response || { ok: false, error: 'No answer from the tracker.' });
    });
  });
}

function storageGet(defaults) {
  return chrome.storage.local.get(defaults);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function showGuide() {
  guideEl.hidden = false;
  appEl.hidden = true;
  guideBtn.textContent = guideForced ? 'Back' : 'Guide';
}

function hideGuide() {
  guideEl.hidden = true;
  appEl.hidden = false;
  guideBtn.textContent = 'Guide';
}

function showDisconnected(waiting) {
  connectEl.hidden = false;
  accountEl.hidden = true;
  legendEl.hidden = true;
  liveEl.hidden = true;
  warningEl.hidden = true;
  statusEl.textContent = waiting
    ? 'Waiting for Gmail. Sign in if it asks. This popup connects when that account appears.'
    : 'Connect the Gmail account you send from.';
}

function accountList(data) {
  if (Array.isArray(data.accounts)) return data.accounts;
  return data.connectedEmail ? [data.connectedEmail] : [];
}

function renderAccounts(accounts) {
  accountListEl.replaceChildren();
  for (const email of accounts) {
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = email;
    name.title = email;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'disconnect';
    remove.textContent = 'Disconnect';
    remove.addEventListener('click', async () => {
      const current = accountList(await storageGet({ accounts: null, connectedEmail: '' }));
      await storageSet({ accounts: current.filter((other) => other !== email), connectedEmail: '' });
    });
    item.append(name, remove);
    accountListEl.append(item);
  }
}

async function refresh() {
  const stored = await storageGet({ accounts: null, connectedEmail: '', awaitingConnect: false, guideDone: false });
  if (!stored.guideDone || guideForced) {
    showGuide();
    return;
  }
  hideGuide();
  const accounts = accountList(stored);
  if (!accounts.length) {
    showDisconnected(stored.awaitingConnect);
    return;
  }

  connectEl.hidden = true;
  accountEl.hidden = false;
  legendEl.hidden = false;
  liveEl.hidden = false;
  renderAccounts(accounts);
  statusEl.textContent = `Watching mail sent from ${accounts.join(', ')}`;
  renderLive();

  const data = await ask({ type: 'list', force: true });
  if (!data.ok) {
    liveEl.hidden = true;
    warningEl.hidden = false;
    warningEl.textContent = 'Reload Seenly at chrome://extensions, then open this again.';
    return;
  }
  checkedAt = data.checkedAt || 0;
  relayOk = data.relayOk !== false;
  renderLive();
  if (!data.relayOk) {
    warningEl.hidden = false;
    warningEl.textContent = 'Seenly cannot reach its tracking service right now. Ticks will update when it can.';
  } else {
    warningEl.hidden = true;
  }
  const mine = (data.emails || []).filter((email) => !email.from || accounts.includes(email.from));
  await ask({ type: 'markSeen', emails: mine });
}

document.querySelector('#guide-done').addEventListener('click', async () => {
  guideForced = false;
  await storageSet({ guideDone: true });
  await refresh();
});

guideBtn.addEventListener('click', async () => {
  if (!guideEl.hidden) {
    const stored = await storageGet({ guideDone: false });
    if (!stored.guideDone) return;
    guideForced = false;
    await refresh();
    return;
  }
  guideForced = true;
  showGuide();
});

document.querySelector('#connect-btn').addEventListener('click', async () => {
  await storageSet({ awaitingConnect: true });
  await chrome.tabs.create({ url: 'https://mail.google.com/' });
  showDisconnected(true);
});

document.querySelector('#open-log').addEventListener('click', () => {
  guideForced = true;
  showGuide();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.accounts || changes.connectedEmail || changes.awaitingConnect)) refresh();
});

refresh();
setInterval(refresh, 15000);
setInterval(renderLive, 1000);
