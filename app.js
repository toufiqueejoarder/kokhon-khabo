(function () {
  'use strict';

  const APP_VERSION = 'v1.0.0';
  const STORE_KEY = 'kokhon_khabo_data';
  const NOTIF_CHECK_INTERVAL = 60000; // 1 minute

  // ── State ──────────────────────────────────────────────
  let state = {
    medicines: [],
    doseHistory: {},
    notifDismissed: false,
  };

  let currentMedId = null;
  let editingMedId = null;
  let checkInterval = null;

  // ── DOM Refs ───────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const viewList = $('#view-list');
  const viewForm = $('#view-form');
  const viewDetail = $('#view-detail');
  const medList = $('#medicine-list');
  const emptyState = $('#empty-state');
  const form = $('#medicine-form');
  const formTitle = $('#form-title');
  const btnAdd = $('#btn-add');
  const btnSave = $('#btn-save');
  const btnCancelForm = $('#btn-cancel-form');
  const btnEdit = $('#btn-edit');
  const btnDelete = $('#btn-delete');
  const notifBanner = $('#notif-banner');
  const btnEnableNotif = $('#btn-enable-notif');
  const btnDismissNotif = $('#btn-dismiss-notif');

  const inputName = $('#med-name');
  const inputNotes = $('#med-notes');
  const inputHours = $('#med-hours');
  const inputMinutes = $('#med-minutes');
  const inputDuration = $('#med-duration');
  const inputStart = $('#med-start');

  // ── Persistence ────────────────────────────────────────
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save state', e);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.medicines = parsed.medicines || [];
        state.doseHistory = parsed.doseHistory || {};
        state.notifDismissed = parsed.notifDismissed || false;
      }
    } catch (e) {
      console.warn('Failed to load state', e);
    }
  }

  // ── Utilities ──────────────────────────────────────────
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatInterval(hours, minutes) {
    const parts = [];
    if (hours > 0) parts.push(hours + 'h');
    if (minutes > 0) parts.push(minutes + 'm');
    return parts.length ? parts.join(' ') : '0m';
  }

  function intervalMs(hours, minutes) {
    return (hours * 60 + minutes) * 60 * 1000;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(ts) {
    return formatDate(ts) + ', ' + formatTime(ts);
  }

  function toLocalISOString(date) {
    const d = date || new Date();
    const offset = d.getTimezoneOffset();
    const local = new Date(d.getTime() - offset * 60 * 1000);
    return local.toISOString().slice(0, 16);
  }

  function getMedEndTime(med) {
    return med.startTime + med.durationDays * 24 * 60 * 60 * 1000;
  }

  function isMedActive(med) {
    return Date.now() < getMedEndTime(med);
  }

  // ── Dose Schedule Computation ──────────────────────────
  function getScheduledDoses(med, opts = {}) {
    const doses = [];
    const intMs = intervalMs(med.intervalHours, med.intervalMinutes);
    if (intMs <= 0) return doses;

    const endTime = getMedEndTime(med);
    const limit = opts.limit || 500;
    const afterTime = opts.after || 0;

    let t = med.startTime;
    while (t < endTime && doses.length < limit) {
      if (t >= afterTime) {
        doses.push(t);
      }
      t += intMs;
    }
    return doses;
  }

  function getUpcomingDoses(med, count) {
    const now = Date.now();
    const intMs = intervalMs(med.intervalHours, med.intervalMinutes);
    if (intMs <= 0) return [];

    const endTime = getMedEndTime(med);
    const doses = [];

    let t = med.startTime;
    while (t <= now && t < endTime) {
      t += intMs;
    }
    while (t < endTime && doses.length < count) {
      doses.push(t);
      t += intMs;
    }
    return doses;
  }

  function getPastDoses(med) {
    const now = Date.now();
    return getScheduledDoses(med, { limit: 1000 }).filter(t => t <= now);
  }

  function getDoseStatus(medId, doseTime) {
    const history = state.doseHistory[medId];
    if (!history) return null;
    return history.find(h => h.time === doseTime) || null;
  }

  function setDoseStatus(medId, doseTime, status) {
    if (!state.doseHistory[medId]) {
      state.doseHistory[medId] = [];
    }
    const existing = state.doseHistory[medId].find(h => h.time === doseTime);
    if (existing) {
      existing.status = status;
      existing.recordedAt = Date.now();
    } else {
      state.doseHistory[medId].push({
        time: doseTime,
        status: status,
        recordedAt: Date.now(),
      });
    }
    save();
  }

  // Auto-mark missed doses (past doses with no status logged)
  function autoMarkMissed() {
    const now = Date.now();
    const graceMs = 30 * 60 * 1000; // 30 min grace period
    state.medicines.forEach(med => {
      const pastDoses = getPastDoses(med);
      pastDoses.forEach(doseTime => {
        if (now - doseTime > graceMs) {
          const record = getDoseStatus(med.id, doseTime);
          if (!record) {
            setDoseStatus(med.id, doseTime, 'missed');
          }
        }
      });
    });
  }

  // ── Notifications ──────────────────────────────────────
  function notifSupported() {
    return 'Notification' in window;
  }

  function notifGranted() {
    return notifSupported() && Notification.permission === 'granted';
  }

  async function requestNotifPermission() {
    if (!notifSupported()) return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  function showNotification(title, body) {
    if (!notifGranted()) return;

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, {
          body: body,
          icon: 'icons/icon-192.png',
          badge: 'icons/icon-192.png',
          tag: title + '-' + Date.now(),
          requireInteraction: true,
          vibrate: [200, 100, 200],
        });
      });
    } else if (notifGranted()) {
      new Notification(title, { body: body });
    }
  }

  // Pre-scheduled notification check — runs every minute
  function checkNotifications() {
    const now = Date.now();
    const windowMs = NOTIF_CHECK_INTERVAL + 5000;

    state.medicines.forEach(med => {
      if (!isMedActive(med)) return;

      const intMs = intervalMs(med.intervalHours, med.intervalMinutes);
      if (intMs <= 0) return;

      const endTime = getMedEndTime(med);
      let t = med.startTime;

      while (t < endTime) {
        if (t > now - windowMs && t <= now) {
          const key = `notif_${med.id}_${t}`;
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, '1');
            const notes = med.notes ? ` — ${med.notes}` : '';
            showNotification('কখন খাবো', `Time to take ${med.name}${notes}`);
          }
        }
        if (t > now) break;
        t += intMs;
      }
    });
  }

  function startNotifChecker() {
    if (checkInterval) clearInterval(checkInterval);
    checkNotifications();
    checkInterval = setInterval(checkNotifications, NOTIF_CHECK_INTERVAL);
  }

  function updateNotifBanner() {
    if (!notifSupported() || notifGranted() || state.notifDismissed) {
      notifBanner.classList.add('hidden');
    } else {
      notifBanner.classList.remove('hidden');
    }
  }

  // ── Service Worker Registration ────────────────────────
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    }
  }

  // ── Navigation ─────────────────────────────────────────
  function showView(view) {
    viewList.style.display = view === viewList ? '' : 'none';
    viewForm.classList.toggle('hidden', view !== viewForm);
    viewDetail.classList.toggle('hidden', view !== viewDetail);

    if (view === viewList) {
      btnAdd.style.display = '';
      $('#header').style.display = '';
      $('#version').style.display = '';
    } else {
      btnAdd.style.display = 'none';
      $('#header').style.display = 'none';
      $('#version').style.display = 'none';
    }
  }

  // ── Render Medicine List ───────────────────────────────
  function renderList() {
    medList.innerHTML = '';
    const meds = state.medicines;

    if (meds.length === 0) {
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';

    meds.forEach(med => {
      const li = document.createElement('li');
      li.className = 'med-card';
      li.setAttribute('data-id', med.id);

      const active = isMedActive(med);
      let nextDoseText = '';
      if (active) {
        const upcoming = getUpcomingDoses(med, 1);
        if (upcoming.length > 0) {
          nextDoseText = 'Next: ' + formatTime(upcoming[0]);
        }
      }

      li.innerHTML = `
        <div class="med-card-info">
          <div class="med-card-name">${escHtml(med.name)}</div>
          <div class="med-card-meta">
            Every ${formatInterval(med.intervalHours, med.intervalMinutes)}
            ${nextDoseText ? ' · ' + nextDoseText : ''}
          </div>
        </div>
        <span class="med-card-status ${active ? 'status-active' : 'status-ended'}">
          ${active ? 'Active' : 'Ended'}
        </span>
      `;

      li.addEventListener('click', () => openDetail(med.id));
      medList.appendChild(li);
    });
  }

  function escHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ── Add / Edit Form ────────────────────────────────────
  function openAddForm() {
    editingMedId = null;
    formTitle.textContent = 'Add Medicine';
    btnSave.textContent = 'Save';
    form.reset();
    inputHours.value = '8';
    inputMinutes.value = '0';
    inputDuration.value = '7';
    inputStart.value = toLocalISOString(new Date());
    showView(viewForm);
  }

  function openEditForm(medId) {
    const med = state.medicines.find(m => m.id === medId);
    if (!med) return;

    editingMedId = medId;
    formTitle.textContent = 'Edit Medicine';
    btnSave.textContent = 'Update';
    inputName.value = med.name;
    inputNotes.value = med.notes || '';
    inputHours.value = med.intervalHours;
    inputMinutes.value = med.intervalMinutes;
    inputDuration.value = med.durationDays;
    inputStart.value = toLocalISOString(new Date(med.startTime));
    showView(viewForm);
  }

  function handleFormSubmit(e) {
    e.preventDefault();

    const name = inputName.value.trim();
    const notes = inputNotes.value.trim();
    const hours = parseInt(inputHours.value, 10) || 0;
    const minutes = parseInt(inputMinutes.value, 10) || 0;
    const duration = parseInt(inputDuration.value, 10) || 1;
    const startTime = new Date(inputStart.value).getTime();

    if (!name) return;
    if (hours === 0 && minutes === 0) {
      alert('Interval must be at least 1 minute.');
      return;
    }
    if (isNaN(startTime)) {
      alert('Please set a valid start date and time.');
      return;
    }

    if (editingMedId) {
      const med = state.medicines.find(m => m.id === editingMedId);
      if (med) {
        med.name = name;
        med.notes = notes;
        med.intervalHours = hours;
        med.intervalMinutes = minutes;
        med.durationDays = duration;
        med.startTime = startTime;
      }
    } else {
      state.medicines.push({
        id: uid(),
        name,
        notes,
        intervalHours: hours,
        intervalMinutes: minutes,
        durationDays: duration,
        startTime,
        createdAt: Date.now(),
      });
    }

    save();
    renderList();
    showView(viewList);
  }

  // ── Medicine Detail ────────────────────────────────────
  function openDetail(medId) {
    const med = state.medicines.find(m => m.id === medId);
    if (!med) return;

    currentMedId = medId;
    autoMarkMissed();

    $('#detail-name').textContent = med.name;
    $('#detail-interval').textContent = 'Every ' + formatInterval(med.intervalHours, med.intervalMinutes);
    $('#detail-duration').textContent = med.durationDays + ' day' + (med.durationDays !== 1 ? 's' : '');
    $('#detail-start').textContent = formatDateTime(med.startTime);
    $('#detail-end').textContent = formatDateTime(getMedEndTime(med));

    const active = isMedActive(med);
    const statusEl = $('#detail-status');
    statusEl.textContent = active ? 'Active' : 'Ended';
    statusEl.className = active ? 'status-active' : 'status-ended';

    const nextRow = $('#detail-next-row');
    const nextEl = $('#detail-next');
    if (active) {
      const upcoming = getUpcomingDoses(med, 1);
      if (upcoming.length > 0) {
        nextEl.textContent = formatDateTime(upcoming[0]);
        nextRow.style.display = '';
      } else {
        nextRow.style.display = 'none';
      }
    } else {
      nextRow.style.display = 'none';
    }

    renderUpcomingDoses(med);
    renderDoseHistory(med);
    showView(viewDetail);
  }

  function renderUpcomingDoses(med) {
    const list = $('#upcoming-doses');
    list.innerHTML = '';

    if (!isMedActive(med)) {
      list.innerHTML = '<li class="no-data">Reminders have ended.</li>';
      return;
    }

    const now = Date.now();
    const intMs = intervalMs(med.intervalHours, med.intervalMinutes);
    const endTime = getMedEndTime(med);

    // Find the current/most recent dose that may still need action
    let t = med.startTime;
    let currentDose = null;
    while (t < endTime) {
      if (t > now) break;
      currentDose = t;
      t += intMs;
    }

    const items = [];

    // Add current dose if it's within grace period and unrecorded
    if (currentDose) {
      const record = getDoseStatus(med.id, currentDose);
      if (!record || !record.status) {
        items.push(currentDose);
      }
    }

    // Add future doses
    let nextT = t;
    while (nextT < endTime && items.length < 6) {
      items.push(nextT);
      nextT += intMs;
    }

    if (items.length === 0) {
      list.innerHTML = '<li class="no-data">No upcoming doses.</li>';
      return;
    }

    items.forEach(doseTime => {
      const li = document.createElement('li');
      li.className = 'dose-item';

      const record = getDoseStatus(med.id, doseTime);
      const isPast = doseTime <= now;

      if (record && record.status) {
        li.innerHTML = `
          <span class="dose-item-time">${formatDateTime(doseTime)}</span>
          <span class="dose-badge badge-${record.status}">${capitalize(record.status)}</span>
        `;
      } else if (isPast) {
        li.innerHTML = `
          <span class="dose-item-time">${formatDateTime(doseTime)}</span>
          <div class="dose-item-actions">
            <button class="dose-btn dose-btn-take" data-time="${doseTime}">Taken</button>
            <button class="dose-btn dose-btn-skip" data-time="${doseTime}">Skip</button>
          </div>
        `;
      } else {
        li.innerHTML = `
          <span class="dose-item-time">${formatDateTime(doseTime)}</span>
          <span class="dose-badge badge-pending">Upcoming</span>
        `;
      }

      list.appendChild(li);
    });

  }

  function renderDoseHistory(med) {
    const list = $('#dose-history');
    list.innerHTML = '';

    const history = (state.doseHistory[med.id] || [])
      .slice()
      .sort((a, b) => b.time - a.time);

    if (history.length === 0) {
      list.innerHTML = '<li class="no-data">No dose history yet.</li>';
      return;
    }

    history.forEach(record => {
      const li = document.createElement('li');
      li.className = 'dose-item';
      li.innerHTML = `
        <span class="dose-item-time">${formatDateTime(record.time)}</span>
        <span class="dose-badge badge-${record.status}">${capitalize(record.status)}</span>
      `;
      list.appendChild(li);
    });
  }

  function handleDoseAction(e) {
    const btn = e.target.closest('.dose-btn');
    if (!btn || !currentMedId) return;

    const doseTime = parseInt(btn.dataset.time, 10);
    if (btn.classList.contains('dose-btn-take')) {
      setDoseStatus(currentMedId, doseTime, 'taken');
    } else if (btn.classList.contains('dose-btn-skip')) {
      setDoseStatus(currentMedId, doseTime, 'skipped');
    }

    const med = state.medicines.find(m => m.id === currentMedId);
    if (med) {
      renderUpcomingDoses(med);
      renderDoseHistory(med);
    }
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ── Delete Medicine ────────────────────────────────────
  function deleteMedicine(medId) {
    showConfirm('Delete this medicine and all its history?', () => {
      state.medicines = state.medicines.filter(m => m.id !== medId);
      delete state.doseHistory[medId];
      save();
      renderList();
      showView(viewList);
    });
  }

  function showConfirm(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
      <div class="dialog-box">
        <p>${escHtml(message)}</p>
        <div class="dialog-actions">
          <button class="btn-danger btn-sm" id="dialog-confirm">Delete</button>
          <button class="btn-secondary btn-sm" id="dialog-cancel">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#dialog-confirm').addEventListener('click', () => {
      document.body.removeChild(overlay);
      onConfirm();
    });
    overlay.querySelector('#dialog-cancel').addEventListener('click', () => {
      document.body.removeChild(overlay);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
  }

  // ── Event Bindings ─────────────────────────────────────
  function bindEvents() {
    btnAdd.addEventListener('click', openAddForm);
    form.addEventListener('submit', handleFormSubmit);
    btnCancelForm.addEventListener('click', () => {
      showView(viewList);
    });

    viewForm.querySelector('.btn-back').addEventListener('click', () => {
      showView(viewList);
    });

    viewDetail.querySelector('.btn-back').addEventListener('click', () => {
      currentMedId = null;
      renderList();
      showView(viewList);
    });

    btnEdit.addEventListener('click', () => {
      if (currentMedId) openEditForm(currentMedId);
    });

    btnDelete.addEventListener('click', () => {
      if (currentMedId) deleteMedicine(currentMedId);
    });

    $('#upcoming-doses').addEventListener('click', handleDoseAction);

    btnEnableNotif.addEventListener('click', async () => {
      const granted = await requestNotifPermission();
      if (granted) {
        notifBanner.classList.add('hidden');
        startNotifChecker();
      }
    });

    btnDismissNotif.addEventListener('click', () => {
      state.notifDismissed = true;
      save();
      notifBanner.classList.add('hidden');
    });

    // Visibility change — recheck notifications when app comes to foreground
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        autoMarkMissed();
        checkNotifications();
        if (currentMedId) {
          const med = state.medicines.find(m => m.id === currentMedId);
          if (med) {
            renderUpcomingDoses(med);
            renderDoseHistory(med);
          }
        }
        renderList();
      }
    });
  }

  // ── Init ───────────────────────────────────────────────
  function init() {
    load();
    registerSW();
    bindEvents();
    renderList();
    updateNotifBanner();
    autoMarkMissed();

    if (notifGranted()) {
      startNotifChecker();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
