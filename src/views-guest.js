/**
 * views-guest.js — все гостевые экраны.
 *
 * Экспортирует:
 *   renderPublicHome     — для неавторизованных
 *   renderGuestHome      — главная гостя
 *   renderGuestBook      — запись (услуга + дата + слот)
 *   renderGuestBookings  — «Мои записи»
 *   renderGuestProfile   — профиль гостя
 *
 * Плюс два binder'а:
 *   bindPublicEvents     — для renderPublicHome
 *   bindGuestEvents      — для всех остальных
 *
 * Не хранит persistent-состояние. После мутаций — эмитит 'bf:refresh'.
 */

import {
  state, getService, getBookingsForDate,
  activeServices, myBookings, isSlotFree,
  isOff, setBookingStatus, deleteBooking
} from './store.js';

import {
  esc, toast, buzz, formatMoney, plural,
  todayStr, fmtRu, fmtLong, parseDate,
  t2m, m2t, telHref,
  STATUS_LABEL, MONTHS_GEN
} from './utils.js';

import {
  openLogin, showConfirmBooking, askConfirm,
  calendar, bindCalendar
} from './modals.js';

import { checkSub } from './subscription.js';

import { switchView, showLogin } from './main.js';


/* ═══════════════════════════════════════════════════════════════
   УТИЛИТА
   ═══════════════════════════════════════════════════════════════ */

function refresh() {
  window.dispatchEvent(new CustomEvent('bf:refresh'));
}


/* ═══════════════════════════════════════════════════════════════
   1. ПУБЛИЧНАЯ ГЛАВНАЯ (не залогинен)
   ═══════════════════════════════════════════════════════════════ */

export function renderPublicHome() {
  const salonName = state.salon.name || 'BeautyFlow';
  const address = state.salon.address || '';

  let h = `
    <div class="hero">
      <h1>Красота начинается <em>с записи</em></h1>
      <p>${esc(address || 'Выберите услугу, удобное время и приходите — мы позаботимся об остальном')}</p>
      <button class="btn-main" data-action="login-guest">Записаться</button>
      <button class="btn-link" data-action="login-admin">Вход для администратора</button>
    </div>
  `;

  h += servicesPresentation({ clickable: true, forGuest: false });
  return h;
}


/* ═══════════════════════════════════════════════════════════════
   2. ГЛАВНАЯ ГОСТЯ
   ═══════════════════════════════════════════════════════════════ */

