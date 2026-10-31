/**
 * views-admin.js — все экраны администратора.
 *
 * Экспортирует 7 render-функций + bindAdminEvents для привязки
 * обработчиков после вставки HTML в DOM.
 *
 * Не хранит persistent-состояние — только UI (reportPeriod, searchQuery).
 * После мутаций — эмитит 'bf:refresh', main.js перерисовывает.
 */

import {
  state, getService, getClient, getBookingsForDate,
  activeServices, clientBookings, clientLTV, clientLastVisit,
  isOff, reset, saveImmediate
} from './store.js';

import {
  esc, toast, buzz, formatMoney, plural, debounce,
  todayStr, fmtRu, fmtLong, fmtDate, t2m,
  telHref, addDays,
  STATUS_LABEL, STATUS_COLOR,
  MONTHS_GEN, WD_SHORT
} from './utils.js';

import {
  openSettings, openSalon, openSecurity,
  openServiceEditor, openClientCard, openBookingDetail,
  openExpenseEditor, openImport,
  calendar, bindCalendar, askConfirm
} from './modals.js';

import { checkSub, PLANS, PLAN_LIMITS } from './subscription.js';

import { switchView } from './main.js';


/* ═══════════════════════════════════════════════════════════════
   МОДУЛЬНОЕ UI-СОСТОЯНИЕ (не сохраняется)
   ═══════════════════════════════════════════════════════════════ */

let _reportPeriod = 'month';      // 'day' | 'week' | 'month' | 'all'
let _clientSearchQuery = '';


/* ═══════════════════════════════════════════════════════════════
   УТИЛИТА: эмит события обновления
   ═══════════════════════════════════════════════════════════════ */

function refresh() {
  window.dispatchEvent(new CustomEvent('bf:refresh'));
}


/* ═══════════════════════════════════════════════════════════════
   1. ДАШБОРД (главная админа)
   ═══════════════════════════════════════════════════════════════ */

