/**
 * modals.js — все диалоги приложения.
 *
 * Принципы:
 *  1. openModal() возвращает элемент → внутри модалки ищем через modal.querySelector,
 *     а не document.getElementById (надёжнее при нескольких модалках).
 *  2. Все кнопки привязываются явно + проверка на существование.
 *  3. submitGuest/submitAdmin — async, await saveImmediate() ДО closeModal.
 *  4. Никаких views-импортов: после сохранения — onSaved() или 'bf:refresh'.
 */

import {
  state, getService, getClient, getBookingsForDate,
  upsertService, deleteService, upsertClient, deleteClient,
  setBookingStatus, deleteBooking, upsertExpense, deleteExpense,
  setSalon, setWorkingHours, setAdminCreds,
  ensureClient, addBooking, isSlotFree, isOff,
  saveImmediate
} from './store.js';

import {
  esc, toast, buzz,
  formatPhone, validPhone, telHref,
  todayStr, fmtRu, fmtLong, fmtDate, fmtMonthYear,
  weekdayIndex, monthDays, t2m, uid, hashPass,
  STATUS_LABEL, STATUS_COLOR,
  WD_SHORT
} from './utils.js';

import { platform } from './platform.js';


/* ═══════════════════════════════════════════════════════════════
   1. БАЗОВЫЕ ПРИМИТИВЫ
   ═══════════════════════════════════════════════════════════════ */

/** Текущая открытая модалка: { el, onClose }. */
let _currentModal = null;

/** Колбэк для askConfirm. */
let _confirmCallback = null;

/**
 * Открыть модалку с HTML. Возвращает корневой элемент.
 * Автоматически: монтирует в #modalRoot, блокирует скролл, вешает
 * закрытие на [data-close], клик по backdrop, Escape.
 *
 * @param {string} html — полный HTML, начинается с <div class="modal">...</div>
 * @param {{ onClose?: () => void }} [opts]
 * @returns {HTMLElement|null}
 */
export function openModal(html, opts = {}) {
  closeModal();

  const root = document.getElementById('modalRoot');
  if (!root) {
    console.error('[modals] #modalRoot не найден в DOM');
    return null;
  }

  root.innerHTML = html;
  const modalEl = root.firstElementChild;
  if (!modalEl) {
    console.error('[modals] пустой HTML — модалка не создана');
    return null;
  }

  _currentModal = { el: modalEl, onClose: opts.onClose };

  const view = document.getElementById('view');
  if (view) view.style.overflow = 'hidden';

  // Закрытие по backdrop
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeModal();
  });

  // Кнопки с [data-close]
  modalEl.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', closeModal);
  });

  // Автофокус на десктопе (не на мобилке — там зум)
  if (window.matchMedia('(min-width: 768px)').matches) {
    setTimeout(() => {
      const firstInput = modalEl.querySelector(
        'input:not([type=hidden]):not([disabled]), textarea'
      );
      if (firstInput) firstInput.focus();
    }, 100);
  }

  return modalEl;
}

/** Закрыть текущую модалку. */
export function closeModal() {
  if (!_currentModal) return;
  const { el, onClose } = _currentModal;
  _currentModal = null;

  el.remove();
  const root = document.getElementById('modalRoot');
  if (root) root.innerHTML = '';

  // Восстанавливаем скролл
  const view = document.getElementById('view');
  if (view && !document.querySelector('.modal')) {
    view.style.overflow = '';
  }

  if (typeof onClose === 'function') onClose();
}

// Escape — один глобальный обработчик
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _currentModal) closeModal();
});

/**
 * Универсальный confirm. Замена window.confirm.
 *
 * @param {string} title
 * @param {string} text
 * @param {() => void} onYes
 * @param {{ yesLabel?: string, noLabel?: string, danger?: boolean }} [opts]
 */
export function askConfirm(title, text, onYes, opts = {}) {
  const { yesLabel = 'Подтвердить', noLabel = 'Отмена', danger = false } = opts;
  _confirmCallback = onYes;

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <p style="font-size:.9rem;color:var(--muted);margin-bottom:16px">
          ${esc(text)}
        </p>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>${esc(noLabel)}</button>
          <button class="${danger ? 'btn-danger' : 'btn-save'}" id="askConfirmYes">
            ${esc(yesLabel)}
          </button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  const yesBtn = modal.querySelector('#askConfirmYes');
  if (yesBtn) {
    yesBtn.addEventListener('click', () => {
      const cb = _confirmCallback;
      _confirmCallback = null;
      closeModal();
      if (typeof cb === 'function') cb();
    });
  }
}

