/**
 * store.js — единый источник правды для данных приложения.
 *
 * Принципы:
 *  1. Никакого DOM. Только state + сохранение.
 *  2. Все views работают с данными через этот модуль.
 *  3. Мутаторы сами вызывают save() — забыть невозможно.
 *  4. Селекторы — чистые функции (легко тестировать).
 *  5. save() дебаунсится на 300 мс для VK Storage.
 *
 * Экспортирует:
 *  - state (глобальный объект, читается во views)
 *  - load, save, saveImmediate, reset
 *  - селекторы: getService, getBookingsForDate, isSlotFree, ...
 *  - мутаторы: addBooking, setBookingStatus, upsertService, ...
 */

import { platform } from './platform.js';
import {
  uid, todayStr, addDays, hashPass, cleanPhone, t2m, toast
} from './utils.js';


/* ═══════════════════════════════════════════════════════════════
   ДЕФОЛТНЫЕ ЗНАЧЕНИЯ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Дефолтный администратор.
 * Пароль в открытом виде НЕ хранится — только djb2-хэш.
 * Сменить: «Профиль → Безопасность». Пароль по умолчанию: admin123.
 */
const DEFAULT_ADMIN = {
  login: 'admin',
  passwordHash: hashPass('admin123')
};

/** Дефолтные настройки салона (шапка, paywall, отчёты). */
const DEFAULT_SALON = {
  name: 'BeautyFlow',
  address: '',
  phone: ''
};

/**
 * Рабочие часы по умолчанию.
 * daysOff: индексы дней недели Пн=0 … Вс=6.
 * [0] = только воскресенье — выходной.
 */
const DEFAULT_WORKING = {
  start: '09:00',
  end: '21:00',
  daysOff: [0]
};


/* ═══════════════════════════════════════════════════════════════
   ГЛОБАЛЬНЫЙ STATE
   ═══════════════════════════════════════════════════════════════ */

/**
 * Единый объект состояния.
 *
 * Разделён на две части:
 *   [1] persistent — сохраняется в платформу (localStorage / VK Storage)
 *   [2] ui — живёт только в памяти, сбрасывается при перезагрузке
 *
 * НЕ мутируйте ui-поля напрямую из views, если это не UI-действие.
 * НЕ мутируйте persistent-поля — используйте мутаторы ниже.
 */
export const state = {
  /* ─── [1] Persistent ─── */
  role: null,                        // 'admin' | 'guest' | null
  user: { name: '', phone: '' },     // текущий пользователь (имя + телефон)
  admin: { ...DEFAULT_ADMIN },       // логин и хэш пароля админа
  salon: { ...DEFAULT_SALON },       // реквизиты салона
  workingHours: { ...DEFAULT_WORKING },
  services: [],                      // [{id,icon,name,desc,price,duration,active}]
  clients: [],                       // [{id,name,phone,notes,tags,createdAt}]
  bookings: [],                      // [{id,date,time,clientId,clientName,clientPhone,serviceId,serviceName,price,duration,status,notes}]
  expenses: [],                      // [{id,date,category,amount,note}]
  subscription: null,                // {plan,expiresAt,activatedAt,...}

  /* ─── [2] UI (не сохраняется) ─── */
  currentMonth: new Date(),          // Date: месяц в календаре
  selectedDate: null,                // 'YYYY-MM-DD': выбранный день
  selectedServiceId: null,           // id: выбранная услуга для брони
  view: 'home'                       // текущий таб
};


/* ═══════════════════════════════════════════════════════════════
   ЖИЗНЕННЫЙ ЦИКЛ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Загрузка состояния при старте приложения.
 * Вызывается ОДИН раз в main.js.
 *
 * Алгоритм:
 *   1. Пробуем загрузить из платформы.
 *   2. Если данные есть — восстанавливаем все persistent-поля.
 *   3. Если нет — это первый запуск: создаём дефолты + демо.
 *   4. Инициализируем UI-поля.
 *
 * @returns {Promise<void>}
 */