export function renderAdminHome() {
  const today = todayStr();
  const todayBook = getBookingsForDate(today)
    .filter(b => b.status !== 'cancelled');
  const doneToday = todayBook.filter(b => b.status === 'done');
  const revenueToday = doneToday.reduce((s, b) => s + b.price, 0);
  const pendingAll = state.bookings.filter(
    b => b.date >= today && b.status === 'pending'
  ).length;

  const dayMin = t2m(state.workingHours.end) - t2m(state.workingHours.start);
  const bookedMin = todayBook.reduce((s, b) => s + b.duration, 0);
  const load = dayMin > 0 ? Math.round(bookedMin / dayMin * 100) : 0;

  let h = `
    <div style="padding:4px 0 12px">
      <div style="color:var(--muted);font-size:.76rem;font-weight:600;
                  text-transform:uppercase;letter-spacing:.05em">Дашборд</div>
      <h2 style="font-family:'Playfair Display',serif;font-size:1.4rem;
                 font-weight:600;letter-spacing:-.02em;margin-top:2px">
        ${fmtLong(today)}
      </h2>
    </div>
  `;

  // KPI
  h += '<div class="stat-grid">';
  h += `
    <div class="stat large full">
      <div class="lbl">Записей сегодня</div>
      <div class="val">
        ${todayBook.length}
        <span style="font-size:.85rem;color:var(--muted);font-weight:500;
                     font-family:Inter,sans-serif">· ${load}% загрузки</span>
      </div>
      <div class="sub">
        Выручка: ${formatMoney(revenueToday)}
        ${pendingAll > 0 ? ` · <span style="color:var(--amber);font-weight:700">${pendingAll} ожидают</span>` : ''}
      </div>
    </div>
    <div class="stat">
      <div class="lbl">Клиентов</div>
      <div class="val">${state.clients.length}</div>
    </div>
    <div class="stat">
      <div class="lbl">Услуг</div>
      <div class="val">${activeServices().length}</div>
    </div>
  `;
  h += '</div>';

  // Быстрые действия
  h += `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      <button class="card" style="text-align:left;padding:12px;cursor:pointer"
              data-action="go-book">
        <div style="font-size:1.1rem">📅</div>
        <div style="font-weight:700;font-size:.82rem;margin-top:4px">Записи</div>
        <div style="font-size:.7rem;color:var(--muted)">Календарь</div>
      </button>
      <button class="card" style="text-align:left;padding:12px;cursor:pointer"
              data-action="go-clients">
        <div style="font-size:1.1rem">👥</div>
        <div style="font-weight:700;font-size:.82rem;margin-top:4px">Клиенты</div>
        <div style="font-size:.7rem;color:var(--muted)">База CRM</div>
      </button>
    </div>
  `;

  // Сегодняшние записи
  h += `<h3 class="h3">Сегодня<span class="count">${todayBook.length}</span></h3>`;
  if (todayBook.length === 0) {
    h += '<div class="empty-box">Сегодня записей нет</div>';
  } else {
    h += '<div class="b-list">';
    todayBook.forEach(b => {
      h += `
        <div class="b-item" data-open-book="${b.id}">
          <div class="b-time">
            <b>${b.time}</b>
            <small>${b.duration}м</small>
          </div>
          <div class="b-info">
            <b>${esc(b.clientName)}</b>
            <small>${esc(b.serviceName)} ·
              <a href="${telHref(b.clientPhone)}">${esc(b.clientPhone)}</a>
            </small>
          </div>
          <div class="b-right">
            <div class="price">${formatMoney(b.price)}</div>
            <span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span>
          </div>
        </div>
      `;
    });
    h += '</div>';
  }

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   2. ЗАПИСИ (календарь + список на день)
   ═══════════════════════════════════════════════════════════════ */

export function renderAdminBook() {
  let h = `
    <div class="section-head">
      <h2>Записи</h2>
      <p>Управление расписанием</p>
    </div>
  `;

  h += `
    <button class="btn btn-ghost btn-block" data-action="open-settings"
            style="margin-bottom:12px">
      ⚙️ Рабочие часы (${state.workingHours.start}–${state.workingHours.end})
    </button>
  `;

  h += calendar();

  if (state.selectedDate) {
    const bookings = getBookingsForDate(state.selectedDate)
      .filter(b => b.status !== 'cancelled');
    h += `<h3 class="h3">
      ${fmtLong(state.selectedDate)}
      <span class="count">${bookings.length}</span>
    </h3>`;

    if (bookings.length === 0) {
      h += '<div class="empty-box">Записей нет</div>';
    } else {
      h += '<div class="b-list">';
      bookings.forEach(b => {
        const isMine = false;
        h += `
          <div class="b-item" data-open-book="${b.id}">
            <div class="b-time">
              <b>${b.time}</b>
              <small>${b.duration}м</small>
            </div>
            <div class="b-info">
              <b>${esc(b.clientName)}</b>
              <small>${esc(b.serviceName)} ·
                <a href="${telHref(b.clientPhone)}">${esc(b.clientPhone)}</a>
              </small>
            </div>
            <div class="b-right">
              <div class="price">${formatMoney(b.price)}</div>
              <span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span>
            </div>
          </div>
        `;
      });
      h += '</div>';
    }
  }

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   3. КЛИЕНТЫ (CRM)
   ═══════════════════════════════════════════════════════════════ */

export function renderClients() {
  let h = `
    <div class="section-head">
      <h2>Клиенты</h2>
      <p>CRM база салона</p>
    </div>
    <div class="search-wrap">
      <input class="search-input" id="clientSearch"
             placeholder="Поиск по имени или телефону"
             value="${esc(_clientSearchQuery)}">
    </div>
    <button class="btn btn-primary btn-block" data-action="add-client"
            style="margin-bottom:12px">
      + Добавить клиента
    </button>
    <div id="clientList">${clientListHtml(_clientSearchQuery)}</div>
  `;
  return h;
}

/**
 * HTML списка клиентов с учётом поиска.
 * @param {string} query
 * @returns {string}
 */
function clientListHtml(query = '') {
  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');

  let list = [...state.clients];
  if (q) {
    list = list.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (qDigits && c.phone.replace(/\D/g, '').includes(qDigits)) return true;
      return false;
    });
  }

  // Сортируем по последнему визиту (свежие сверху)
  list.sort((a, b) => {
    const la = clientLastVisit(a.id) || '0000-00-00';
    const lb = clientLastVisit(b.id) || '0000-00-00';
    return lb.localeCompare(la);
  });

  if (list.length === 0) {
    return '<div class="empty-box">Клиентов не найдено</div>';
  }

  return list.map(c => {
    const ltv = clientLTV(c.id);
    const last = clientLastVisit(c.id);
    const initial = c.name.charAt(0).toUpperCase();
    return `
      <div class="client-card" data-open-client="${c.id}">
        <div class="client-ava">${esc(initial)}</div>
        <div class="client-info">
          <b>${esc(c.name)}</b>
          <small>${esc(c.phone)}</small>
        </div>
        <div class="client-right">
          <div class="cl-ltv">${formatMoney(ltv)}</div>
          <div class="cl-last">${last ? fmtRu(last) : 'нет визитов'}</div>
        </div>
      </div>
    `;
  }).join('');
}