/**
 * Сообщить приложению, что данные изменились.
 * Если onSaved — вызвать его, иначе эмитить 'bf:refresh'.
 */
function notifySaved(onSaved) {
  if (typeof onSaved === 'function') onSaved();
  else window.dispatchEvent(new CustomEvent('bf:refresh'));
}


/* ═══════════════════════════════════════════════════════════════
   2. ЛОГИН — гость и админ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Модалка входа. Гость (имя + телефон) или админ (логин + пароль).
 *
 * @param {'guest'|'admin'} initialRole
 * @param {() => void} [onLogin] — вызывается после успешного входа
 */
export function openLogin(initialRole = 'guest', onLogin) {
  const isAdminTab = initialRole === 'admin';

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Вход</h3>
          <button class="close-x" data-close>×</button>
        </div>

        <div class="login-tabs">
          <button class="login-tab ${isAdminTab ? '' : 'active'}" data-tab="guest">Я клиент</button>
          <button class="login-tab ${isAdminTab ? 'active' : ''}" data-tab="admin">Я админ</button>
        </div>

        <!-- Форма гостя -->
        <div id="guestLoginForm" ${isAdminTab ? 'style="display:none"' : ''}>
          <div class="form-group">
            <label>Ваше имя</label>
            <input type="text" id="guestName" placeholder="Например, Мария"
                   maxlength="30" autocomplete="given-name"
                   value="${esc(state.user.name || '')}">
          </div>
          <div class="form-group">
            <label>Телефон для связи</label>
            <input type="tel" id="guestPhone" placeholder="+7 (___) ___-__-__"
                   autocomplete="tel" maxlength="18"
                   value="${esc(state.user.phone || '')}">
          </div>
          <p style="font-size:.76rem;color:var(--muted);margin-bottom:6px">
            Мастер свяжется по нему, если потребуется
          </p>
          <div class="modal-actions">
            <button class="btn-save" id="guestSubmit" style="flex:1">Продолжить</button>
          </div>
        </div>

        <!-- Форма админа -->
        <div id="adminLoginForm" ${isAdminTab ? '' : 'style="display:none"'}>
          <div class="hint-box">
            Логин и пароль выданы при регистрации салона.
            ${platform.isVK ? ' В VK-приложении вход автоматический.' : ''}
          </div>
          <div class="form-group">
            <label>Логин</label>
            <input type="text" id="adminLogin" placeholder="admin"
                   autocomplete="username">
          </div>
          <div class="form-group">
            <label>Пароль</label>
            <input type="password" id="adminPassword" placeholder="••••••••"
                   autocomplete="current-password">
          </div>
          <div class="modal-actions">
            <button class="btn-save" id="adminSubmit" style="flex:1">Войти</button>
          </div>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  /* ─── Ссылки на элементы ─── */
  const guestForm   = modal.querySelector('#guestLoginForm');
  const adminForm   = modal.querySelector('#adminLoginForm');
  const guestName   = modal.querySelector('#guestName');
  const guestPhone  = modal.querySelector('#guestPhone');
  const adminLogin  = modal.querySelector('#adminLogin');
  const adminPass   = modal.querySelector('#adminPassword');
  const guestSubmitBtn = modal.querySelector('#guestSubmit');
  const adminSubmitBtn = modal.querySelector('#adminSubmit');

  /* ─── Табы ─── */
  modal.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const role = tab.dataset.tab;
      modal.querySelectorAll('.login-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === role);
      });
      if (guestForm) guestForm.style.display = role === 'guest' ? '' : 'none';
      if (adminForm) adminForm.style.display = role === 'admin' ? '' : 'none';
    });
  });

  /* ─── Маска телефона ─── */
  if (guestPhone) {
    guestPhone.addEventListener('input', (e) => {
      e.target.value = formatPhone(e.target.value);
    });
  }

  /* ─── submitGuest ─── */
  async function submitGuest() {
    console.log('[login] submitGuest вызвана');

    const name = (guestName?.value || '').trim();
    const phone = guestPhone?.value || '';

    if (name.length < 2) return toast('Введите имя');
    if (!validPhone(phone)) return toast('Введите телефон полностью');

    state.role = 'guest';
    state.user = { name, phone };
    ensureClient(name, phone);

    try {
      await saveImmediate();
      console.log('[login] роль guest сохранена');
    } catch (e) {
      console.error('[login] saveImmediate упал:', e);
      return toast('Ошибка сохранения');
    }

    closeModal();
    buzz(20);
    toast(`Добро пожаловать, ${name}`);
    notifySaved(onLogin);
  }

  /* ─── submitAdmin ─── */
  async function submitAdmin() {
    console.log('[login] submitAdmin вызвана');

    const login = (adminLogin?.value || '').trim();
    const pass = adminPass?.value || '';

    if (login !== state.admin.login) {
      console.log('[login] логин не совпал:', login, '!==', state.admin.login);
      return toast('Неверный логин');
    }
    if (hashPass(pass) !== state.admin.passwordHash) {
      console.log('[login] пароль не совпал');
      return toast('Неверный пароль');
    }

    state.role = 'admin';
    state.user = { name: 'Администратор', phone: '' };

    try {
      await saveImmediate();
      console.log('[login] роль admin сохранена');
    } catch (e) {
      console.error('[login] saveImmediate упал:', e);
      return toast('Ошибка сохранения');
    }

    closeModal();
    buzz(20);
    toast('Режим администратора');
    notifySaved(onLogin);
  }

  /* ─── ПРИВЯЗКА КНОПОК ─── */
  if (guestSubmitBtn) {
    guestSubmitBtn.addEventListener('click', submitGuest);
    console.log('[login] кнопка guest привязана');
  }
  if (adminSubmitBtn) {
    adminSubmitBtn.addEventListener('click', submitAdmin);
    console.log('[login] кнопка admin привязана');
  }

  /* ─── Enter для перехода между полями ─── */
  if (guestName && guestPhone) {
    guestName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') guestPhone.focus();
    });
    guestPhone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitGuest();
    });
  }
  if (adminLogin && adminPass) {
    adminLogin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') adminPass.focus();
    });
    adminPass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdmin();
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   3. РАБОЧИЕ ЧАСЫ
   ═══════════════════════════════════════════════════════════════ */

