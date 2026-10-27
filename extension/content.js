(() => {
  const RELAY = 'https://ntfy.sh';
  const PIXEL_RE = /ntfy\.sh\/snly([0-9a-f]{32})\b/i;
  const WAITING_PULSE_MS = 30 * 60 * 1000;
  const state = {
    relayOk: true,
    checkedAt: 0,
    lastArmId: '',
    lastArmAt: 0,
    lastWarnAt: 0,
    connectedEmail: '',
    signedInEmail: '',
    accountNote: ''
  };
  let panelOpen = false;
  let panel = null;
  let latestEmails = [];
  const timers = [];

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function shutDown() {
    timers.forEach(clearInterval);
    timers.length = 0;
  }

  function every(fn, ms) {
    timers.push(setInterval(() => {
      if (!alive()) {
        shutDown();
        return;
      }
      fn();
    }, ms));
  }

  function send(message, callback = () => {}) {
    if (!alive()) {
      shutDown();
      callback(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        callback(chrome.runtime.lastError ? null : response);
      });
    } catch {
      shutDown();
      callback(null);
    }
  }

  function stripMarks(value) {
    return String(value || '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  }

  function isMessageBody(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute('contenteditable') !== 'true') return false;
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('message body') || (el.getAttribute('g_editable') === 'true' && label.includes('body'));
  }

  function messageBodies(root) {
    return [...root.querySelectorAll('div[contenteditable="true"]')].filter(isMessageBody);
  }

  function composeRootFrom(anchor) {
    const el = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (!el?.closest) return null;
    const classic = el.closest('div.M9');
    if (classic && messageBodies(classic).length === 1) return classic;
    const dialog = el.closest('[role="dialog"]');
    if (dialog && messageBodies(dialog).length === 1) return dialog;
    let node = el;
    while (node && node !== document.documentElement) {
      const bodies = messageBodies(node);
      if (bodies.length > 1) return null;
      const hasFields = node.querySelector('[name="to"], [name="cc"], [name="bcc"], [name="subjectbox"]');
      if (bodies.length === 1 && hasFields) return node;
      node = node.parentElement;
    }
    return null;
  }

  function isSendButton(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    if (!el?.closest) return null;
    const btn = el.closest('div[role="button"], button');
    if (!btn) return null;
    const label = stripMarks(`${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-tooltip') || ''} ${btn.innerText || ''}`)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!/^send\b/.test(label)) return null;
    if (/(schedule|later|feedback|option|undo|reaction)/.test(label)) return null;
    return btn;
  }

  function addPerson(people, seen, email, name) {
    const clean = String(email || '').trim();
    if (!clean.includes('@') || clean.length > 320 || /\s/.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const label = String(name || '').replace(/\s+/g, ' ').trim();
    people.push({
      email: clean,
      name: label && label.toLowerCase() !== key && !label.includes('@') ? label.slice(0, 200) : ''
    });
  }

  function readRecipients(root) {
    const people = [];
    const seen = new Set();
    const fields = [...root.querySelectorAll('[name="to"], [name="cc"], [name="bcc"]')];
    const scopes = [];
    for (const field of fields) {
      let node = field;
      for (let i = 0; i < 6 && node.parentElement; i += 1) {
        node = node.parentElement;
        if (node.querySelector('[email]')) break;
      }
      scopes.push(node);
    }
    const searchIn = scopes.length ? scopes : [root];
    for (const scope of searchIn) {
      scope.querySelectorAll('[email], [data-hovercard-id], [data-email]').forEach((el) => {
        const email = el.getAttribute('email') || el.getAttribute('data-hovercard-id') || el.getAttribute('data-email');
        const nameEl = [...el.querySelectorAll('span')].find((span) => !span.querySelector('*'));
        addPerson(people, seen, email, nameEl?.textContent || el.getAttribute('data-name') || '');
      });
      scope.querySelectorAll('textarea, input').forEach((input) => {
        const fieldName = input.getAttribute('name');
        if (!['to', 'cc', 'bcc'].includes(fieldName)) return;
        String(input.value || '').split(/[,;]/).forEach((part) => addPerson(people, seen, part, ''));
      });
    }
    if (!people.length && state.connectedEmail) {
      const meChip = [...root.querySelectorAll('span, div')].find((el) => {
        if (el.children.length) return false;
        return /^me$/i.test((el.textContent || '').trim());
      });
      if (meChip) addPerson(people, seen, state.connectedEmail, 'Me');
    }
    return people.slice(0, 50);
  }

  function readSubject(root) {
    const input = root.querySelector('input[name="subjectbox"], input[name="subject"]');
    return (input?.value || '').trim().slice(0, 500);
  }

  function pixelId(src) {
    const hex = String(src || '').match(PIXEL_RE)?.[1]?.toLowerCase();
    if (!hex) return '';
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function findPixel(body) {
    const imgs = [...body.querySelectorAll('img')];
    const fresh = imgs.find((img) => img.hasAttribute('data-open-tracker'));
    if (fresh) return fresh;
    const sentIds = new Set(latestEmails.map((email) => email.id));
    return imgs.find((img) => {
      const id = pixelId(img.getAttribute('src'));
      return id && !sentIds.has(id);
    }) || null;
  }

  function pixelSrc(id) {
    return `${RELAY}/snly${id.replace(/-/g, '')}/publish?message=o`;
  }

  function insertPixel(body, id) {
    const existing = findPixel(body);
    if (existing) return existing;
    const img = document.createElement('img');
    img.src = pixelSrc(id);
    img.width = 1;
    img.height = 1;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.setAttribute('data-open-tracker', id);
    img.style.cssText = 'width:1px;height:1px;border:0;outline:none;';
    try {
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      range.insertNode(img);
    } catch {
      body.appendChild(img);
    }
    return img;
  }

  function toast(text) {
    if (!document.documentElement) return;
    let host = document.querySelector('[data-open-tracker-toast]');
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-open-tracker-toast', '1');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          div {
            font: 13px/1.4 "Segoe UI", sans-serif;
            background: #1d2823;
            color: #f7fffb;
            border-radius: 999px;
            padding: 10px 14px;
            box-shadow: 0 10px 30px rgba(0,0,0,.2);
            max-width: 420px;
          }
        </style>
        <div id="msg"></div>
      `;
      document.documentElement.appendChild(host);
    }
    host.shadowRoot.querySelector('#msg').textContent = text;
    host.style.display = 'block';
    clearTimeout(host._hide);
    host._hide = setTimeout(() => {
      host.style.display = 'none';
    }, 4200);
  }

  function warn(text) {
    const now = Date.now();
    if (now - state.lastWarnAt < 2500) return;
    state.lastWarnAt = now;
    toast(text);
  }

  function arm(anchor) {
    const root = composeRootFrom(anchor);
    if (!root) return;
    const body = messageBodies(root)[0];
    if (!body) return;
    if (!state.connectedEmail) {
      warn(state.accountNote || 'Connect this Gmail account from the Seenly icon first.');
      return;
    }
    const pixel = findPixel(body);
    const id = pixel?.getAttribute('data-open-tracker') || pixelId(pixel?.getAttribute('src'));
    if (!id) {
      warn('Seenly could not add its image to this mail, so it will send without a tick.');
      return;
    }
    const now = Date.now();
    if (state.lastArmId === id && now - state.lastArmAt < 800) return;
    state.lastArmId = id;
    state.lastArmAt = now;
    const recipients = readRecipients(root);
    const payload = {
      id,
      from: state.connectedEmail,
      subject: readSubject(root),
      recipients,
      snippet: (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180)
    };
    console.info('[Seenly]', payload.subject || '(no subject)', recipients.map((person) => person.email));
    send({ type: 'register', payload }, (response) => {
      if (!response?.ok) {
        toast('Seenly could not save this mail, so its tick may not appear.');
        return;
      }
      const who = recipients.length === 1
        ? recipients[0].email
        : recipients.length > 1
          ? `${recipients.length} recipients`
          : 'this mail';
      toast(`Tracking whether ${who} saw this`);
    });
  }

  document.addEventListener('mousedown', (event) => {
    const button = isSendButton(event.target);
    if (button) arm(button);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.repeat) return;
    const button = isSendButton(event.target);
    if (button) {
      arm(button);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (isMessageBody(document.activeElement)) arm(document.activeElement);
  }, true);

  function stampOpenComposes() {
    if (!state.connectedEmail) return;
    document.querySelectorAll('div[contenteditable="true"]').forEach((body) => {
      if (!isMessageBody(body) || findPixel(body)) return;
      insertPixel(body, crypto.randomUUID());
    });
  }

  every(stampOpenComposes, 1000);

  const reportedAt = new Map();
  function reportSelfViews() {
    if (!state.connectedEmail || state.signedInEmail !== state.connectedEmail) return;
    const known = new Set(latestEmails.map((email) => email.id));
    const now = Date.now();
    const ids = [];
    for (const img of document.images) {
      const id = pixelId(img.currentSrc || img.src);
      if (!id || !known.has(id)) continue;
      if (now - (reportedAt.get(id) || 0) < 60_000) continue;
      reportedAt.set(id, now);
      ids.push(id);
    }
    if (ids.length) send({ type: 'selfView', ids });
  }

  every(reportSelfViews, 1000);

  function peopleLabel(recipients) {
    if (!recipients?.length) return 'Recipient not detected';
    if (recipients.length === 1) return recipients[0].name || recipients[0].email;
    return `${recipients[0].email} + ${recipients.length - 1}`;
  }

  function ago(ts) {
    const minutes = Math.round((Date.now() - ts) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  function ensurePanel() {
    if (panel || !inTopFrame() || !document.documentElement) return;
    const host = document.createElement('div');
    host.setAttribute('data-open-tracker-panel', '1');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:16px;bottom:16px;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .wrap { font: 13px/1.4 "Segoe UI", sans-serif; color: #1d2823; }
        .toggle, .body { pointer-events: auto; }
        button { font: inherit; cursor: pointer; }
        .toggle {
          border: 0;
          background: #14624d;
          color: #f7fffb;
          border-radius: 999px;
          padding: 8px 12px;
          font-weight: 700;
          box-shadow: 0 8px 24px rgba(20, 50, 40, .2);
        }
        .body {
          margin-top: 8px;
          background: #fffaf3;
          border: 1px solid #e2d9cb;
          border-radius: 14px;
          padding: 10px;
          box-shadow: 0 16px 40px rgba(58, 44, 24, .12);
          width: 280px;
          max-height: 320px;
          overflow: auto;
        }
        .warn { color: #8a5a12; margin: 0 0 8px; }
        .row { padding: 7px 0; border-top: 1px solid #e2d9cb; }
        .row:first-child { border-top: 0; }
        .who { font-weight: 700; }
        .meta { color: #6e675d; }
        .link {
          border: 0;
          background: transparent;
          color: #14624d;
          padding: 8px 0 0;
          font-weight: 700;
        }
        .empty { color: #6e675d; margin: 0; }
        .live { display: flex; gap: 8px; align-items: center; color: #6e675d; font-size: 12px; margin: 0 0 8px; }
        .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #14624d; animation: pulse 1.6s ease-out infinite; }
        .live[hidden] { display: none; }
        .live.paused .dot { background: #8a5a12; animation: none; }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(20, 98, 77, .45); }
          100% { box-shadow: 0 0 0 7px rgba(20, 98, 77, 0); }
        }
      </style>
      <div class="wrap">
        <button class="toggle" id="toggle" type="button">Opens</button>
        <div class="body" id="body" hidden>
          <p class="live" id="live"><span class="dot"></span><span id="live-text">Watching for opens</span></p>
          <p class="warn" id="warning" hidden></p>
          <div id="list"></div>
          <button class="link" id="open-log" type="button">How to use</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);
    panel = {
      toggle: shadow.querySelector('#toggle'),
      body: shadow.querySelector('#body'),
      warning: shadow.querySelector('#warning'),
      live: shadow.querySelector('#live'),
      liveText: shadow.querySelector('#live-text'),
      list: shadow.querySelector('#list'),
      openLog: shadow.querySelector('#open-log')
    };
    panel.toggle.addEventListener('click', () => {
      panelOpen = !panelOpen;
      panel.body.hidden = !panelOpen;
    });
    panel.openLog.addEventListener('click', () => {
      send({ type: 'openLog' });
    });
  }

  function renderLive() {
    if (!panel) return;
    panel.live.hidden = !state.connectedEmail;
    panel.live.classList.toggle('paused', !state.relayOk);
    if (!state.relayOk) {
      panel.liveText.textContent = 'Paused · trying again';
      return;
    }
    const seconds = state.checkedAt ? Math.max(0, Math.round((Date.now() - state.checkedAt) / 1000)) : null;
    const checked = seconds === null ? '' : seconds < 5 ? ' · checked just now' : seconds < 60
      ? ` · checked ${seconds} s ago` : ` · checked ${Math.round(seconds / 60)} min ago`;
    panel.liveText.textContent = `Watching for opens${checked}. ✓✓ shows up within about a minute.`;
  }

  function renderPanel() {
    ensurePanel();
    if (!panel) return;
    renderLive();
    const opened = latestEmails.filter((email) => email.viewCount).length;
    panel.toggle.textContent = opened ? `Seenly · ${opened}` : 'Seenly';
    panel.body.hidden = !panelOpen;
    if (!state.connectedEmail) {
      panel.warning.hidden = false;
      panel.warning.textContent = state.accountNote || 'Connect this Gmail account from the Seenly icon.';
    } else if (!state.relayOk) {
      panel.warning.hidden = false;
      panel.warning.textContent = 'Seenly cannot reach its tracking service right now. Ticks will update when it can.';
    } else {
      panel.warning.hidden = true;
    }
    panel.list.replaceChildren();
    const rows = latestEmails
      .filter((email) => !state.connectedEmail || !email.from || email.from === state.connectedEmail)
      .slice(0, 8);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No tracked mail yet.';
      panel.list.append(empty);
      return;
    }
    for (const email of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = peopleLabel(email.recipients);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = email.viewCount
        ? `${email.subject || '(no subject)'} · saw it ${ago(email.lastOpenedAt)}`
        : `${email.subject || '(no subject)'} · waiting for them to open`;
      row.append(who, meta);
      panel.list.append(row);
    }
    paintRows();
  }

  function rowSubject(row) {
    const el = row.querySelector('span.bog, span.bqe');
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.y2').forEach((node) => node.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function trackedForRow(row) {
    const subject = rowSubject(row);
    if (!subject) return null;
    return latestEmails.find((email) => {
      if (state.connectedEmail && email.from && email.from !== state.connectedEmail) return false;
      return (email.subject || '').trim().toLowerCase() === subject;
    }) || null;
  }

  function ensureMarkStyles() {
    if (document.getElementById('seenly-mark-styles') || !document.head) return;
    const style = document.createElement('style');
    style.id = 'seenly-mark-styles';
    style.textContent = `
      [data-seenly-mark] { display:inline-block; margin-left:6px; font:700 14px/1 "Segoe UI",sans-serif; vertical-align:middle; cursor:default; }
      [data-seenly-mark][data-mode="sent"] { color:#80868b; }
      [data-seenly-mark][data-mode="waiting"] { color:#80868b; animation:seenly-wait 1.8s ease-in-out infinite; }
      [data-seenly-mark][data-mode="seen"] { color:#14624d; letter-spacing:-2px; }
      [data-seenly-mark].seenly-pop { animation:seenly-pop .5s ease-out; }
      @keyframes seenly-wait { 0%,100% { opacity:1; } 50% { opacity:.35; } }
      @keyframes seenly-pop { 0% { transform:scale(.4); opacity:0; } 60% { transform:scale(1.35); opacity:1; } 100% { transform:scale(1); } }
    `;
    document.head.appendChild(style);
  }

  function markTitle(email) {
    if (email.viewCount) {
      const times = email.viewCount === 1 ? 'once' : `${email.viewCount} times`;
      return `Saw it ${times} · last ${ago(email.lastOpenedAt)}`;
    }
    return `Sent ${ago(email.createdAt)} · ✓✓ shows up within about a minute after they open it`;
  }

  function paintRows() {
    if (!inTopFrame()) return;
    ensureMarkStyles();
    document.querySelectorAll('tr.zA').forEach((row) => {
      const email = trackedForRow(row);
      const existing = row.querySelector('[data-seenly-mark]');
      if (!email) {
        existing?.remove();
        return;
      }
      const seen = email.viewCount > 0;
      const recent = Date.now() - (email.createdAt || 0) < WAITING_PULSE_MS;
      const mode = seen ? 'seen' : recent ? 'waiting' : 'sent';
      let mark = existing;
      if (!mark) {
        mark = document.createElement('span');
        mark.setAttribute('data-seenly-mark', '1');
        const name = row.querySelector('span.yP, span.zF, .yW span[email]');
        if (name) name.insertAdjacentElement('afterend', mark);
        else row.querySelector('.yW, td')?.appendChild(mark);
      }
      const title = markTitle(email);
      if (mark.title !== title) {
        mark.title = title;
        mark.setAttribute('aria-label', title);
      }
      if (mark.dataset.mode === mode) return;
      const turnedSeen = seen && mark.dataset.mode && mark.dataset.mode !== 'seen';
      mark.dataset.mode = mode;
      mark.textContent = seen ? '✓✓' : '✓';
      if (turnedSeen) {
        mark.classList.add('seenly-pop');
        setTimeout(() => mark.classList.remove('seenly-pop'), 600);
      }
    });
  }

  function ensureListObserver() {
    if (!inTopFrame()) return;
    const root = document.querySelector('div[role="main"]');
    if (!root || ensureListObserver.root === root) return;
    ensureListObserver.observer?.disconnect();
    let timer;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(paintRows, 200);
    });
    observer.observe(root, { childList: true, subtree: true });
    ensureListObserver.observer = observer;
    ensureListObserver.root = root;
  }

  function applyStatus(response) {
    if (!response) return;
    state.relayOk = response.relayOk !== false;
    if (response.checkedAt) state.checkedAt = response.checkedAt;
    if (response.emails) latestEmails = response.emails;
    renderPanel();
  }

  function inTopFrame() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  function refresh() {
    const type = inTopFrame() ? 'list' : 'status';
    send({ type }, (response) => {
      if (!response || response.ok === false) return;
      applyStatus(response);
    });
  }

  function readSignedInEmail() {
    const pattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const nodes = document.querySelectorAll('a[aria-label], div[aria-label], img[alt]');
    for (const node of nodes) {
      const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('alt') || ''}`;
      if (!/google account|@/i.test(label)) continue;
      const found = label.match(pattern);
      if (found) return found[found.length - 1].toLowerCase();
    }
    return '';
  }

  function syncAccount() {
    if (!inTopFrame()) return;
    const email = readSignedInEmail();
    state.signedInEmail = email;
    if (!alive()) return;
    chrome.storage.local.get({ awaitingConnect: false, connectedEmail: '' }, (data) => {
      if (chrome.runtime.lastError || !data) return;
      if (data.awaitingConnect && email) {
        state.connectedEmail = email;
        chrome.storage.local.set({
          connectedEmail: email,
          awaitingConnect: false,
          connectedAt: Date.now()
        });
        toast(`Connected as ${email}`);
        renderPanel();
        return;
      }
      if (!data.connectedEmail) {
        state.connectedEmail = '';
        state.accountNote = '';
        return;
      }
      if (email && email !== data.connectedEmail) {
        state.connectedEmail = '';
        state.accountNote = `This Gmail is ${email}. The extension is connected to ${data.connectedEmail}.`;
        return;
      }
      state.accountNote = '';
      state.connectedEmail = data.connectedEmail;
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.connectedEmail) {
      state.connectedEmail = changes.connectedEmail.newValue || '';
    }
    renderPanel();
  });

  syncAccount();
  every(syncAccount, 2000);

  every(() => {
    ensureListObserver();
    paintRows();
    renderLive();
  }, 2000);

  refresh();
  every(refresh, 5000);
})();