export function renderGuestHome() {
  const today = todayStr();
  const mine = myBookings();
  const upcoming = mine
    .filter(b =>
      b.date >= today &&
      (b.status === 'pending' || b.status === 'confirmed')
    )
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const next = upcoming[0];

  let h = `
    <div class="hero">
      <h1>Здравствуйте, <em>${esc(state.user.name || 'гость')}</em></h1>
      <p>${esc(state.salon.address || 'Ждём вас в нашем салоне')}</p>
      <button class="btn-main" data-action="go-book">Записаться</button>
    </div>
  `;

  // Ближайшая запись
  if (next) {
    const d = parseDate(next.date);
    h += `
      <div class="stat-card highlight" style="background:linear-gradient(135deg,var(--peach-l),#fbecdf);
                                                border:1px solid rgba(201,116,79,.3);
                                                border-radius:18px;padding:16px;margin-bottom:14px">
        <div style="font-size:.66rem;color:var(--muted);text-transform:uppercase;
                    letter-spacing:.06em;font-weight:700">Ближайшая запись</div>
        <div style="font-family:'Playfair Display',serif;font-size:1.35rem;
                    font-weight:600;margin-top:4px">
          ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, ${next.time}
        </div>
        <div style="font-size:.82rem;color:var(--terra-d);margin-top:2px">
          ${esc(next.serviceName)} · ${formatMoney(next.price)}
        </div>
      </div>
    `;
  }

  // Мои предстоящие (максимум 3)
  if (upcoming.length > 1) {
    h += `<h3 class="h3">Предстоящие<span class="count">${upcoming.length}</span></h3>`;
    h += '<div class="b-list">';
    upcoming.slice(0, 3).forEach(b => {
      const d = parseDate(b.date);
      h += `
        <div class="b-item static">
          <div class="b-time">
            <b>${b.time}</b>
            <small>${d.getDate()} ${MONTHS_GEN[d.getMonth()].slice(0, 3)}</small>
          </div>
          <div class="b-info">
            <b>${esc(b.serviceName)}</b>
            <small>${b.duration} мин · ${formatMoney(b.price)}</small>
          </div>
          <div class="b-right">
            <span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span>
          </div>
        </div>
      `;
    });
    h += '</div>';
  }

  // Услуги
  h += servicesPresentation({ clickable: true, forGuest: true });

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   КОМПОНЕНТ: ПРЕЗЕНТАЦИЯ УСЛУГ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Список активных услуг. Кликабельный — ведёт в запись.
 *
 * @param {{clickable?: boolean, forGuest?: boolean}} opts
 * @returns {string}
 */
function servicesPresentation(opts = {}) {
  const { clickable = true } = opts;
  const list = activeServices();

  if (list.length === 0) {
    return '<div class="empty-box">Услуги пока не добавлены</div>';
  }

  let h = `<h3 class="h3">Наши услуги<span class="count">${list.length}</span></h3>`;
  h += '<div class="services-list">';

  list.forEach(s => {
    h += `
      <div class="service-card" ${clickable ? `data-svc="${s.id}"` : ''}
           style="${clickable ? 'cursor:pointer' : ''}">
        <div class="sc-icon">${esc(s.icon)}</div>
        <div class="sc-body">
          <h3>${esc(s.name)}</h3>
          <p>${esc(s.desc)}</p>
          <div class="sc-meta">
            <span class="sc-price">${formatMoney(s.price)}</span>
            <span class="sc-dur">· ${s.duration} мин</span>
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
   3. ЗАПИСЬ — услуга + дата + слот
   ═══════════════════════════════════════════════════════════════ */

export function renderGuestBook() {
  let h = `
    <div class="section-head">
      <h2>Запись</h2>
      <p>Выберите услугу, дату и время</p>
    </div>
  `;

  // ─── Чипы услуг ───
  const list = activeServices();
  if (list.length === 0) {
    h += '<div class="empty-box">Нет доступных услуг</div>';
    return h;
  }

  h += '<div style="margin-bottom:12px">';
  h += `
    <div style="font-size:.72rem;color:var(--muted);font-weight:600;
                margin-bottom:6px;padding:0 2px;text-transform:uppercase;
                letter-spacing:.04em">
      Услуга
    </div>
  `;
  h += '<div class="chips-scroll">';
  list.forEach(s => {
    const active = state.selectedServiceId === s.id;
    h += `
      <button class="chip ${active ? 'active' : ''}" data-svc-chip="${s.id}">
        ${esc(s.icon)} ${esc(s.name)}
      </button>
    `;
  });
  h += '</div></div>';

  // ─── Календарь ───
  h += calendar();

  // ─── Слоты ───
  if (state.selectedDate && state.selectedServiceId) {
    h += renderSlots();
  } else if (state.selectedDate && !state.selectedServiceId) {
    h += '<div class="empty-box">Выберите услугу</div>';
  }

  return h;
}


/**
 * Сетка слотов для выбранной услуги и даты.
 * Учитывает длительность, пересечения, свои записи, рабочие часы.
 * @returns {string}
 */
function renderSlots() {
  const ds = state.selectedDate;
  const svc = getService(state.selectedServiceId);
  if (!svc) return '';

  const dayBookings = getBookingsForDate(ds)
    .filter(b => b.status !== 'cancelled' && b.status !== 'noshow');

  const start = t2m(state.workingHours.start);
  const end = t2m(state.workingHours.end);
  const dur = svc.duration;
  const step = 30;

  let h = `
    <div style="text-align:center;margin:8px 0 6px;
                font-family:'Playfair Display',serif;
                font-size:1.05rem;font-weight:600;color:var(--terra-d)">
      ${fmtLong(ds)}
    </div>
    <div class="slots-info">
      ${esc(svc.name)} · ${dur} мин · ${formatMoney(svc.price)}
    </div>
    <div class="slots-grid">
  `;

  let anyFree = false;

  for (let t = start; t + dur <= end; t += step) {
    const time = m2t(t);
    const slotEnd = t + dur;

    // Ищем пересечение с записями
    const conflict = dayBookings.find(b => {
      const bStart = t2m(b.time);
      const bEnd = bStart + b.duration;
      return t < bEnd && slotEnd > bStart;
    });

    if (conflict) {
      const isMine = conflict.clientPhone.replace(/\D/g, '') ===
                     state.user.phone.replace(/\D/g, '');
      h += `
        <button class="slot-btn booked ${isMine ? 'mine' : ''}" disabled>
          <b>${time}</b>
          <small>${isMine ? 'Ваша' : 'Занято'}</small>
        </button>
      `;
    } else {
      anyFree = true;
      h += `
        <button class="slot-btn free" data-slot="${time}">
          <b>${time}</b>
          <small>Свободно</small>
        </button>
      `;
    }
  }

  h += '</div>';

  if (!anyFree) {
    h += '<div class="empty-box" style="margin-top:6px">На этот день свободных слотов нет</div>';
  }

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   4. МОИ ЗАПИСИ
   ═══════════════════════════════════════════════════════════════ */

export function renderGuestBookings() {
  const mine = myBookings();
  const today = todayStr();

  let h = `
    <div class="section-head">
      <h2>Мои записи</h2>
      <p>История и статусы</p>
    </div>
  `;

  if (mine.length === 0) {
    h += `
      <div class="empty-box" style="padding:32px 20px;text-align:center">
        <div style="font-size:2rem;margin-bottom:12px">📅</div>
        <div style="font-weight:700;margin-bottom:6px">Записей пока нет</div>
        <div style="font-size:.82rem;color:var(--muted);margin-bottom:16px">
          Запишитесь на удобное время — это займёт минуту
        </div>
        <button class="btn btn-primary" data-action="go-book">
          Записаться
        </button>
      </div>
    `;
    return h;
  }

  // Разделяем: предстоящие и прошлые
  const upcoming = mine
    .filter(b => (b.date + b.time) >= (today + '00:00') &&
                 b.status !== 'cancelled' && b.status !== 'noshow')
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const history = mine
    .filter(b => (b.date + b.time) < (today + '00:00') ||
                 b.status === 'cancelled' || b.status === 'noshow' ||
                 b.status === 'done');

  // Предстоящие
  if (upcoming.length > 0) {
    h += `<h3 class="h3">Предстоящие<span class="count">${upcoming.length}</span></h3>`;
    h += '<div class="b-list">';
    upcoming.forEach(b => {
      const d = parseDate(b.date);
      const canCancel = b.status === 'pending' || b.status === 'confirmed';
      h += `
        <div class="b-item static">
          <div class="b-time">
            <b>${b.time}</b>
            <small>${d.getDate()} ${MONTHS_GEN[d.getMonth()].slice(0, 3)}</small>
          </div>
          <div class="b-info">
            <b>${esc(b.serviceName)}</b>
            <small>${b.duration} мин · ${formatMoney(b.price)} ·
              <span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span>
            </small>
          </div>
          ${canCancel ? `
            <button class="b-del" data-cancel="${b.id}"
                    aria-label="Отменить">×</button>
          ` : ''}
        </div>
      `;
    });
    h += '</div>';
  }

  // История
  if (history.length > 0) {
    h += `<h3 class="h3">История<span class="count">${history.length}</span></h3>`;
    h += '<div class="b-list">';
    history.forEach(b => {
      const d = parseDate(b.date);
      h += `
        <div class="b-item static" style="opacity:.7">
          <div class="b-time">
            <b>${b.time}</b>
            <small>${d.getDate()} ${MONTHS_GEN[d.getMonth()].slice(0, 3)}</small>
          </div>
          <div class="b-info">
            <b>${esc(b.serviceName)}</b>
            <small>
              <span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span> ·
              ${formatMoney(b.price)}
            </small>
          </div>
        </div>
      `;
    });
    h += '</div>';
  }

  return h;
}


/* ═══════════════════════════════════════════════════════════════
   5. ПРОФИЛЬ ГОСТЯ
   ═══════════════════════════════════════════════════════════════ */

export function renderGuestProfile() {
  const mine = myBookings();
  const initial = (state.user.name || 'Г').charAt(0).toUpperCase();

  const doneCount = mine.filter(b => b.status === 'done').length;
  const totalSpent = mine
    .filter(b => b.status === 'done' || b.status === 'confirmed')
    .reduce((s, b) => s + b.price, 0);

  let h = `
    <div class="profile-card">
      <div class="profile-avatar">${esc(initial)}</div>
      <h2>${esc(state.user.name)}</h2>
      <div class="phone">${esc(state.user.phone)}</div>
      <span class="role-badge guest">Гость</span>
    </div>

    <div class="stat-grid" style="margin-top:14px">
      <div class="stat">
        <div class="lbl">Визитов</div>
        <div class="val">${doneCount}</div>
      </div>
      <div class="stat">
        <div class="lbl">Потрачено</div>
        <div class="val">${(totalSpent / 1000).toFixed(1)}k</div>
        <div class="sub">₽</div>
      </div>
    </div>
  `;

  h += '<div class="action-list">';

  h += `
    <button class="action-row" data-action="go-book">
      <div class="a-ico">📅</div>
      <div class="a-txt">
        <strong>Записаться</strong>
        <small>Выбрать услугу и время</small>
      </div>
      <span class="chev">›</span>
    </button>
  `;

  // PWA — только если браузер дал разрешение
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
   BIND PUBLIC EVENTS (не залогинен)
   ═══════════════════════════════════════════════════════════════ */

export function bindPublicEvents() {
  // Клик на услугу в презентации
  document.querySelectorAll('[data-svc]').forEach(el => {
    el.addEventListener('click', () => {
      const svcId = el.dataset.svc;
      state.selectedServiceId = svcId;
      // Не залогинен → логин → переход в запись
      showLogin('guest');
    });
  });

  // Кнопки в hero
  const loginGuestBtn = document.querySelector('[data-action="login-guest"]');
  if (loginGuestBtn) {
    loginGuestBtn.addEventListener('click', () => showLogin('guest'));
  }

  const loginAdminBtn = document.querySelector('[data-action="login-admin"]');
  if (loginAdminBtn) {
    loginAdminBtn.addEventListener('click', () => showLogin('admin'));
  }
}


/* ═══════════════════════════════════════════════════════════════
   BIND GUEST EVENTS (залогинен как гость)
   ═══════════════════════════════════════════════════════════════ */

export function bindGuestEvents() {
  // Календарь
  bindCalendar(() => refresh());

  // Клик на услугу в презентации (на главной)
  document.querySelectorAll('[data-svc]').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedServiceId = el.dataset.svc;
      switchView('book');
    });
  });

  // Чипы услуг (в брони)
  document.querySelectorAll('[data-svc-chip]').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedServiceId = el.dataset.svcChip;
      buzz(6);
      refresh();
    });
  });

  // Клик на слот — бронирование
  document.querySelectorAll('[data-slot]').forEach(el => {
    el.addEventListener('click', () => {
      if (!state.selectedServiceId) return toast('Выберите услугу');

      const slot = {
        date: state.selectedDate,
        time: el.dataset.slot,
        serviceId: state.selectedServiceId
      };

      showConfirmBooking(slot, () => {
        // После бронирования — перейти в «Мои записи»
        switchView('my');
      });
    });
  });

  // Отмена записи
  document.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.cancel;
      const booking = state.bookings.find(b => b.id === id);
      if (!booking) return;

      askConfirm(
        'Отменить запись?',
        `${booking.serviceName} — ${fmtRu(booking.date)} в ${booking.time}. ` +
        `Слот освободится для других гостей.`,
        () => {
          setBookingStatus(id, 'cancelled');
          toast('Запись отменена');
          refresh();
        },
        { danger: true, yesLabel: 'Отменить' }
      );
    });
  });

  // Действия из профиля и других экранов
  document.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    btn.addEventListener('click', () => handleAction(action));
  });
}


/* ═══════════════════════════════════════════════════════════════
   ОБРАБОТЧИК ДЕЙСТВИЙ
   ═══════════════════════════════════════════════════════════════ */

function handleAction(action) {
  switch (action) {
    case 'go-book':
      switchView('book');
      break;

    case 'install-pwa':
      handleInstallPwa();
      break;

    case 'logout':
      handleLogout();
      break;
  }
}


/* ═══════════════════════════════════════════════════════════════
   PWA / LOGOUT
   ═══════════════════════════════════════════════════════════════ */

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

function handleLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.click();
}