export function openSettings(onSaved) {
  const wh = state.workingHours;
  const daysOff = new Set(wh.daysOff);

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Рабочие часы</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Начало</label>
            <input type="time" id="whStart" value="${esc(wh.start)}">
          </div>
          <div class="form-group">
            <label>Конец</label>
            <input type="time" id="whEnd" value="${esc(wh.end)}">
          </div>
        </div>
        <div class="form-group">
          <label>Выходные дни</label>
          <div class="days-grid" id="whDaysOff"></div>
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="whSave">Сохранить</button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  const daysGrid = modal.querySelector('#whDaysOff');
  WD_SHORT.forEach((label, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-chip' + (daysOff.has(idx) ? ' on' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (daysOff.has(idx)) daysOff.delete(idx);
      else daysOff.add(idx);
      btn.classList.toggle('on', daysOff.has(idx));
    });
    daysGrid.appendChild(btn);
  });

  const saveBtn = modal.querySelector('#whSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const start = modal.querySelector('#whStart').value;
      const end = modal.querySelector('#whEnd').value;
      if (!start || !end) return toast('Заполните часы');
      if (t2m(start) >= t2m(end)) return toast('Начало должно быть раньше конца');

      setWorkingHours({
        start, end,
        daysOff: [...daysOff].sort((a, b) => a - b)
      });

      if (state.selectedDate && isOff(new Date(state.selectedDate))) {
        state.selectedDate = todayStr();
      }

      closeModal();
      toast('Рабочие часы обновлены');
      notifySaved(onSaved);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   4. НАСТРОЙКИ САЛОНА
   ═══════════════════════════════════════════════════════════════ */

export function openSalon(onSaved) {
  const s = state.salon;

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Настройки салона</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="form-group">
          <label>Название</label>
          <input type="text" id="salonName" maxlength="40"
                 value="${esc(s.name || '')}">
        </div>
        <div class="form-group">
          <label>Адрес</label>
          <input type="text" id="salonAddr" maxlength="80"
                 placeholder="г. Москва, ул. Примерная, 1"
                 value="${esc(s.address || '')}">
        </div>
        <div class="form-group">
          <label>Телефон</label>
          <input type="tel" id="salonPhone" maxlength="18"
                 placeholder="+7 (___) ___-__-__"
                 value="${esc(s.phone || '')}">
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="salonSave">Сохранить</button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  const phoneInput = modal.querySelector('#salonPhone');
  phoneInput.addEventListener('input', (e) => {
    e.target.value = formatPhone(e.target.value);
  });

  const saveBtn = modal.querySelector('#salonSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const name = modal.querySelector('#salonName').value.trim() || 'BeautyFlow';
      const address = modal.querySelector('#salonAddr').value.trim();
      const phone = phoneInput.value.trim();
      if (phone && !validPhone(phone)) return toast('Телефон неполный');

      setSalon({ name, address, phone });
      closeModal();
      toast('Настройки сохранены');
      notifySaved(onSaved);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   5. БЕЗОПАСНОСТЬ (смена логина/пароля)
   ═══════════════════════════════════════════════════════════════ */

export function openSecurity(onSaved) {
  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Безопасность</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="form-group">
          <label>Текущий пароль *</label>
          <input type="password" id="secOldPass" autocomplete="current-password">
        </div>
        <div class="form-group">
          <label>Новый пароль (мин. 6)</label>
          <input type="password" id="secNewPass" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label>Повторите новый пароль</label>
          <input type="password" id="secNewPass2" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label>Новый логин (опционально)</label>
          <input type="text" id="secNewLogin" maxlength="20"
                 placeholder="${esc(state.admin.login)}">
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="secSave">Обновить</button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  const saveBtn = modal.querySelector('#secSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const oldPass = modal.querySelector('#secOldPass').value;
      const newPass = modal.querySelector('#secNewPass').value;
      const newPass2 = modal.querySelector('#secNewPass2').value;
      const newLogin = modal.querySelector('#secNewLogin').value.trim();

      if (hashPass(oldPass) !== state.admin.passwordHash) {
        return toast('Текущий пароль неверный');
      }
      if (!newPass && !newPass2 && !newLogin) {
        return toast('Заполните хотя бы одно поле');
      }

      const changes = {};
      if (newPass || newPass2) {
        if (newPass.length < 6) return toast('Пароль от 6 символов');
        if (newPass !== newPass2) return toast('Пароли не совпадают');
        changes.passwordHash = hashPass(newPass);
      }
      if (newLogin) {
        if (newLogin.length < 3) return toast('Логин от 3 символов');
        changes.login = newLogin;
      }

      setAdminCreds(changes);
      closeModal();
      toast('Данные обновлены');
      notifySaved(onSaved);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   6. РЕДАКТОР УСЛУГИ
   ═══════════════════════════════════════════════════════════════ */

export function openServiceEditor(serviceId = null, onSaved) {
  const existing = serviceId ? getService(serviceId) : null;
  const isNew = !existing;

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>${isNew ? 'Новая услуга' : 'Редактировать услугу'}</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Иконка</label>
            <input type="text" id="svcIcon" maxlength="4"
                   placeholder="✂️" value="${esc(existing?.icon || '')}">
          </div>
          <div class="form-group">
            <label>Длительность</label>
            <select id="svcDur">
              ${[30, 45, 60, 90, 120, 150].map(d =>
                `<option value="${d}" ${existing?.duration === d ? 'selected' : ''}>${d} мин</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Название *</label>
          <input type="text" id="svcName" maxlength="40"
                 value="${esc(existing?.name || '')}">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <textarea id="svcDesc" maxlength="120">${esc(existing?.desc || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Цена, ₽ *</label>
          <input type="number" id="svcPrice" min="0" step="100"
                 value="${existing?.price ?? ''}">
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="svcActive" style="width:auto"
                   ${existing?.active !== false ? 'checked' : ''}>
            Показывать гостям
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="svcSave">Сохранить</button>
        </div>
        ${!isNew ? `
          <div class="modal-actions" style="margin-top:8px">
            <button class="btn-danger" id="svcDelete" style="flex:1">Удалить услугу</button>
          </div>
        ` : ''}
      </div>
    </div>
  `);
  if (!modal) return;

  const saveBtn = modal.querySelector('#svcSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const icon = modal.querySelector('#svcIcon').value.trim() || '✨';
      const name = modal.querySelector('#svcName').value.trim();
      const desc = modal.querySelector('#svcDesc').value.trim();
      const price = parseInt(modal.querySelector('#svcPrice').value, 10) || 0;
      const duration = parseInt(modal.querySelector('#svcDur').value, 10) || 60;
      const active = modal.querySelector('#svcActive').checked;

      if (!name) return toast('Введите название');
      if (price <= 0) return toast('Укажите цену');

      upsertService({
        id: existing?.id || uid('s'),
        icon, name, desc, price, duration, active
      });
      closeModal();
      toast(isNew ? 'Услуга добавлена' : 'Услуга обновлена');
      notifySaved(onSaved);
    });
  }

  const deleteBtn = modal.querySelector('#svcDelete');
  if (deleteBtn && existing) {
    deleteBtn.addEventListener('click', () => {
      const activeBookings = state.bookings.filter(
        b => b.serviceId === existing.id &&
             b.status !== 'cancelled' && b.status !== 'noshow' &&
             b.date >= todayStr()
      );
      const msg = activeBookings.length > 0
        ? `На эту услугу ${activeBookings.length} активных записей. Удалить всё равно?`
        : 'Услуга будет удалена.';
      askConfirm('Удалить услугу?', msg, () => {
        deleteService(existing.id);
        closeModal();
        toast('Услуга удалена');
        notifySaved(onSaved);
      }, { danger: true, yesLabel: 'Удалить' });
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   7. КАРТОЧКА КЛИЕНТА
   ═══════════════════════════════════════════════════════════════ */

export function openClientCard(clientId = null, onSaved) {
  const existing = clientId ? getClient(clientId) : null;
  const isNew = !existing;

  const bookings = existing
    ? state.bookings.filter(b => b.clientId === existing.id) : [];
  const doneBookings = bookings.filter(b => b.status === 'done');
  const ltv = doneBookings.reduce((s, b) => s + b.price, 0);
  const lastVisit = doneBookings
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))[0]?.date;

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>${isNew ? 'Новый клиент' : 'Клиент'}</h3>
          <button class="close-x" data-close>×</button>
        </div>

        ${!isNew ? `
          <div class="stat-grid" style="margin-bottom:14px">
            <div class="stat"><div class="lbl">Визитов</div>
              <div class="val">${doneBookings.length}</div></div>
            <div class="stat"><div class="lbl">LTV</div>
              <div class="val">${ltv.toLocaleString('ru')} ₽</div></div>
            <div class="stat" style="grid-column:1/-1">
              <div class="lbl">Последний визит</div>
              <div class="val" style="font-size:1.05rem">
                ${lastVisit ? fmtRu(lastVisit) : '—'}
              </div>
            </div>
          </div>
        ` : ''}

        <div class="form-group">
          <label>Имя *</label>
          <input type="text" id="clName" maxlength="40"
                 value="${esc(existing?.name || '')}">
        </div>
        <div class="form-group">
          <label>Телефон *</label>
          <input type="tel" id="clPhone" maxlength="18"
                 placeholder="+7 (___) ___-__-__"
                 value="${esc(existing?.phone || '')}">
        </div>
        <div class="form-group">
          <label>Заметки</label>
          <textarea id="clNotes" maxlength="300">${esc(existing?.notes || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Теги (через запятую)</label>
          <input type="text" id="clTags" maxlength="100"
                 placeholder="VIP, аллергия на аммиак"
                 value="${esc((existing?.tags || []).join(', '))}">
        </div>

        ${!isNew && bookings.length > 0 ? `
          <div style="margin-top:12px">
            <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;
                        font-weight:700;margin-bottom:6px">
              История (${bookings.length})
            </div>
            ${bookings.slice(0, 5).map(b => `
              <div class="detail-row" style="font-size:.8rem">
                <span class="k">${fmtRu(b.date)} · ${b.time}</span>
                <span class="v">${esc(b.serviceName)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="clSave">Сохранить</button>
        </div>
        ${!isNew ? `
          <div class="modal-actions" style="margin-top:8px">
            <button class="btn-danger" id="clDelete" style="flex:1">Удалить клиента</button>
          </div>
        ` : ''}
      </div>
    </div>
  `);
  if (!modal) return;

  const phoneInput = modal.querySelector('#clPhone');
  phoneInput.addEventListener('input', (e) => {
    e.target.value = formatPhone(e.target.value);
  });

  const saveBtn = modal.querySelector('#clSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const name = modal.querySelector('#clName').value.trim();
      const phone = phoneInput.value.trim();
      const notes = modal.querySelector('#clNotes').value.trim();
      const tagsRaw = modal.querySelector('#clTags').value.trim();
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

      if (name.length < 2) return toast('Введите имя');
      if (!validPhone(phone)) return toast('Введите телефон полностью');

      const dup = state.clients.find(c =>
        c.phone.replace(/\D/g, '') === phone.replace(/\D/g, '') &&
        c.id !== existing?.id
      );
      if (dup) return toast('Клиент с таким телефоном уже есть');

      upsertClient({
        id: existing?.id || uid('c'),
        name, phone, notes, tags,
        createdAt: existing?.createdAt || Date.now()
      });
      closeModal();
      toast(isNew ? 'Клиент добавлен' : 'Клиент обновлён');
      notifySaved(onSaved);
    });
  }

  const deleteBtn = modal.querySelector('#clDelete');
  if (deleteBtn && existing) {
    deleteBtn.addEventListener('click', () => {
      const activeBookings = state.bookings.filter(
        b => b.clientId === existing.id &&
             b.status !== 'cancelled' && b.date >= todayStr()
      );
      const msg = activeBookings.length > 0
        ? `У клиента ${activeBookings.length} активных записей. Удалить клиента?`
        : 'Карточка клиента будет удалена. История записей сохранится.';
      askConfirm('Удалить клиента?', msg, () => {
        deleteClient(existing.id);
        closeModal();
        toast('Клиент удалён');
        notifySaved(onSaved);
      }, { danger: true, yesLabel: 'Удалить' });
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   8. ДЕТАЛИ ЗАПИСИ
   ═══════════════════════════════════════════════════════════════ */

export function openBookingDetail(bookingId, onSaved) {
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) return toast('Запись не найдена');

  const statuses = ['pending', 'confirmed', 'done', 'noshow', 'cancelled'];

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Запись</h3>
          <button class="close-x" data-close>×</button>
        </div>

        <div class="detail-row"><span class="k">Дата</span>
          <span class="v">${fmtLong(b.date)}</span></div>
        <div class="detail-row"><span class="k">Время</span>
          <span class="v">${b.time} · ${b.duration} мин</span></div>
        <div class="detail-row"><span class="k">Услуга</span>
          <span class="v">${esc(b.serviceName)}</span></div>
        <div class="detail-row"><span class="k">Цена</span>
          <span class="v">${b.price.toLocaleString('ru')} ₽</span></div>
        <div class="detail-row"><span class="k">Клиент</span>
          <span class="v">${esc(b.clientName)}</span></div>
        <div class="detail-row"><span class="k">Телефон</span>
          <span class="v">
            <a href="${telHref(b.clientPhone)}"
               style="color:var(--terra-d);text-decoration:none;font-weight:700">
              ${esc(b.clientPhone)}
            </a>
          </span></div>
        <div class="detail-row"><span class="k">Статус</span>
          <span class="v">
            <span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span>
          </span></div>

        <div style="margin-top:14px">
          <div style="font-size:.76rem;color:var(--muted);font-weight:700;
                      text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
            Сменить статус
          </div>
          <div class="status-actions">
            ${statuses.map(s => {
              const isActive = b.status === s;
              const color = STATUS_COLOR[s];
              return `
                <button class="status-btn ${isActive ? 'active' : ''}"
                        data-status="${s}"
                        style="${isActive
                          ? `background:${color};border-color:${color};color:#fff`
                          : ''}">
                  ${STATUS_LABEL[s]}
                </button>
              `;
            }).join('')}
          </div>
        </div>

        <div class="modal-actions" style="margin-top:14px">
          <button class="btn-cancel" data-close>Закрыть</button>
          <button class="btn-danger" id="bkDelete"
                  style="flex:0 0 auto;padding-left:20px;padding-right:20px">
            Удалить
          </button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  modal.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      const newStatus = btn.dataset.status;
      setBookingStatus(b.id, newStatus);
      closeModal();
      toast(`Статус: ${STATUS_LABEL[newStatus]}`);
      notifySaved(onSaved);
    });
  });

  const deleteBtn = modal.querySelector('#bkDelete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      askConfirm('Удалить запись?', 'Действие необратимо.', () => {
        deleteBooking(b.id);
        closeModal();
        toast('Запись удалена');
        notifySaved(onSaved);
      }, { danger: true, yesLabel: 'Удалить' });
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   9. РАСХОД
   ═══════════════════════════════════════════════════════════════ */

const EXPENSE_CATEGORIES = ['Аренда', 'Материалы', 'Зарплата', 'Реклама', 'Коммунальные', 'Другое'];

export function openExpenseEditor(expenseId = null, onSaved) {
  const existing = expenseId ? state.expenses.find(e => e.id === expenseId) : null;
  const isNew = !existing;

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>${isNew ? 'Новый расход' : 'Редактировать расход'}</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="form-group">
          <label>Дата</label>
          <input type="date" id="expDate" value="${existing?.date || todayStr()}">
        </div>
        <div class="form-group">
          <label>Категория</label>
          <select id="expCategory">
            ${EXPENSE_CATEGORIES.map(c =>
              `<option ${existing?.category === c ? 'selected' : ''}>${c}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Сумма, ₽ *</label>
          <input type="number" id="expAmount" min="0" step="10"
                 value="${existing?.amount ?? ''}">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <input type="text" id="expNote" maxlength="100"
                 value="${esc(existing?.note || '')}">
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="expSave">Сохранить</button>
        </div>
        ${!isNew ? `
          <div class="modal-actions" style="margin-top:8px">
            <button class="btn-danger" id="expDelete" style="flex:1">Удалить</button>
          </div>
        ` : ''}
      </div>
    </div>
  `);
  if (!modal) return;

  const saveBtn = modal.querySelector('#expSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const date = modal.querySelector('#expDate').value;
      const category = modal.querySelector('#expCategory').value;
      const amount = parseInt(modal.querySelector('#expAmount').value, 10) || 0;
      const note = modal.querySelector('#expNote').value.trim();

      if (!date) return toast('Укажите дату');
      if (amount <= 0) return toast('Укажите сумму');

      upsertExpense({
        id: existing?.id || uid('e'),
        date, category, amount, note
      });
      closeModal();
      toast(isNew ? 'Расход добавлен' : 'Расход обновлён');
      notifySaved(onSaved);
    });
  }

  const deleteBtn = modal.querySelector('#expDelete');
  if (deleteBtn && existing) {
    deleteBtn.addEventListener('click', () => {
      askConfirm('Удалить расход?', 'Действие необратимо.', () => {
        deleteExpense(existing.id);
        closeModal();
        toast('Расход удалён');
        notifySaved(onSaved);
      }, { danger: true, yesLabel: 'Удалить' });
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   10. ПОДТВЕРЖДЕНИЕ БРОНИ (гость)
   ═══════════════════════════════════════════════════════════════ */

export function showConfirmBooking(slot, onBooked) {
  const svc = getService(slot.serviceId);
  if (!svc) return toast('Услуга не найдена');

  if (!isSlotFree(slot.date, slot.time, svc.duration)) {
    return toast('Слот занят, выберите другой');
  }

  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Подтвердите запись</h3>
          <button class="close-x" data-close>×</button>
        </div>

        <div class="card" style="background:var(--cream);border:none;
                                 text-align:center;margin-bottom:14px">
          <div style="font-size:2.4rem;margin-bottom:6px">${esc(svc.icon)}</div>
          <div style="font-family:'Playfair Display',serif;font-size:1.2rem;
                      font-weight:600;margin-bottom:4px">
            ${esc(svc.name)}
          </div>
          <div style="font-size:.82rem;color:var(--muted)">${esc(svc.desc)}</div>
          <div style="margin-top:12px;padding-top:12px;
                      border-top:1px solid var(--line)">
            <div style="font-weight:700;font-size:.95rem">${fmtLong(slot.date)}</div>
            <div style="font-size:.85rem;color:var(--terra-d);margin-top:4px">
              ${slot.time} · ${svc.duration} мин · ${svc.price.toLocaleString('ru')} ₽
            </div>
          </div>
        </div>

        <div style="font-size:.8rem;color:var(--muted);text-align:center;
                    padding:10px;background:var(--cream);border-radius:10px">
          <b style="color:var(--ink)">${esc(state.user.name)}</b><br>
          ${esc(state.user.phone)}
        </div>

        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="bkConfirm">Записаться</button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  const confirmBtn = modal.querySelector('#bkConfirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      if (!isSlotFree(slot.date, slot.time, svc.duration)) {
        closeModal();
        return toast('Слот занят');
      }

      const client = ensureClient(state.user.name, state.user.phone);

      const booking = addBooking({
        id: uid('b'),
        date: slot.date,
        time: slot.time,
        clientId: client.id,
        clientName: state.user.name,
        clientPhone: state.user.phone,
        serviceId: svc.id,
        serviceName: svc.name,
        price: svc.price,
        duration: svc.duration,
        status: 'pending',
        notes: ''
      });

      closeModal();
      buzz(30);
      toast(`Запись на ${fmtRu(slot.date)} в ${slot.time}`);

      if (typeof onBooked === 'function') onBooked(booking);
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   11. ИМПОРТ JSON
   ═══════════════════════════════════════════════════════════════ */

export function openImport(onImported) {
  const modal = openModal(`
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3>Импорт данных</h3>
          <button class="close-x" data-close>×</button>
        </div>
        <div class="hint-box">
          ⚠️ Импорт <b>полностью заменит</b> текущие данные. Сохраните
          текущее состояние через «Экспорт» перед импортом.
        </div>
        <input type="file" id="importFile" accept=".json,application/json"
               style="display:none">
        <button class="btn btn-ghost btn-block" id="importPick"
                style="margin-bottom:10px">📁 Выбрать JSON-файл</button>
        <div id="importPreview" style="font-size:.8rem;color:var(--muted);
                                       text-align:center;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn-cancel" data-close>Отмена</button>
          <button class="btn-save" id="importConfirm" disabled>Импортировать</button>
        </div>
      </div>
    </div>
  `);
  if (!modal) return;

  let parsedData = null;

  const fileInput = modal.querySelector('#importFile');
  const pickBtn = modal.querySelector('#importPick');
  const previewEl = modal.querySelector('#importPreview');
  const confirmBtn = modal.querySelector('#importConfirm');

  if (pickBtn) pickBtn.addEventListener('click', () => fileInput.click());

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.services || !Array.isArray(data.services)) {
            throw new Error('Нет поля services');
          }
          if (!data.bookings || !Array.isArray(data.bookings)) {
            throw new Error('Нет поля bookings');
          }
          parsedData = data;
          previewEl.innerHTML = `
            <div style="color:var(--green);font-weight:600">✅ Файл валиден</div>
            <div>Услуг: ${data.services.length} ·
                 Клиентов: ${(data.clients || []).length} ·
                 Записей: ${data.bookings.length}</div>
          `;
          confirmBtn.disabled = false;
        } catch (err) {
          previewEl.innerHTML = `
            <div style="color:var(--red);font-weight:600">❌ Ошибка</div>
            <div>${esc(err.message)}</div>
          `;
          confirmBtn.disabled = true;
          parsedData = null;
        }
      };
      reader.readAsText(file);
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      if (!parsedData) return;
      askConfirm('Импортировать данные?', 'Текущие данные будут заменены.', async () => {
        state.admin = parsedData.admin || state.admin;
        state.salon = parsedData.salon || state.salon;
        state.workingHours = parsedData.workingHours || state.workingHours;
        state.services = parsedData.services || [];
        state.clients = parsedData.clients || [];
        state.bookings = parsedData.bookings || [];
        state.expenses = parsedData.expenses || [];
        state.subscription = parsedData.subscription || state.subscription;

        try {
          await saveImmediate();
          closeModal();
          toast('Импорт завершён');
          if (typeof onImported === 'function') onImported();
        } catch (err) {
          console.error('[import] saveImmediate failed:', err);
          toast('Ошибка сохранения');
        }
      }, { yesLabel: 'Импортировать', danger: true });
    });
  }
}


/* ═══════════════════════════════════════════════════════════════
   12. КАЛЕНДАРЬ (компонент)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Отрендерить календарь текущего месяца.
 * Возвращает HTML — для вставки в views. Для интерактивности
 * после вставки вызвать bindCalendar(onChange).
 *
 * @returns {string}
 */
export function calendar() {
  const y = state.currentMonth.getFullYear();
  const m = state.currentMonth.getMonth();
  const firstDay = new Date(y, m, 1);
  const startOffset = weekdayIndex(firstDay);
  const totalDays = monthDays(y, m);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKey = fmtDate(today);
  const isGuest = state.role === 'guest';

  let html = '<div class="calendar" id="calendar">';

  html += `
    <div class="cal-header">
      <button class="cal-nav" data-cal-dir="-1">‹</button>
      <div class="cal-title">${fmtMonthYear(state.currentMonth)}</div>
      <button class="cal-nav" data-cal-dir="1">›</button>
    </div>
  `;

  html += '<div class="cal-grid">';
  WD_SHORT.forEach(w => html += `<div class="cal-wd">${w}</div>`);

  for (let i = 0; i < startOffset; i++) {
    html += '<div class="cal-day empty"></div>';
  }

  for (let d = 1; d <= totalDays; d++) {
    const date = new Date(y, m, d);
    const key = fmtDate(date);
    const isPast = date < today;
    const isToday = key === todayKey;
    const off = isOff(date);
    const selected = state.selectedDate === key;
    const count = getBookingsForDate(key)
      .filter(b => b.status !== 'cancelled').length;
    const disabled = isGuest && (isPast || off);

    const classes = ['cal-day'];
    if (isToday) classes.push('today');
    if (selected) classes.push('selected');
    if (disabled) classes.push('disabled');
    else if (off) classes.push('day-off');

    html += `
      <button class="${classes.join(' ')}" data-date="${key}" ${disabled ? 'disabled' : ''}>
        <span>${d}</span>
        ${count > 0 ? `<i class="dot">${count > 9 ? '9+' : count}</i>` : ''}
      </button>
    `;
  }
  html += '</div></div>';
  return html;
}

/**
 * Привязать обработчики к календарю после вставки HTML.
 * @param {() => void} onChange — вызывается после изменения месяца/даты
 */
export function bindCalendar(onChange) {
  const root = document.getElementById('calendar');
  if (!root) return;

  root.querySelectorAll('[data-cal-dir]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = parseInt(btn.dataset.calDir, 10);
      state.currentMonth = new Date(
        state.currentMonth.getFullYear(),
        state.currentMonth.getMonth() + dir,
        1
      );
      buzz(6);
      if (typeof onChange === 'function') onChange();
    });
  });

  root.querySelectorAll('.cal-day[data-date]:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedDate = btn.dataset.date;
      buzz(8);
      if (typeof onChange === 'function') onChange();
    });
  });
}