/* ═══════════════════════════════════════════════════════════════
   4. УСЛУГИ
   ═══════════════════════════════════════════════════════════════ */

export function renderServices() {
  let h = `
    <div class="section-head">
      <h2>Услуги</h2>
      <p>Каталог и цены</p>
    </div>
    <button class="btn btn-primary btn-block" data-action="add-service"
            style="margin-bottom:12px">
      + Добавить услугу
    </button>
  `;

  if (state.services.length === 0) {
    h += '<div class="empty-box">Услуг пока нет</div>';
    return h;
  }

  h += '<div class="services-list">';
  state.services.forEach(s => {
    const count = state.bookings.filter(
      b => b.serviceId === s.id && b.status !== 'cancelled'
    ).length;
    const hidden = s.active === false;
    h += `
      <div class="service-card" data-edit-svc="${s.id}"
           style="${hidden ? 'opacity:.55' : ''}">
        <div class="sc-icon">${esc(s.icon)}</div>
        <div class="sc-body">
          <h3>
            ${esc(s.name)}
            ${hidden ? '<span style="font-size:.68rem;color:var(--muted);font-weight:500">(скрыта)</span>' : ''}
          </h3>
          <p>${esc(s.desc)}</p>
          <div class="sc-meta">
            <span class="sc-price">${formatMoney(s.price)}</span>
            <span class="sc-dur">· ${s.duration} мин · ${count} ${plural(count, ['запись', 'записи', 'записей'])}</span>
          </div>
        </div>
        <div class="sc-arrow">›</div>
      </div>
    `;
  });
  h += '</div>';

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   5. ОТЧЁТЫ
   ═══════════════════════════════════════════════════════════════ */

export function renderReports() {
  const { from, to } = reportRange();

  const bookings = state.bookings.filter(b =>
    b.date >= from && b.date <= to && b.status === 'done'
  );
  const revenue = bookings.reduce((s, b) => s + b.price, 0);
  const expenses = state.expenses
    .filter(e => e.date >= from && e.date <= to)
    .reduce((s, e) => s + e.amount, 0);
  const profit = revenue - expenses;
  const avgCheck = bookings.length > 0 ? Math.round(revenue / bookings.length) : 0;
  const uniqueClients = new Set(bookings.map(b => b.clientPhone)).size;

  let h = `
    <div class="section-head">
      <h2>Отчёты</h2>
      <p>Аналитика салона</p>
    </div>
    <div class="chips-scroll" style="justify-content:center">
  `;

  [['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё']]
    .forEach(([k, l]) => {
      h += `<button class="chip ${_reportPeriod === k ? 'active' : ''}"
                     data-period="${k}">${l}</button>`;
    });

  h += '</div>';

  // KPI
  h += '<div class="stat-grid">';
  h += `
    <div class="stat large full">
      <div class="lbl">Прибыль</div>
      <div class="val ${profit >= 0 ? 'pos' : 'neg'}">${formatMoney(profit)}</div>
      <div class="sub">${fmtRu(from)} — ${fmtRu(to)}</div>
    </div>
    <div class="stat">
      <div class="lbl">Выручка</div>
      <div class="val">${(revenue / 1000).toFixed(1)}k</div>
      <div class="sub">${bookings.length} ${plural(bookings.length, ['запись', 'записи', 'записей'])}</div>
    </div>
    <div class="stat">
      <div class="lbl">Расходы</div>
      <div class="val">${(expenses / 1000).toFixed(1)}k</div>
    </div>
    <div class="stat">
      <div class="lbl">Средний чек</div>
      <div class="val">${formatMoney(avgCheck)}</div>
    </div>
    <div class="stat">
      <div class="lbl">Клиентов</div>
      <div class="val">${uniqueClients}</div>
    </div>
  `;
  h += '</div>';

  // График по дням
  h += '<div class="dash-chart"><h4>Выручка по дням</h4>';
  const days = buildDaysSeries(from, to);
  const maxVal = Math.max(1, ...days.map(d => d.value));

  h += `<div class="dash-bars" style="grid-template-columns:repeat(${days.length}, 1fr)">`;
  days.forEach(d => {
    const height = d.value === 0 ? 3 : Math.max(10, d.value / maxVal * 75);
    const label = d.value > 0
      ? (d.value >= 1000 ? Math.round(d.value / 100) / 10 + 'k' : d.value)
      : '';
    h += `
      <div class="bar-col">
        <div class="bar-val">${label}</div>
        <div class="bar-fill" data-val="${d.value}" style="height:${height}px"></div>
        <div class="bar-lbl">${d.label}</div>
      </div>
    `;
  });
  h += '</div></div>';

  // Топ услуг
  const svcCount = {};
  bookings.forEach(b => {
    svcCount[b.serviceName] = (svcCount[b.serviceName] || 0) + 1;
  });
  const topSvc = Object.entries(svcCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topSvc.length > 0) {
    h += '<div class="dash-chart"><h4>Топ услуг</h4>';
    topSvc.forEach(([name, count], i) => {
      h += `
        <div class="top-serv">
          <div class="rank">${i + 1}</div>
          <div class="ts-name">${esc(name)}</div>
          <div class="ts-val">${count} ${plural(count, ['запись', 'записи', 'записей'])}</div>
        </div>
      `;
    });
    h += '</div>';
  }

  // Топ клиентов
  const clData = {};
  bookings.forEach(b => {
    const k = b.clientPhone;
    if (!clData[k]) clData[k] = { name: b.clientName, total: 0 };
    clData[k].total += b.price;
  });
  const topCl = Object.values(clData)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  if (topCl.length > 0) {
    h += '<div class="dash-chart"><h4>Топ клиентов</h4>';
    topCl.forEach((c, i) => {
      h += `
        <div class="top-serv">
          <div class="rank">${i + 1}</div>
          <div class="ts-name">${esc(c.name)}</div>
          <div class="ts-val">${formatMoney(c.total)}</div>
        </div>
      `;
    });
    h += '</div>';
  }

  return h;
}

/**
 * Границы отчёта по периоду.
 * @returns {{from: string, to: string}}
 */
function reportRange() {
  const now = new Date();
  const today = todayStr();

  if (_reportPeriod === 'day') {
    return { from: today, to: today };
  }
  if (_reportPeriod === 'week') {
    const wd = (now.getDay() + 6) % 7;
    const from = new Date(now);
    from.setDate(now.getDate() - wd);
    return { from: fmtDate(from), to: today };
  }
  if (_reportPeriod === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: fmtDate(from), to: today };
  }
  // all
  return { from: '2000-01-01', to: '2099-12-31' };
}

