(function () {
  'use strict';

  // ════════════════════════════════════════════════════════
  //  CATEGORY CONFIG — single source of truth
  //  Add a new category here; everything else adapts.
  // ════════════════════════════════════════════════════════
  const CATEGORIES = {
    medicine:    { label: 'Medicine',    icon: '💊', color: '#f87171', scheduleTypes: ['interval'],        defaults: { hours: 8, min: 0, dur: 7  }, notifText: (n) => `Time to take ${n}` },
    meals:       { label: 'Meals',       icon: '🍽️', color: '#fb923c', scheduleTypes: ['fixed','interval'], defaults: { hours: 0, min: 0, dur: 0  }, notifText: (n) => `Time for ${n}` },
    water:       { label: 'Water',       icon: '💧', color: '#38bdf8', scheduleTypes: ['goal','interval'],  defaults: { hours: 1, min: 30, dur: 0 }, notifText: (n, r) => `Drink some water — ${r._goalToday || 0}/${r.goalTarget} ${r.goalUnit || 'glasses'}` },
    supplements: { label: 'Supplements', icon: '💎', color: '#a78bfa', scheduleTypes: ['interval'],        defaults: { hours: 24, min: 0, dur: 30 }, notifText: (n) => `Time to take ${n}` },
    exercise:    { label: 'Exercise',    icon: '🏃', color: '#4ade80', scheduleTypes: ['fixed','interval'], defaults: { hours: 0, min: 0, dur: 0  }, notifText: (n) => `Time for ${n}` },
    sleep:       { label: 'Sleep',       icon: '😴', color: '#818cf8', scheduleTypes: ['sleep'],           defaults: { hours: 0, min: 0, dur: 0  }, notifText: (n) => `${n} — time now` },
    custom:      { label: 'Custom',      icon: '📌', color: '#94a3b8', scheduleTypes: ['interval','fixed'], defaults: { hours: 4, min: 0, dur: 7  }, notifText: (n) => `Reminder: ${n}` },
  };

  const STORE_KEY = 'kokhon_khabo_v2';
  const NOTIF_INTERVAL = 60000;
  const GRACE_MS = 30 * 60 * 1000;

  // ════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════
  let state = { reminders: [], history: {}, waterLog: {}, notifDismissed: false };
  let currentId = null;
  let editingId = null;
  let navStack = [];
  let tickTimer = null;

  // ════════════════════════════════════════════════════════
  //  DOM HELPERS
  // ════════════════════════════════════════════════════════
  const $ = (s, p) => (p || document).querySelector(s);
  const $$ = (s, p) => (p || document).querySelectorAll(s);

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ════════════════════════════════════════════════════════
  //  PERSISTENCE
  // ════════════════════════════════════════════════════════
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        state.reminders = p.reminders || [];
        state.history = p.history || {};
        state.waterLog = p.waterLog || {};
        state.notifDismissed = !!p.notifDismissed;
        return;
      }
      migrate();
    } catch (_) { migrate(); }
  }

  function migrate() {
    try {
      const old = localStorage.getItem('kokhon_khabo_data');
      if (!old) return;
      const p = JSON.parse(old);
      if (!p.medicines) return;
      p.medicines.forEach(m => {
        state.reminders.push({
          id: m.id, category: 'medicine', name: m.name, notes: m.notes || '',
          scheduleType: 'interval', intervalHours: m.intervalHours, intervalMinutes: m.intervalMinutes,
          fixedTimes: [], goalTarget: 0, goalUnit: 'glasses',
          nudgeHours: 0, nudgeMinutes: 0,
          durationDays: m.durationDays, ongoing: false, startTime: m.startTime, createdAt: m.createdAt,
          bedtime: '', wakeup: '',
        });
      });
      state.history = p.doseHistory || {};
      save();
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════
  //  UTILITIES
  // ════════════════════════════════════════════════════════
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmtInterval(h, m) { const p = []; if (h) p.push(h + 'h'); if (m) p.push(m + 'm'); return p.join(' ') || '0m'; }
  function intMs(h, m) { return (h * 60 + m) * 60000; }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDT(ts) { if (!isFinite(ts)) return '—'; return fmtDate(ts) + ', ' + fmtTime(ts); }
  function todayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function toLocalISO(d) { d = d || new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function endTime(r) {
    if (r.ongoing) return Infinity;
    return r.startTime + r.durationDays * 86400000;
  }

  function isActive(r) { return Date.now() < endTime(r); }

  function catCfg(r) { return CATEGORIES[r.category] || CATEGORIES.custom; }

  // ════════════════════════════════════════════════════════
  //  SCHEDULE ENGINE — works for all categories
  // ════════════════════════════════════════════════════════
  function getScheduledTimes(r, opts) {
    opts = opts || {};
    const limit = opts.limit || 500;
    const after = opts.after || 0;
    const before = opts.before || Infinity;
    const times = [];

    if (r.scheduleType === 'interval' || r.scheduleType === 'goal') {
      const h = r.scheduleType === 'goal' ? r.nudgeHours : r.intervalHours;
      const m = r.scheduleType === 'goal' ? r.nudgeMinutes : r.intervalMinutes;
      const ms = intMs(h, m);
      if (ms <= 0) return times;
      const end = Math.min(endTime(r), before);
      let t = r.startTime;
      while (t < end && times.length < limit) {
        if (t >= after) times.push(t);
        t += ms;
      }
    } else if (r.scheduleType === 'fixed') {
      const end = Math.min(endTime(r), before);
      const dayMs = 86400000;
      let day = new Date(r.startTime);
      day.setHours(0,0,0,0);
      const startDay = day.getTime();
      const ft = (r.fixedTimes || []).map(s => {
        const [hh, mm] = s.split(':').map(Number);
        return hh * 3600000 + mm * 60000;
      }).sort((a,b) => a - b);
      if (!ft.length) return times;
      let d = startDay;
      while (d < end && times.length < limit) {
        for (const offset of ft) {
          const t = d + offset;
          if (t >= r.startTime && t < end && t >= after && times.length < limit) times.push(t);
        }
        d += dayMs;
      }
    } else if (r.scheduleType === 'sleep') {
      const end = Math.min(endTime(r), before);
      const dayMs = 86400000;
      let day = new Date(r.startTime);
      day.setHours(0,0,0,0);
      const startDay = day.getTime();
      const offsets = [];
      if (r.bedtime) { const [h,m] = r.bedtime.split(':').map(Number); offsets.push(h*3600000+m*60000); }
      if (r.wakeup) { const [h,m] = r.wakeup.split(':').map(Number); offsets.push(h*3600000+m*60000); }
      offsets.sort((a,b) => a - b);
      if (!offsets.length) return times;
      let d = startDay;
      while (d < end && times.length < limit) {
        for (const offset of offsets) {
          const t = d + offset;
          if (t >= r.startTime && t < end && t >= after && times.length < limit) times.push(t);
        }
        d += dayMs;
      }
    }
    return times;
  }

  function getUpcoming(r, count) {
    const now = Date.now();
    return getScheduledTimes(r, { after: now, limit: count });
  }

  function getPast(r) {
    const now = Date.now();
    return getScheduledTimes(r, { before: now + 1, limit: 1000 });
  }

  function getStatus(rId, t) {
    const h = state.history[rId];
    return h ? h.find(e => e.time === t) || null : null;
  }

  function setStatus(rId, t, status) {
    if (!state.history[rId]) state.history[rId] = [];
    const ex = state.history[rId].find(e => e.time === t);
    if (ex) { ex.status = status; ex.recordedAt = Date.now(); }
    else state.history[rId].push({ time: t, status, recordedAt: Date.now() });
    save();
  }

  function autoMarkMissed() {
    const now = Date.now();
    state.reminders.forEach(r => {
      if (r.scheduleType === 'goal') return;
      getPast(r).forEach(t => {
        if (now - t > GRACE_MS && !getStatus(r.id, t)) setStatus(r.id, t, 'missed');
      });
    });
  }

  // ── Streaks ───────────────────────────────────
  function computeStreak(r) {
    if (r.scheduleType === 'goal') return 0;
    const hist = state.history[r.id] || [];
    const dayMap = {};
    hist.forEach(e => {
      if (e.status === 'taken') {
        const k = new Date(e.time).toDateString();
        dayMap[k] = true;
      }
    });
    let streak = 0;
    const d = new Date(); d.setHours(0,0,0,0);
    const todayStr = d.toDateString();
    if (!dayMap[todayStr]) {
      const todayTimes = getScheduledTimes(r, { after: d.getTime(), before: d.getTime() + 86400000 });
      const allPending = todayTimes.length > 0 && todayTimes.every(t => !getStatus(r.id, t) || !getStatus(r.id, t).status);
      if (allPending) d.setDate(d.getDate() - 1);
    }
    while (true) {
      if (d.getTime() < r.startTime) break;
      if (!dayMap[d.toDateString()]) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  // ── Water ─────────────────────────────────────
  function waterReminder() { return state.reminders.find(r => r.category === 'water' && r.scheduleType === 'goal' && isActive(r)); }

  function waterToday() {
    const key = todayKey();
    return state.waterLog[key] || 0;
  }

  function logWater(amount) {
    const key = todayKey();
    state.waterLog[key] = (state.waterLog[key] || 0) + amount;
    save();
  }

  // ── Daily progress ────────────────────────────
  function dailyProgress() {
    const now = Date.now();
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const endOfDay = startOfDay.getTime() + 86400000;
    let total = 0, done = 0;

    state.reminders.forEach(r => {
      if (!isActive(r) && endTime(r) < startOfDay.getTime()) return;
      if (r.scheduleType === 'goal') {
        const wr = waterReminder();
        if (wr && wr.id === r.id) {
          total++;
          if (waterToday() >= r.goalTarget) done++;
        }
        return;
      }
      const times = getScheduledTimes(r, { after: startOfDay.getTime(), before: endOfDay });
      times.forEach(t => {
        total++;
        const s = getStatus(r.id, t);
        if (s && (s.status === 'taken' || s.status === 'skipped')) done++;
      });
    });
    return { done, total };
  }

  // ════════════════════════════════════════════════════════
  //  NOTIFICATIONS
  // ════════════════════════════════════════════════════════
  function notifOk() { return 'Notification' in window && Notification.permission === 'granted'; }

  function fireNotif(title, body) {
    if (!notifOk()) return;
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, {
        body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
        tag: title + '-' + Date.now(), requireInteraction: true, vibrate: [200,100,200],
      }));
    } else { new Notification(title, { body }); }
  }

  function checkNotifs() {
    const now = Date.now();
    const win = NOTIF_INTERVAL + 5000;
    state.reminders.forEach(r => {
      if (!isActive(r)) return;
      const cfg = catCfg(r);
      const times = getScheduledTimes(r, { after: now - win, before: now + 1, limit: 50 });
      times.forEach(t => {
        if (t > now) return;
        const k = `n2_${r.id}_${t}`;
        if (localStorage.getItem(k)) return;
        localStorage.setItem(k, '1');
        r._goalToday = waterToday();
        fireNotif('কখন খাবো', cfg.notifText(r.name, r));
      });
    });
  }

  function startTick() {
    if (tickTimer) clearInterval(tickTimer);
    checkNotifs();
    tickTimer = setInterval(() => { checkNotifs(); autoMarkMissed(); }, NOTIF_INTERVAL);
  }

  // ════════════════════════════════════════════════════════
  //  NAVIGATION
  // ════════════════════════════════════════════════════════
  const views = () => ({ dashboard: $('#view-dashboard'), picker: $('#view-picker'), catList: $('#view-cat-list'), form: $('#view-form'), detail: $('#view-detail') });

  function showView(name) {
    const v = views();
    const header = $('#header');
    const fab = $('#btn-add');
    const ver = $('#version');

    Object.values(v).forEach(el => { if (el.id === 'view-dashboard') el.style.display = 'none'; else el.classList.add('hidden'); });
    header.style.display = 'none';
    fab.style.display = 'none';
    ver.style.display = 'none';

    if (name === 'dashboard') {
      v.dashboard.style.display = '';
      header.style.display = '';
      fab.style.display = '';
      ver.style.display = '';
    } else {
      v[name].classList.remove('hidden');
    }
  }

  function navigate(name) {
    navStack.push(name);
    showView(name);
  }

  function goBack() {
    navStack.pop();
    const prev = navStack[navStack.length - 1] || 'dashboard';
    showView(prev);
    if (prev === 'dashboard') { navStack = []; renderDashboard(); }
    else if (prev === 'catList') renderCatList(currentCatForList);
    else if (prev === 'detail' && currentId) openDetail(currentId);
  }

  let currentCatForList = null;

  // ════════════════════════════════════════════════════════
  //  RENDER — DASHBOARD
  // ════════════════════════════════════════════════════════
  function renderDashboard() {
    autoMarkMissed();
    const hasReminders = state.reminders.length > 0;
    const de = $('#dashboard-empty');
    const th = $('#timeline-heading');
    if (!hasReminders) { de.classList.remove('hidden'); th.style.display = 'none'; }
    else { de.classList.add('hidden'); th.style.display = ''; }
    renderProgress();
    renderWaterWidget();
    renderTimeline();
    renderCategoryNav();
  }

  function renderProgress() {
    const { done, total } = dailyProgress();
    const pct = total ? Math.round(done / total * 100) : 0;
    $('#daily-progress').innerHTML = `
      <div class="progress-head"><span>Today</span><span>${done}/${total} done</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  }

  function renderWaterWidget() {
    const wr = waterReminder();
    const w = $('#water-widget');
    if (!wr) { w.classList.add('hidden'); return; }
    w.classList.remove('hidden');
    const logged = waterToday();
    const inc = wr.goalUnit === 'ml' ? 250 : wr.goalUnit === 'litres' ? 0.25 : 1;
    const incLabel = wr.goalUnit === 'ml' ? '+250' : wr.goalUnit === 'litres' ? '+0.25' : '+1';
    w.innerHTML = `
      <div class="water-info"><span>💧</span><span>${logged}/${wr.goalTarget}</span><span class="water-unit">${wr.goalUnit}</span></div>
      <button class="btn-water" id="btn-water-log">${incLabel}</button>`;
    $('#btn-water-log').onclick = () => { logWater(inc); renderWaterWidget(); renderProgress(); };
  }

  function renderTimeline() {
    const list = $('#timeline-list');
    const empty = $('#timeline-empty');
    list.innerHTML = '';
    empty.classList.add('hidden');

    const now = Date.now();
    const endOfDay = new Date(); endOfDay.setHours(23,59,59,999);
    let items = [];

    state.reminders.forEach(r => {
      if (r.scheduleType === 'goal') return;
      if (!isActive(r) && endTime(r) < now) return;
      const cfg = catCfg(r);

      // Current unacted dose
      const past = getPast(r);
      if (past.length) {
        const last = past[past.length - 1];
        if (now - last < GRACE_MS && !getStatus(r.id, last)) {
          items.push({ time: last, r, cfg, past: true });
        }
      }

      const upcoming = getScheduledTimes(r, { after: now, before: endOfDay.getTime() + 1, limit: 10 });
      upcoming.forEach(t => items.push({ time: t, r, cfg, past: false }));
    });

    items.sort((a, b) => a.time - b.time);
    items = items.slice(0, 12);

    if (!items.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    items.forEach(({ time, r, cfg, past }) => {
      const li = el('li', 'item');
      const s = getStatus(r.id, time);
      let right = '';
      if (s && s.status) {
        right = `<span class="badge ${s.status}">${cap(s.status)}</span>`;
      } else if (past) {
        right = `<div class="dose-actions">
          <button class="dose-btn take" data-rid="${r.id}" data-t="${time}">Done</button>
          <button class="dose-btn skip" data-rid="${r.id}" data-t="${time}">Skip</button></div>`;
      } else {
        right = `<span class="badge pending">${fmtTime(time)}</span>`;
      }
      li.innerHTML = `
        <span class="dot" style="background:${cfg.color}"></span>
        <span class="item-body"><span class="item-title">${esc(r.name)}</span></span>
        ${right}`;
      li.addEventListener('click', e => { if (!e.target.closest('.dose-btn')) openDetail(r.id); });
      list.appendChild(li);
    });

    list.onclick = e => {
      const btn = e.target.closest('.dose-btn');
      if (!btn) return;
      const rid = btn.dataset.rid;
      const t = parseInt(btn.dataset.t, 10);
      setStatus(rid, t, btn.classList.contains('take') ? 'taken' : 'skipped');
      renderDashboard();
    };
  }

  function renderCategoryNav() {
    const nav = $('#category-nav');
    nav.innerHTML = '';
    Object.keys(CATEGORIES).forEach(key => {
      const cfg = CATEGORIES[key];
      const count = state.reminders.filter(r => r.category === key).length;
      const li = el('li', 'item');
      li.innerHTML = `
        <span class="item-icon">${cfg.icon}</span>
        <span class="item-body"><span class="item-title">${cfg.label}</span></span>
        <span class="item-right">${count}</span>
        <span class="item-right">›</span>`;
      li.onclick = () => { currentCatForList = key; navigate('catList'); renderCatList(key); };
      nav.appendChild(li);
    });
  }

  // ════════════════════════════════════════════════════════
  //  RENDER — CATEGORY LIST
  // ════════════════════════════════════════════════════════
  function renderCatList(cat) {
    const cfg = CATEGORIES[cat];
    $('#cat-list-title').textContent = cfg.label;
    const list = $('#cat-list-items');
    const empty = $('#cat-list-empty');
    list.innerHTML = '';
    const items = state.reminders.filter(r => r.category === cat);

    if (!items.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    items.forEach(r => {
      const li = el('li', 'item');
      const active = isActive(r);
      let meta = '';
      if (r.scheduleType === 'interval') meta = `Every ${fmtInterval(r.intervalHours, r.intervalMinutes)}`;
      else if (r.scheduleType === 'fixed') meta = (r.fixedTimes || []).join(', ');
      else if (r.scheduleType === 'goal') meta = `${r.goalTarget} ${r.goalUnit}/day`;
      else if (r.scheduleType === 'sleep') meta = `${r.bedtime || ''} — ${r.wakeup || ''}`;

      li.innerHTML = `
        <span class="item-icon">${cfg.icon}</span>
        <span class="item-body">
          <span class="item-title">${esc(r.name)}</span>
          <span class="item-sub">${meta}</span>
        </span>
        <span class="badge ${active ? 'active' : 'ended'}">${active ? 'Active' : 'Ended'}</span>`;
      li.onclick = () => openDetail(r.id);
      list.appendChild(li);
    });
  }

  // ════════════════════════════════════════════════════════
  //  RENDER — PICKER
  // ════════════════════════════════════════════════════════
  function renderPicker() {
    const list = $('#picker-list');
    list.innerHTML = '';
    const descs = {
      medicine: 'Pills, tablets, syrups',
      meals: 'Breakfast, lunch, dinner, snacks',
      water: 'Track glasses, litres, or ml',
      supplements: 'Vitamins & supplements',
      exercise: 'Walk, stretch, workout',
      sleep: 'Bedtime & wake-up reminders',
      custom: 'Anything else',
    };
    Object.keys(CATEGORIES).forEach(key => {
      const cfg = CATEGORIES[key];
      const li = el('li', 'item lg');
      li.innerHTML = `
        <span class="item-icon" style="font-size:1.5rem">${cfg.icon}</span>
        <span class="item-body">
          <span class="item-title">${cfg.label}</span>
          <span class="item-sub">${descs[key] || ''}</span>
        </span>`;
      li.onclick = () => openForm(key);
      list.appendChild(li);
    });
  }

  // ════════════════════════════════════════════════════════
  //  FORM — config-driven show/hide
  // ════════════════════════════════════════════════════════
  function openForm(category, editId) {
    editingId = editId || null;
    const cfg = CATEGORIES[category];
    const types = cfg.scheduleTypes;
    const isEdit = !!editId;
    const r = isEdit ? state.reminders.find(x => x.id === editId) : null;

    $('#form-title').textContent = isEdit ? `Edit ${cfg.label}` : `Add ${cfg.label}`;
    $('#f-category').value = category;
    $('#btn-save').textContent = isEdit ? 'Update' : 'Save';

    $('#f-name').value = r ? r.name : '';
    $('#f-name').placeholder = cfg.label === 'Water' ? 'Water' : `e.g. ${cfg.label}`;
    $('#f-notes').value = r ? r.notes || '' : '';

    // Hide all optional groups
    ['grp-schedule-type', 'grp-water-mode', 'grp-fixed-times', 'grp-sleep', 'grp-interval', 'grp-water-goal', 'grp-duration', 'grp-start'].forEach(id => {
      $('#' + id).classList.add('hidden');
    });

    let activeSchedule = types[0];
    if (r) activeSchedule = r.scheduleType;

    // Show schedule type toggle for categories with >1 option (except water which has its own)
    if (types.length > 1 && category !== 'water') {
      const grp = $('#grp-schedule-type');
      grp.classList.remove('hidden');
      setToggle(grp.querySelector('.toggle-row'), activeSchedule);
    }

    if (category === 'water') {
      const grp = $('#grp-water-mode');
      grp.classList.remove('hidden');
      setToggle(grp.querySelector('.toggle-row'), activeSchedule === 'goal' ? 'goal' : 'interval');
    }

    if (category === 'sleep') {
      $('#grp-sleep').classList.remove('hidden');
      $('#f-bedtime').value = r ? r.bedtime || '23:00' : '23:00';
      $('#f-wakeup').value = r ? r.wakeup || '07:00' : '07:00';
      activeSchedule = 'sleep';
    }

    showScheduleFields(activeSchedule, r, cfg);

    // Duration & start
    if (category !== 'sleep') {
      $('#grp-duration').classList.remove('hidden');
      $('#grp-start').classList.remove('hidden');
      const ongoing = r ? r.ongoing : (cfg.defaults.dur === 0);
      $('#f-ongoing').checked = ongoing;
      $('#f-duration').value = r ? r.durationDays : (cfg.defaults.dur || 7);
      $('#f-duration').disabled = ongoing;
      $('#f-start').value = r ? toLocalISO(new Date(r.startTime)) : toLocalISO();
    } else {
      $('#grp-duration').classList.remove('hidden');
      const ongoing = r ? r.ongoing : true;
      $('#f-ongoing').checked = ongoing;
      $('#f-duration').value = r ? r.durationDays : 365;
      $('#f-duration').disabled = ongoing;
      $('#grp-start').classList.remove('hidden');
      $('#f-start').value = r ? toLocalISO(new Date(r.startTime)) : toLocalISO();
    }

    if (navStack[navStack.length - 1] !== 'form') navigate('form');
    else showView('form');
  }

  function showScheduleFields(type, r, cfg) {
    $('#grp-fixed-times').classList.add('hidden');
    $('#grp-interval').classList.add('hidden');
    $('#grp-water-goal').classList.add('hidden');

    if (type === 'fixed') {
      $('#grp-fixed-times').classList.remove('hidden');
      renderFixedTimes(r ? r.fixedTimes || ['08:00'] : ['08:00']);
    } else if (type === 'interval') {
      $('#grp-interval').classList.remove('hidden');
      $('#f-hours').value = r ? r.intervalHours : cfg.defaults.hours;
      $('#f-minutes').value = r ? r.intervalMinutes : cfg.defaults.min;
    } else if (type === 'goal') {
      $('#grp-water-goal').classList.remove('hidden');
      $('#f-goal-target').value = r ? r.goalTarget : 8;
      setToggle($('#grp-water-goal .toggle-row'), r ? r.goalUnit : 'glasses');
      $('#f-nudge-hours').value = r ? r.nudgeHours : 1;
      $('#f-nudge-minutes').value = r ? r.nudgeMinutes : 30;
    }
  }

  function renderFixedTimes(times) {
    const c = $('#fixed-times-container');
    c.innerHTML = '';
    times.forEach((t, i) => {
      const row = el('div', 'fixed-time-row');
      row.innerHTML = `<input type="time" value="${t}" data-idx="${i}"><button type="button" class="btn-rm-time" data-idx="${i}">&times;</button>`;
      c.appendChild(row);
    });
  }

  function getFixedTimes() {
    return Array.from($$('#fixed-times-container input[type="time"]')).map(i => i.value).filter(Boolean);
  }

  // Toggle helpers
  function setToggle(row, val) {
    row.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === val));
  }

  function getToggle(row) {
    const a = row.querySelector('.toggle-btn.active');
    return a ? a.dataset.val : '';
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    const cat = $('#f-category').value;
    const cfg = CATEGORIES[cat];
    const name = $('#f-name').value.trim();
    if (!name) return;

    let scheduleType = cfg.scheduleTypes[0];
    if (cfg.scheduleTypes.length > 1 && cat !== 'water') {
      scheduleType = getToggle($('#grp-schedule-type .toggle-row'));
    }
    if (cat === 'water') {
      scheduleType = getToggle($('#grp-water-mode .toggle-row'));
    }
    if (cat === 'sleep') scheduleType = 'sleep';

    const ongoing = $('#f-ongoing').checked;
    const dur = parseInt($('#f-duration').value, 10) || 7;
    const start = new Date($('#f-start').value).getTime();
    if (isNaN(start)) { alert('Please set a valid start date.'); return; }

    const data = {
      category: cat, name, notes: $('#f-notes').value.trim(),
      scheduleType, ongoing,
      intervalHours: parseInt($('#f-hours').value, 10) || 0,
      intervalMinutes: parseInt($('#f-minutes').value, 10) || 0,
      fixedTimes: getFixedTimes(),
      goalTarget: parseInt($('#f-goal-target').value, 10) || 8,
      goalUnit: $('#grp-water-goal .toggle-row') ? getToggle($('#grp-water-goal .toggle-row')) || 'glasses' : 'glasses',
      nudgeHours: parseInt($('#f-nudge-hours').value, 10) || 0,
      nudgeMinutes: parseInt($('#f-nudge-minutes').value, 10) || 0,
      durationDays: ongoing ? 36500 : dur,
      startTime: start,
      bedtime: $('#f-bedtime').value || '',
      wakeup: $('#f-wakeup').value || '',
    };

    if (scheduleType === 'interval' && data.intervalHours === 0 && data.intervalMinutes === 0) {
      alert('Interval must be at least 1 minute.'); return;
    }
    if (scheduleType === 'goal' && data.nudgeHours === 0 && data.nudgeMinutes === 0) {
      alert('Nudge interval must be at least 1 minute.'); return;
    }

    if (editingId) {
      const r = state.reminders.find(x => x.id === editingId);
      if (r) Object.assign(r, data);
    } else {
      state.reminders.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
    }

    save();
    editingId = null;
    navStack = [];
    showView('dashboard');
    renderDashboard();
  }

  // ════════════════════════════════════════════════════════
  //  DETAIL VIEW
  // ════════════════════════════════════════════════════════
  function openDetail(id) {
    const r = state.reminders.find(x => x.id === id);
    if (!r) return;
    currentId = id;
    autoMarkMissed();

    const cfg = catCfg(r);
    $('#detail-name').textContent = r.name;

    // Info rows — built dynamically from reminder data
    const info = $('#detail-info');
    info.innerHTML = '';
    const rows = [
      ['Category', `${cfg.icon} ${cfg.label}`],
      ['Schedule', describeSchedule(r)],
    ];
    if (r.scheduleType !== 'goal') {
      if (r.ongoing) rows.push(['Duration', 'Ongoing']);
      else rows.push(['Duration', r.durationDays + ' day' + (r.durationDays !== 1 ? 's' : '')]);
    }
    if (r.scheduleType === 'goal') {
      rows.push(['Target', `${r.goalTarget} ${r.goalUnit}/day`]);
      rows.push(['Nudge', `Every ${fmtInterval(r.nudgeHours, r.nudgeMinutes)}`]);
    }
    rows.push(['Started', fmtDT(r.startTime)]);
    if (!r.ongoing) rows.push(['Ends', fmtDT(endTime(r))]);
    rows.push(['Status', isActive(r) ? 'Active' : 'Ended']);

    const next = getUpcoming(r, 1);
    if (next.length && isActive(r)) rows.push(['Next', fmtDT(next[0])]);
    if (r.notes) rows.push(['Notes', r.notes]);

    rows.forEach(([lbl, val]) => {
      const d = el('div', 'info-row');
      d.innerHTML = `<span class="lbl">${lbl}</span><span class="val">${esc(val)}</span>`;
      info.appendChild(d);
    });

    // Streak
    const streak = computeStreak(r);
    const sb = $('#detail-streak');
    if (streak > 0) { sb.classList.remove('hidden'); sb.innerHTML = `🔥 <span>${streak}</span> day streak`; }
    else sb.classList.add('hidden');

    renderDetailUpcoming(r);
    renderDetailHistory(r);
    if (navStack[navStack.length - 1] !== 'detail') navigate('detail');
    else showView('detail');
  }

  function describeSchedule(r) {
    if (r.scheduleType === 'interval') return `Every ${fmtInterval(r.intervalHours, r.intervalMinutes)}`;
    if (r.scheduleType === 'fixed') return (r.fixedTimes || []).join(', ') || 'No times set';
    if (r.scheduleType === 'goal') return 'Daily goal';
    if (r.scheduleType === 'sleep') return `${r.bedtime || '?'} — ${r.wakeup || '?'}`;
    return '';
  }

  function renderDetailUpcoming(r) {
    const list = $('#upcoming-list');
    list.innerHTML = '';

    if (!isActive(r) && r.scheduleType !== 'goal') {
      list.innerHTML = '<li class="empty-msg">Reminders have ended.</li>';
      return;
    }
    if (r.scheduleType === 'goal') {
      const wr = waterToday();
      list.innerHTML = `<li class="empty-msg">Logged ${wr}/${r.goalTarget} ${r.goalUnit} today.</li>`;
      return;
    }

    const now = Date.now();
    const items = [];

    // Current unacted
    const past = getPast(r);
    if (past.length) {
      const last = past[past.length - 1];
      if (now - last < GRACE_MS) {
        const s = getStatus(r.id, last);
        if (!s || !s.status) items.push(last);
      }
    }

    const upcoming = getUpcoming(r, 6 - items.length);
    upcoming.forEach(t => items.push(t));

    if (!items.length) { list.innerHTML = '<li class="empty-msg">No upcoming doses.</li>'; return; }

    items.forEach(t => {
      const li = el('li', 'item');
      const s = getStatus(r.id, t);
      const isPast = t <= now;
      let right = '';
      if (s && s.status) {
        right = `<span class="badge ${s.status}">${cap(s.status)}</span>`;
      } else if (isPast) {
        right = `<div class="dose-actions"><button class="dose-btn take" data-t="${t}">Done</button><button class="dose-btn skip" data-t="${t}">Skip</button></div>`;
      } else {
        right = `<span class="badge pending">Upcoming</span>`;
      }
      li.innerHTML = `<span class="item-body"><span class="item-sub">${fmtDT(t)}</span></span>${right}`;
      list.appendChild(li);
    });
  }

  function renderDetailHistory(r) {
    const list = $('#history-list');
    list.innerHTML = '';
    const hist = (state.history[r.id] || []).slice().sort((a, b) => b.time - a.time);
    if (!hist.length) { list.innerHTML = '<li class="empty-msg">No history yet.</li>'; return; }
    hist.slice(0, 50).forEach(e => {
      const li = el('li', 'item');
      li.innerHTML = `<span class="item-body"><span class="item-sub">${fmtDT(e.time)}</span></span><span class="badge ${e.status}">${cap(e.status)}</span>`;
      list.appendChild(li);
    });
  }

  function handleDetailDoseAction(e) {
    const btn = e.target.closest('.dose-btn');
    if (!btn || !currentId) return;
    setStatus(currentId, parseInt(btn.dataset.t, 10), btn.classList.contains('take') ? 'taken' : 'skipped');
    const r = state.reminders.find(x => x.id === currentId);
    if (r) { renderDetailUpcoming(r); renderDetailHistory(r); }
  }

  // ════════════════════════════════════════════════════════
  //  DELETE
  // ════════════════════════════════════════════════════════
  function deleteReminder(id) {
    showConfirm('Delete this item and all its history?', () => {
      state.reminders = state.reminders.filter(x => x.id !== id);
      delete state.history[id];
      save();
      navStack = [];
      showView('dashboard');
      renderDashboard();
    });
  }

  function showConfirm(msg, onOk) {
    const bg = el('div', 'dialog-bg');
    bg.innerHTML = `<div class="dialog"><p>${esc(msg)}</p><div class="dialog-btns"><button class="btn danger sm" id="d-ok">Delete</button><button class="btn secondary sm" id="d-no">Cancel</button></div></div>`;
    document.body.appendChild(bg);
    $('#d-ok').onclick = () => { document.body.removeChild(bg); onOk(); };
    $('#d-no').onclick = () => document.body.removeChild(bg);
    bg.onclick = e => { if (e.target === bg) document.body.removeChild(bg); };
  }

  // ════════════════════════════════════════════════════════
  //  EVENT BINDINGS
  // ════════════════════════════════════════════════════════
  function bind() {
    $('#btn-add').onclick = () => { navigate('picker'); renderPicker(); };
    $('#reminder-form').onsubmit = handleFormSubmit;
    $('#btn-cancel-form').onclick = goBack;
    $('#btn-edit').onclick = () => { if (currentId) { const r = state.reminders.find(x => x.id === currentId); if (r) openForm(r.category, currentId); } };
    $('#btn-delete').onclick = () => { if (currentId) deleteReminder(currentId); };

    // All back buttons
    $$('.btn-back').forEach(b => b.onclick = goBack);

    // Toggle buttons
    document.addEventListener('click', e => {
      const tb = e.target.closest('.toggle-btn');
      if (!tb) return;
      const row = tb.closest('.toggle-row');
      row.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      tb.classList.add('active');

      const field = row.dataset.field;
      if (field === 'scheduleType' || field === 'waterMode') {
        const cat = $('#f-category').value;
        const cfg = CATEGORIES[cat];
        showScheduleFields(tb.dataset.val, null, cfg);
      }
    });

    // Fixed times add/remove
    $('#btn-add-time').onclick = () => {
      const times = getFixedTimes();
      times.push('12:00');
      renderFixedTimes(times);
    };
    $('#fixed-times-container').addEventListener('click', e => {
      if (e.target.closest('.btn-rm-time')) {
        const times = getFixedTimes();
        const idx = parseInt(e.target.closest('.btn-rm-time').dataset.idx, 10);
        times.splice(idx, 1);
        renderFixedTimes(times.length ? times : ['08:00']);
      }
    });

    // Ongoing checkbox
    $('#f-ongoing').onchange = () => { $('#f-duration').disabled = $('#f-ongoing').checked; };

    // Detail dose actions
    $('#upcoming-list').addEventListener('click', handleDetailDoseAction);

    // Notifications banner
    $('#btn-enable-notif').onclick = async () => {
      if ('Notification' in window) {
        const r = await Notification.requestPermission();
        if (r === 'granted') { $('#notif-banner').classList.add('hidden'); startTick(); }
      }
    };
    $('#btn-dismiss-notif').onclick = () => { state.notifDismissed = true; save(); $('#notif-banner').classList.add('hidden'); };

    // Visibility change
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { autoMarkMissed(); checkNotifs(); renderDashboard(); }
    });
  }

  // ════════════════════════════════════════════════════════
  //  SERVICE WORKER
  // ════════════════════════════════════════════════════════
  function regSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ════════════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════════════
  function init() {
    load();
    regSW();
    bind();
    renderDashboard();

    if ('Notification' in window) {
      if (Notification.permission === 'granted') startTick();
      else if (Notification.permission !== 'denied' && !state.notifDismissed) $('#notif-banner').classList.remove('hidden');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
