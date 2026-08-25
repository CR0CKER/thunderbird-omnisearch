'use strict';
// Loads/saves OmniSearch settings, and hosts the index controls (Rebuild /
// Verify & repair) which talk to the background script over runtime messages.
(function () {
  const KEY = 'settings';
  const keepOpen = document.getElementById('keepOpen');
  const keepWarm = document.getElementById('keepWarm');
  const searchUIPopup = document.getElementById('searchUIPopup');
  const searchUISpotlight = document.getElementById('searchUISpotlight');
  const searchUITab = document.getElementById('searchUITab');
  const includeSpamTrash = document.getElementById('includeSpamTrash');
  const indexEncryptedBodies = document.getElementById('indexEncryptedBodies');
  const bodyIndexLimit = document.getElementById('bodyIndexLimit');
  const accountsEl = document.getElementById('accounts');
  const statusEl = document.getElementById('status');
  const progressEl = document.getElementById('progress');
  const rebuildBtn = document.getElementById('rebuild');
  const reconcileBtn = document.getElementById('reconcile');
  const clearBtn = document.getElementById('clear');
  const applyBanner = document.getElementById('applyBanner');
  const applyBannerText = document.getElementById('applyBannerText');
  const applyChangeBtn = document.getElementById('applyChange');

  function send(msg) {
    return messenger.runtime.sendMessage(msg);
  }

  // ---- "Apply changes" banner ----
  // Account / Junk-Trash changes apply incrementally via reconcile (only the
  // affected messages are added or removed — no full rebuild). The encrypted-
  // bodies toggle changes how existing messages are read, so it needs a rebuild.
  let pendingMode = null; // 'reconcile' | 'rebuild' | null
  function showBanner(mode) {
    if (pendingMode === 'rebuild' || mode === 'rebuild') pendingMode = 'rebuild';
    else pendingMode = 'reconcile';
    applyBannerText.textContent =
      pendingMode === 'rebuild'
        ? 'Indexing of encrypted message bodies changed — a full rebuild is needed to apply it.'
        : 'Indexing scope changed. Apply now to add/remove just the affected messages (no full rebuild).';
    applyChangeBtn.textContent = pendingMode === 'rebuild' ? 'Rebuild now' : 'Apply now';
    applyBanner.hidden = false;
  }
  function hideBanner() {
    applyBanner.hidden = true;
    pendingMode = null;
    applyChangeBtn.disabled = false;
  }

  // Resolves once a triggered rebuild has finished (or never started). reconcile
  // completes synchronously with its message reply, so this is only for rebuild.
  function waitUntilBuildDone() {
    return new Promise((resolve) => {
      let started = false;
      let ticks = 0;
      const tick = async () => {
        ticks++;
        let state = null;
        try {
          const reply = await send({ type: 'status' });
          if (reply && reply.type === 'status') state = reply.status.state;
        } catch (e) {
          /* ignore */
        }
        if (state === 'building') started = true;
        // Done when a started build leaves the building state, or if a build
        // never began within ~12s (no-op / failed).
        if ((started && state !== 'building') || (!started && ticks > 20)) return resolve();
        setTimeout(tick, 600);
      };
      tick();
    });
  }

  // ---- Settings ----
  async function getSettings() {
    const result = await messenger.storage.local.get(KEY);
    return result[KEY] || {};
  }

  async function loadSettings() {
    const settings = await getSettings();
    keepOpen.checked = !!settings.keepOpenAfterResult;
    keepWarm.checked = !!settings.keepWarm;
    searchUIPopup.checked = settings.searchUI === 'popup';
    searchUITab.checked = settings.searchUI === 'tab';
    searchUISpotlight.checked = !settings.searchUI || settings.searchUI === 'spotlight';
    includeSpamTrash.checked = !!settings.includeSpamTrash;
    indexEncryptedBodies.checked = !!settings.indexEncryptedBodies;
    bodyIndexLimit.value = String(settings.bodyIndexLimit || 4000);
  }

  keepOpen.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.keepOpenAfterResult = keepOpen.checked;
    await messenger.storage.local.set({ [KEY]: settings });
  });

  async function saveSearchUI() {
    const settings = await getSettings();
    if (searchUIPopup.checked) settings.searchUI = 'popup';
    else if (searchUITab.checked) settings.searchUI = 'tab';
    else settings.searchUI = 'spotlight';
    // The background watches storage.onChanged and flips the toolbar button /
    // shortcut between the anchored popup and the Spotlight/Tab modes itself.
    await messenger.storage.local.set({ [KEY]: settings });
  }
  searchUIPopup.addEventListener('change', saveSearchUI);
  searchUISpotlight.addEventListener('change', saveSearchUI);
  searchUITab.addEventListener('change', saveSearchUI);

  keepWarm.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.keepWarm = keepWarm.checked;
    // The background watches storage.onChanged and (de)registers the keepalive
    // alarm itself, so no extra message is needed.
    await messenger.storage.local.set({ [KEY]: settings });
  });

  includeSpamTrash.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.includeSpamTrash = includeSpamTrash.checked;
    await messenger.storage.local.set({ [KEY]: settings });
    showBanner('reconcile');
  });

  indexEncryptedBodies.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.indexEncryptedBodies = indexEncryptedBodies.checked;
    await messenger.storage.local.set({ [KEY]: settings });
    showBanner('rebuild');
  });

  bodyIndexLimit.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.bodyIndexLimit = parseInt(bodyIndexLimit.value, 10) || 4000;
    await messenger.storage.local.set({ [KEY]: settings });
    // Changes how much body text is extracted → needs a full rebuild to apply.
    showBanner('rebuild');
  });

  // ---- Accounts to index (opt-out: excluded ids are stored) ----
  async function setAccountIncluded(accountId, included) {
    const settings = await getSettings();
    const excluded = new Set(settings.excludedAccounts || []);
    if (included) excluded.delete(accountId);
    else excluded.add(accountId);
    settings.excludedAccounts = [...excluded];
    await messenger.storage.local.set({ [KEY]: settings });
  }

  async function loadAccounts() {
    const accounts = await messenger.accounts.list();
    const settings = await getSettings();
    const excluded = new Set(settings.excludedAccounts || []);
    accountsEl.textContent = '';
    if (!accounts.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = 'No accounts found.';
      accountsEl.appendChild(div);
      return;
    }
    for (const account of accounts) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !excluded.has(account.id);
      cb.addEventListener('change', async () => {
        await setAccountIncluded(account.id, cb.checked);
        showBanner('reconcile');
      });
      const span = document.createElement('span');
      span.textContent = account.type ? `${account.name} (${account.type})` : account.name;
      label.append(cb, span);
      accountsEl.appendChild(label);
    }
  }

  // ---- Index status + controls ----
  function renderStatus(s) {
    const building = s.state === 'building';
    progressEl.hidden = !building;
    rebuildBtn.disabled = building;
    reconcileBtn.disabled = building;
    clearBtn.disabled = building; // don't purge the engine out from under a running build

    if (building) {
      progressEl.value = s.progress || 0;
      const pct = Math.round((s.progress || 0) * 100);
      if (s.total) {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} / ${s.total.toLocaleString()} messages (${pct}%)`;
      } else {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} messages so far`;
      }
      return;
    }

    if (s.state === 'loading') {
      statusEl.textContent = 'Loading index…';
      return;
    }

    if (s.state === 'empty') {
      statusEl.textContent = 'No index yet — click Rebuild to index your mail.';
      return;
    }
    const parts = [`${s.count.toLocaleString()} messages indexed`];
    if (s.headerOnly > 0) {
      parts.push(`${s.headerOnly.toLocaleString()} header-only (body not downloaded — enable full offline sync to index them)`);
    }
    if (s.updatedAt) parts.push(`updated ${new Date(s.updatedAt).toLocaleString()}`);
    statusEl.textContent = parts.join(' · ');
    // Surface a save failure prominently — this is why the index re-builds every
    // session instead of loading from disk.
    if (s.saveError) {
      const warn = document.createElement('div');
      warn.style.cssText = 'margin-top:8px;color:#b3261e;font-weight:600';
      warn.textContent = `⚠ Index built but couldn't be saved (${s.saveError}). It will re-index next time.`;
      statusEl.appendChild(warn);
    }
  }

  async function refreshStatus() {
    const reply = await send({ type: 'status' });
    if (reply && reply.type === 'status') renderStatus(reply.status);
  }

  rebuildBtn.addEventListener('click', async () => {
    await send({ type: 'rebuild' });
    void refreshStatus();
  });

  reconcileBtn.addEventListener('click', async () => {
    reconcileBtn.disabled = true;
    statusEl.textContent = 'Verifying against your folders…';
    await send({ type: 'reconcile' });
    void refreshStatus();
  });

  // Destructive: purges the index from disk. Confirm first, since it also removes
  // any opted-in decrypted encrypted-mail bodies and leaves search empty until a
  // rebuild.
  clearBtn.addEventListener('click', async () => {
    const ok = confirm(
      'Clear the search index? This deletes it from disk (including the decrypted ' +
        'contents of any encrypted emails you opted to index). Search stays empty ' +
        'until you rebuild.',
    );
    if (!ok) return;
    clearBtn.disabled = true;
    rebuildBtn.disabled = true;
    reconcileBtn.disabled = true;
    statusEl.textContent = 'Clearing the index…';
    try {
      await send({ type: 'clear' });
    } finally {
      clearBtn.disabled = false;
      rebuildBtn.disabled = false;
      reconcileBtn.disabled = false;
      void refreshStatus();
    }
  });

  applyChangeBtn.addEventListener('click', async () => {
    const mode = pendingMode === 'rebuild' ? 'rebuild' : 'reconcile';
    // Keep the banner up while the change is applied; hide it on completion.
    applyChangeBtn.disabled = true;
    applyChangeBtn.textContent = mode === 'rebuild' ? 'Rebuilding…' : 'Applying…';
    rebuildBtn.disabled = true;
    reconcileBtn.disabled = true;
    statusEl.textContent = mode === 'rebuild' ? 'Rebuilding…' : 'Updating the index…';
    try {
      await send({ type: mode }); // reconcile resolves when done; rebuild returns immediately
      if (mode === 'rebuild') await waitUntilBuildDone();
    } finally {
      hideBanner();
      rebuildBtn.disabled = false;
      reconcileBtn.disabled = false;
      void refreshStatus();
    }
  });

  // Poll so progress advances live during a build.
  setInterval(() => void refreshStatus(), 1000);

  loadSettings();
  loadAccounts();
  refreshStatus();
})();