export async function load() {
  const loaded = await platform.loadState();

  if (loaded && typeof loaded === 'object') {
    // Восстанавливаем поля безопасно — если в данных чего-то нет,
    // останется дефолт из state выше
    state.role = loaded.role ?? null;
    state.user = loaded.user ?? { name: '', phone: '' };
    state.admin = loaded.admin ?? { ...DEFAULT_ADMIN };
    state.salon = loaded.salon ?? { ...DEFAULT_SALON };
    state.workingHours = loaded.workingHours ?? { ...DEFAULT_WORKING };

    state.services = Array.isArray(loaded.services) ? loaded.services : defaultServices();
    state.clients = Array.isArray(loaded.clients) ? loaded.clients : [];
    state.bookings = Array.isArray(loaded.bookings) ? loaded.bookings : [];
    state.expenses = Array.isArray(loaded.expenses) ? loaded.expenses : [];
    state.subscription = loaded.subscription ?? null;
  } else {
    // Первый запуск — сеем демо-данные
    state.services = defaultServices();
    seedDemo();
    // Сохраняем сразу, чтобы seed не потерялся при перезагрузке
    await saveImmediate();
  }

  // Инициализируем UI-поля
  state.selectedDate = todayStr();
  state.currentMonth = new Date();
  if (!state.selectedServiceId && state.services[0]) {
    state.selectedServiceId = state.services[0].id;
  }

  // Санитарная проверка: если выбранная услуга была удалена
  if (state.selectedServiceId && !getService(state.selectedServiceId)) {
    state.selectedServiceId = state.services[0]?.id ?? null;
  }
}


/* ─── Сохранение ─────────────────────────────────────────────── */

/** Таймер дебаунса. null — нет отложенного сохранения. */
let _saveTimer = null;

/**
 * Отложенное сохранение с дебаунсом 300 мс.
 * Вызывается мутаторами автоматически.
 * Не ждёт результата — fire and forget.
 */
export function save() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try {
      await platform.saveState(snapshot());
    } catch (err) {
      console.error('[store] save failed:', err);
      toast('Не удалось сохранить изменения');
    }
  }, 300);
}

/**
 * Немедленное сохранение — без дебаунса.
 * Используется для критичных операций: seed при первом запуске,
 * reset, перед закрытием приложения.
 *
 * @returns {Promise<void>}
 */
export async function saveImmediate() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  try {
    await platform.saveState(snapshot());
  } catch (err) {
    console.error('[store] saveImmediate failed:', err);
    toast('Не удалось сохранить изменения');
    throw err;
  }
}

/**
 * Снимок persistent-части state для сохранения.
 * UI-поля (currentMonth, selectedDate, view) НЕ сохраняются —
 * при перезагрузке пользователь начинает с чистого листа.
 *
 * @returns {object}
 */
function snapshot() {
  return {
    role: state.role,
    user: state.user,
    admin: state.admin,
    salon: state.salon,
    workingHours: state.workingHours,
    services: state.services,
    clients: state.clients,
    bookings: state.bookings,
    expenses: state.expenses,
    subscription: state.subscription
  };
}

/**
 * Полный сброс — стирает всё и заполняет демо заново.
 * Используется в «Профиль → Сбросить демо».
 *
 * @returns {Promise<void>}
 */
export async function reset() {
  await platform.clearState();

  state.role = null;
  state.user = { name: '', phone: '' };
  state.admin = { ...DEFAULT_ADMIN };
  state.salon = { ...DEFAULT_SALON };
  state.workingHours = { ...DEFAULT_WORKING };
  state.services = defaultServices();
  state.clients = [];
  state.bookings = [];
  state.expenses = [];
  state.subscription = null;

  seedDemo();
  await saveImmediate();

  // UI-поля
  state.selectedDate = todayStr();
  state.currentMonth = new Date();
  state.selectedServiceId = state.services[0]?.id ?? null;
  state.view = 'home';
}