/**
 * Данные для графика: [{label, value, date}].
 * Максимум 30 точек — иначе не влезет.
 * @param {string} from
 * @param {string} to
 * @returns {{label: string, value: number, date: string}[]}
 */
function buildDaysSeries(from, to) {
  const start = from < '2020-01-01' ? addDays(todayStr(), -29) : from;
  const end = to > todayStr() ? todayStr() : to;

  const startDate = new Date(
    ...start.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))
  );
  const endDate = new Date(
    ...end.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))
  );

  const days = [];
  const cur = new Date(startDate);
  while (cur <= endDate && days.length < 31) {
    const ds = fmtDate(cur);
    const value = state.bookings
      .filter(b => b.date === ds && b.status === 'done')
      .reduce((s, b) => s + b.price, 0);
    days.push({
      date: ds,
      label: String(cur.getDate()),
      value
    });
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}


/* ═══════════════════════════════════════════════════════════════
   6. РАСХОДЫ
   ═══════════════════════════════════════════════════════════════ */

export function renderExpenses() {
  let h = `
    <div class="section-head">
      <h2>Расходы</h2>
      <p>Учёт затрат салона</p>
    </div>
    <button class="btn btn-primary btn-block" data-action="add-expense"
            style="margin-bottom:12px">
      + Добавить расход
    </button>
  `;

  if (state.expenses.length === 0) {
    h += '<div class="empty-box">Расходов пока нет</div>';
    return h;
  }

  const sorted = [...state.expenses].sort(
    (a, b) => b.date.localeCompare(a.date)
  );

  // Итого за месяц
  const monthPrefix = todayStr().slice(0, 7);
  const monthTotal = state.expenses
    .filter(e => e.date.startsWith(monthPrefix))
    .reduce((s, e) => s + e.amount, 0);

  h += `
    <div class="stat" style="margin-bottom:14px">
      <div class="lbl">За этот месяц</div>
      <div class="val">${formatMoney(monthTotal)}</div>
      <div class="sub">${state.expenses.filter(e => e.date.startsWith(monthPrefix)).length} ${plural(state.expenses.filter(e => e.date.startsWith(monthPrefix)).length, ['запись', 'записи', 'записей'])}</div>
    </div>
  `;

  h += '<div class="b-list">';
  sorted.forEach(e => {
    h += `
      <div class="b-item" data-edit-expense="${e.id}">
        <div class="b-time">
          <b>${e.amount.toLocaleString('ru')}</b>
          <small>₽</small>
        </div>
        <div class="b-info">
          <b>${esc(e.category)}</b>
          <small>${esc(e.note || '—')} · ${fmtRu(e.date)}</small>
        </div>
        <div class="b-right">
          <button class="b-del" data-del-exp="${e.id}"
                  aria-label="Удалить">×</button>
        </div>
      </div>
    `;
  });
  h += '</div>';

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   7. ПРОФИЛЬ АДМИНА
   ═══════════════════════════════════════════════════════════════ */

export function renderAdminProfile() {
  const sub = checkSub();

  const now = new Date();
  const monthPrefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const monthBook = state.bookings.filter(
    b => b.date.startsWith(monthPrefix) && b.status === 'done'
  );
  const monthRev = monthBook.reduce((s, b) => s + b.price, 0);
  const monthExp = state.expenses
    .filter(e => e.date.startsWith(monthPrefix))
    .reduce((s, e) => s + e.amount, 0);
  const monthProfit = monthRev - monthExp;

  let h = `
    <div class="profile-card">
      <div class="profile-avatar">А</div>
      <h2>${esc(state.salon.name || 'BeautyFlow')}</h2>
      ${state.salon.address ? `<div class="phone">${esc(state.salon.address)}</div>` : ''}
      ${state.salon.phone ? `<div class="phone">${esc(state.salon.phone)}</div>` : ''}
      <span class="role-badge admin">Администратор</span>
    </div>
  `;

  // KPI месяца
  h += '<div class="stat-grid">';
  h += `
    <div class="stat large full">
      <div class="lbl">Прибыль месяца</div>
      <div class="val ${monthProfit >= 0 ? 'pos' : 'neg'}">${formatMoney(monthProfit)}</div>
      <div class="sub">Выручка ${formatMoney(monthRev)} − Расходы ${formatMoney(monthExp)}</div>
    </div>
  `;
  h += '</div>';

  // Подписка
  if (sub.active) {
    const days = sub.daysLeft;
    const isTrial = sub.isTrial;
    h += `
      <div class="card" style="background:linear-gradient(135deg,var(--peach-l),#fbecdf);
                               border-color:rgba(201,116,79,.3);margin-bottom:14px">
        <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;
                    font-weight:700;letter-spacing:.05em">Подписка</div>
        <div style="font-family:'Playfair Display',serif;font-size:1.25rem;
                    font-weight:600;margin-top:2px">
          ${isTrial ? 'Пробный период' : PLANS[sub.plan]?.title || sub.plan}
        </div>
        <div style="font-size:.82rem;color:var(--terra-d);margin-top:2px">
          ${days} ${plural(days, ['день', 'дня', 'дней'])} осталось
        </div>
      </div>
    `;
  }

  // Действия
  h += '<div class="action-list">';

  h += `
    <button class="action-row" data-action="go-reports">
      <div class="a-ico">📊</div>
      <div class="a-txt">
        <strong>Отчёты</strong>
        <small>Выручка, графики, топы</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row" data-action="go-expenses">
      <div class="a-ico">💸</div>
      <div class="a-txt">
        <strong>Расходы</strong>
        <small>${state.expenses.length} ${plural(state.expenses.length, ['запись', 'записи', 'записей'])}</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row" data-action="open-settings">
      <div class="a-ico">⚙️</div>
      <div class="a-txt">
        <strong>Рабочие часы</strong>
        <small>${state.workingHours.start} – ${state.workingHours.end}</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row" data-action="open-salon">
      <div class="a-ico">🏠</div>
      <div class="a-txt">
        <strong>Настройки салона</strong>
        <small>Название, адрес, телефон</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row" data-action="open-security">
      <div class="a-ico">🔐</div>
      <div class="a-txt">
        <strong>Безопасность</strong>
        <small>Логин и пароль</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  // PWA install — если браузер дал разрешение
  if (window.__installPrompt) {
    h += `
      <button class="action-row" data-action="install-pwa">
        <div class="a-ico">📲</div>
        <div class="a-txt">
          <strong>Установить приложение</strong>
          <small>Добавить на главный экран</small>
        </div>
        <span class="chev">›</span>
      </button>
    `;
  }

  h += `
    <button class="action-row" data-action="export">
      <div class="a-ico">💾</div>
      <div class="a-txt">
        <strong>Экспорт данных</strong>
        <small>Скачать JSON-бэкап</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row" data-action="import">
      <div class="a-ico">📥</div>
      <div class="a-txt">
        <strong>Импорт данных</strong>
        <small>Восстановить из файла</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row" data-action="reset">
      <div class="a-ico">🔄</div>
      <div class="a-txt">
        <strong>Сбросить демо</strong>
        <small>Удалить всё и залить заново</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += `
    <button class="action-row danger" data-action="logout">
      <div class="a-ico">↩</div>
      <div class="a-txt">
        <strong>Выйти</strong>
        <small>Сменить пользователя</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  h += '</div>';

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   BIND ADMIN EVENTS — вызывается main.js после вставки HTML
   ═══════════════════════════════════════════════════════════════ */

export function bindAdminEvents() {
  // Календарь — отдельная привязка
  bindCalendar(() => refresh());

  // Быстрые действия
  document.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    btn.addEventListener('click', () => handleAction(action));
  });

  // Открыть детали записи
  document.querySelectorAll('[data-open-book]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.openBook;
      openBookingDetail(id);
    });
  });

  // Открыть карточку клиента
  document.querySelectorAll('[data-open-client]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.openClient;
      openClientCard(id);
    });
  });

  // Открыть услугу
  document.querySelectorAll('[data-edit-svc]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.editSvc;
      openServiceEditor(id);
    });
  });

  // Открыть расход
  document.querySelectorAll('[data-edit-expense]').forEach(el => {
    el.addEventListener('click', (e) => {
      // Если кликнули на кнопку удаления — не открываем
      if (e.target.closest('[data-del-exp]')) return;
      const id = el.dataset.editExpense;
      openExpenseEditor(id);
    });
  });

  // Удалить расход (быстрая кнопка)
  document.querySelectorAll('[data-del-exp]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.delExp;
      askConfirm('Удалить расход?', 'Действие необратимо.', async () => {
        const { deleteExpense } = await import('./store.js');
        deleteExpense(id);
        toast('Расход удалён');
        refresh();
      }, { danger: true, yesLabel: 'Удалить' });
    });
  });

  // Период отчётов
  document.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      _reportPeriod = btn.dataset.period;
      refresh();
    });
  });

  // Поиск клиентов
  const searchInput = document.getElementById('clientSearch');
  if (searchInput) {
    const onSearch = debounce((query) => {
      _clientSearchQuery = query;
      const listEl = document.getElementById('clientList');
      if (listEl) {
        listEl.innerHTML = clientListHtml(query);
        // Перевешиваем обработчики на новые карточки
        listEl.querySelectorAll('[data-open-client]').forEach(el => {
          el.addEventListener('click', () => {
            openClientCard(el.dataset.openClient);
          });
        });
      }
    }, 200);

    searchInput.addEventListener('input', (e) => {
      onSearch(e.target.value);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   ОБРАБОТЧИК ДЕЙСТВИЙ
   ═══════════════════════════════════════════════════════════════ */

function handleAction(action) {
  switch (action) {
    case 'go-book':      switchView('book'); break;
    case 'go-clients':   switchView('clients'); break;
    case 'go-reports':   switchView('reports'); break;
    case 'go-expenses':  switchView('expenses'); break;
    case 'open-settings':  openSettings(); break;
    case 'open-salon':     openSalon(); break;
    case 'open-security':  openSecurity(); break;
    case 'add-service':    openServiceEditor(null); break;
    case 'add-client':     openClientCard(null); break;
    case 'add-expense':    openExpenseEditor(null); break;
    case 'import':         openImport(() => refresh()); break;
    case 'export':         exportData(); break;
    case 'install-pwa':    handleInstallPwa(); break;
    case 'reset':          handleReset(); break;
    case 'logout':         handleLogout(); break;
  }
}


/* ═══════════════════════════════════════════════════════════════
   ЭКСПОРТ / ИМПОРТ / УСТАНОВКА / СБРОС / ВЫХОД
   ═══════════════════════════════════════════════════════════════ */

/**
 * Скачать JSON-бэкап состояния.
 */
function exportData() {
  const data = {
    _version: 6,
    _exported: new Date().toISOString(),
    salon: state.salon,
    admin: state.admin,
    workingHours: state.workingHours,
    services: state.services,
    clients: state.clients,
    bookings: state.bookings,
    expenses: state.expenses,
    subscription: state.subscription
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'beautyflow-backup-' + todayStr() + '.json';
  a.click();
  URL.revokeObjectURL(url);

  toast('Файл сохранён');
}

/**
 * Установить PWA (если браузер дал разрешение).
 */
async function handleInstallPwa() {
  const prompt = window.__installPrompt;
  if (!prompt) {
    return toast('Откройте меню браузера → «Установить приложение»');
  }
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') toast('Приложение установлено');
  window.__installPrompt = null;
}

/**
 * Сбросить всё и залить демо заново.
 */
function handleReset() {
  askConfirm(
    'Сбросить демо-данные?',
    'Все текущие данные будут удалены. Действие необратимо.',
    async () => {
      await reset();
      toast('Демо восстановлено');
      window.location.reload();
    },
    { danger: true, yesLabel: 'Сбросить' }
  );
}

/**
 * Выйти из аккаунта — через кнопку в шапке, чтобы не дублировать логику.
 */
function handleLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.click();
}