/* ═══════════════════════════════════════════════════════════════
   СЕЛЕКТОРЫ — чистые функции чтения
   ═══════════════════════════════════════════════════════════════ */

/**
 * Услуга по id или undefined.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getService(id) {
  return state.services.find(s => s.id === id);
}

/**
 * Клиент по id или undefined.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getClient(id) {
  return state.clients.find(c => c.id === id);
}

/**
 * Активные услуги (не скрытые админом).
 * Используется в публичной витрине и в чипах гостя.
 * @returns {object[]}
 */
export function activeServices() {
  return state.services.filter(s => s.active !== false);
}

/**
 * Выходной ли день.
 * @param {Date} date
 * @returns {boolean}
 */
export function isOff(date) {
  return state.workingHours.daysOff.includes(date.getDay());
}

/**
 * Записи на конкретный день, отсортированные по времени.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {object[]}
 */
export function getBookingsForDate(dateStr) {
  return state.bookings
    .filter(b => b.date === dateStr)
    .sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Мои записи (для гостя) — по совпадению телефона.
 * В режиме админа возвращает [].
 * @returns {object[]}
 */
export function myBookings() {
  if (state.role !== 'guest' || !state.user.phone) return [];
  const phone = cleanPhone(state.user.phone);
  return state.bookings
    .filter(b => cleanPhone(b.clientPhone) === phone)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

/**
 * Все записи конкретного клиента (по clientId).
 * @param {string} clientId
 * @returns {object[]}
 */
export function clientBookings(clientId) {
  return state.bookings
    .filter(b => b.clientId === clientId)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

/**
 * LTV клиента — сумма выполненных и подтверждённых записей.
 * @param {string} clientId
 * @returns {number}
 */
export function clientLTV(clientId) {
  return clientBookings(clientId)
    .filter(b => b.status === 'done' || b.status === 'confirmed')
    .reduce((s, b) => s + b.price, 0);
}

/**
 * Дата последнего визита или null.
 * @param {string} clientId
 * @returns {string|null}
 */
export function clientLastVisit(clientId) {
  const done = clientBookings(clientId).filter(b => b.status === 'done');
  return done[0]?.date ?? null;
}

/**
 * Свободен ли слот на указанную длительность.
 * Учитывает длительность существующих записей (пересечения),
 * не учитывает отменённые и неявки.
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} time 'HH:MM'
 * @param {number} duration минуты
 * @returns {boolean}
 */
export function isSlotFree(dateStr, time, duration) {
  const start = t2m(time);
  const end = start + duration;
  return !state.bookings
    .filter(b => b.date === dateStr &&
                 b.status !== 'cancelled' &&
                 b.status !== 'noshow')
    .some(b => {
      const bStart = t2m(b.time);
      const bEnd = bStart + b.duration;
      return start < bEnd && end > bStart;
    });
}


/* ═══════════════════════════════════════════════════════════════
   МУТАТОРЫ — запись в state + save()
   ═══════════════════════════════════════════════════════════════ */

/* ─── Клиенты ────────────────────────────────────────────────── */

/**
 * Гарантирует, что клиент с таким телефоном есть в базе.
 * Если нет — создаёт. Если есть — обновляет имя, если оно изменилось.
 * Используется при бронировании: гость ввёл имя и телефон → клиент появился.
 *
 * @param {string} name
 * @param {string} phone
 * @returns {object} клиент
 */
export function ensureClient(name, phone) {
  const clean = cleanPhone(phone);
  let client = state.clients.find(c => cleanPhone(c.phone) === clean);

  if (!client) {
    client = {
      id: uid('c'),
      name: name || 'Без имени',
      phone,
      notes: '',
      tags: [],
      createdAt: Date.now()
    };
    state.clients.push(client);
    save();
  } else if (name && client.name !== name) {
    client.name = name;
    save();
  }

  return client;
}

/**
 * Создать или обновить клиента (для модалки «Клиент»).
 * Обновляет имя/телефон в связанных записях каскадно.
 * @param {object} client — обязательно с id
 */
export function upsertClient(client) {
  const idx = state.clients.findIndex(c => c.id === client.id);
  if (idx >= 0) {
    state.clients[idx] = { ...state.clients[idx], ...client };
    // Каскад: обновляем имя/телефон в записях
    state.bookings.forEach(b => {
      if (b.clientId === client.id) {
        b.clientName = client.name;
        b.clientPhone = client.phone;
      }
    });
  } else {
    state.clients.push(client);
  }
  save();
}

/**
 * Удалить клиента. Записи остаются (историю не трогаем).
 * @param {string} id
 */
export function deleteClient(id) {
  state.clients = state.clients.filter(c => c.id !== id);
  save();
}


/* ─── Услуги ─────────────────────────────────────────────────── */

/**
 * Создать или обновить услугу.
 * Каскадно обновляет название/цену/длительность в связанных записях,
 * чтобы отчёты и история оставались консистентными.
 * @param {object} service — обязательно с id
 */
export function upsertService(service) {
  const idx = state.services.findIndex(s => s.id === service.id);
  if (idx >= 0) {
    state.services[idx] = { ...state.services[idx], ...service };
    state.bookings.forEach(b => {
      if (b.serviceId === service.id) {
        b.serviceName = service.name;
        b.price = service.price;
        b.duration = service.duration;
      }
    });
  } else {
    state.services.push(service);
  }
  save();
}

/**
 * Удалить услугу. Исторические записи сохраняют имя/цену — они уже
 * скопированы в саму запись. Восстановить услугу нельзя.
 * @param {string} id
 */
export function deleteService(id) {
  state.services = state.services.filter(s => s.id !== id);
  save();
}


/* ─── Записи ─────────────────────────────────────────────────── */

/**
 * Добавить запись. Не проверяет конфликты — это делает usecase-вызывающий.
 * @param {object} booking
 * @returns {object} booking
 */
export function addBooking(booking) {
  state.bookings.push(booking);
  save();
  return booking;
}

/**
 * Сменить статус записи.
 * @param {string} id
 * @param {'pending'|'confirmed'|'done'|'cancelled'|'noshow'} status
 */
export function setBookingStatus(id, status) {
  const b = state.bookings.find(x => x.id === id);
  if (b) {
    b.status = status;
    save();
  }
}

/**
 * Удалить запись полностью (не путать с отменой).
 * @param {string} id
 */
export function deleteBooking(id) {
  state.bookings = state.bookings.filter(b => b.id !== id);
  save();
}


/* ─── Расходы ────────────────────────────────────────────────── */

/**
 * Создать или обновить расход.
 * @param {object} expense — обязательно с id
 */
export function upsertExpense(expense) {
  const idx = state.expenses.findIndex(e => e.id === expense.id);
  if (idx >= 0) {
    state.expenses[idx] = { ...state.expenses[idx], ...expense };
  } else {
    state.expenses.push(expense);
  }
  save();
}

/**
 * Удалить расход.
 * @param {string} id
 */
export function deleteExpense(id) {
  state.expenses = state.expenses.filter(e => e.id !== id);
  save();
}


/* ─── Настройки и подписка ───────────────────────────────────── */

/**
 * Обновить рабочие часы.
 * @param {{start:string, end:string, daysOff:number[]}} wh
 */
export function setWorkingHours(wh) {
  state.workingHours = { ...state.workingHours, ...wh };
  save();
}

/**
 * Обновить данные салона.
 * @param {{name?:string, address?:string, phone?:string}} salon
 */
export function setSalon(salon) {
  state.salon = { ...state.salon, ...salon };
  save();
}

/**
 * Обновить креды админа.
 * @param {{login?:string, passwordHash?:string}} creds
 */
export function setAdminCreds(creds) {
  state.admin = { ...state.admin, ...creds };
  save();
}

/**
 * Обновить подписку (после активации кода / оплаты VK / trial).
 * @param {object|null} sub
 */
export function setSubscription(sub) {
  state.subscription = sub;
  save();
}


/* ═══════════════════════════════════════════════════════════════
   ДЕМО-ДАННЫЕ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Дефолтный набор услуг.
 * @returns {object[]}
 */
export function defaultServices() {
  return [
    {
      id: uid('s'), icon: '✂️', name: 'Стрижка',
      desc: 'Стрижка любой сложности с укладкой',
      price: 3000, duration: 60, active: true
    },
    {
      id: uid('s'), icon: '💅', name: 'Маникюр',
      desc: 'Аппаратный или классический с покрытием',
      price: 2800, duration: 60, active: true
    },
    {
      id: uid('s'), icon: '🎨', name: 'Окрашивание',
      desc: 'Окрашивание в один тон или мелирование',
      price: 4500, duration: 120, active: true
    }
  ];
}

/**
 * Заполнить state демо-данными: 4 клиента, 6 записей, 2 расхода.
 * Даты — относительно сегодня, чтобы демо всегда выглядело «живым».
 * Вызывать только после установки state.services.
 */
export function seedDemo() {
  const today     = todayStr();
  const tomorrow  = addDays(today, 1);
  const dayAfter  = addDays(today, 2);
  const yesterday = addDays(today, -1);

  const [s1, s2, s3] = state.services;
  if (!s1 || !s2 || !s3) {
    console.warn('[store] seedDemo: недостаточно услуг для демо');
    return;
  }

  state.clients = [
    { id: uid('c'), name: 'Анна К.',   phone: '+7 (912) 345-67-89', notes: '', tags: ['VIP'], createdAt: Date.now() },
    { id: uid('c'), name: 'Ирина П.',  phone: '+7 (903) 111-22-33', notes: 'Аллергия на аммиак', tags: ['аллергия'], createdAt: Date.now() },
    { id: uid('c'), name: 'Ольга С.',  phone: '+7 (926) 555-77-88', notes: '', tags: [], createdAt: Date.now() },
    { id: uid('c'), name: 'Мария Л.',  phone: '+7 (985) 222-33-44', notes: '', tags: [], createdAt: Date.now() }
  ];

  const [c1, c2, c3, c4] = state.clients;

  state.bookings = [
    mkBooking(today,     '10:30', c1, s3, 'confirmed'),
    mkBooking(today,     '13:00', c2, s2, 'done'),
    mkBooking(today,     '15:30', c3, s1, 'pending'),
    mkBooking(tomorrow,  '11:00', c4, s2, 'confirmed'),
    mkBooking(dayAfter,  '14:00', c1, s1, 'pending'),
    mkBooking(yesterday, '12:00', c2, s2, 'done')
  ];

  state.expenses = [
    { id: uid('e'), date: yesterday, category: 'Аренда',     amount: 15000, note: 'Ежемесячно' },
    { id: uid('e'), date: today,     category: 'Материалы',  amount: 3200,  note: 'Краска, перчатки' }
  ];
}

/**
 * Хелпер для seedDemo — создать объект записи.
 * @param {string} date 'YYYY-MM-DD'
 * @param {string} time 'HH:MM'
 * @param {object} client
 * @param {object} service
 * @param {string} status
 * @returns {object}
 */
function mkBooking(date, time, client, service, status) {
  return {
    id: uid('b'),
    date,
    time,
    clientId: client.id,
    clientName: client.name,
    clientPhone: client.phone,
    serviceId: service.id,
    serviceName: service.name,
    price: service.price,
    duration: service.duration,
    status,
    notes: ''
  };
}