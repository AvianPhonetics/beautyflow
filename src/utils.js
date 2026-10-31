/**
 * utils.js — фундаментальные утилиты.
 *
 * Принципы:
 *  1. Никаких импортов — этот модуль самодостаточен.
 *  2. Никаких глобальных переменных кроме явно разрешённых.
 *  3. Все побочные эффекты (toast, buzz) — только в DOM, не в state.
 *  4. Все функции чистые там, где это возможно (легко тестировать).
 *
 * Экспортируется: даты, время, форматирование, телефоны, ID, UX.
 */

/* ═══════════════════════════════════════════════════════════════
   КОНСТАНТЫ — единый источник правды для всего проекта.
   Импортируйте их вместо дублирования строк в модулях.
   ═══════════════════════════════════════════════════════════════ */

/** Названия месяцев в именительном падеже: «Май 2026». */
export const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

/** Названия месяцев в родительном падеже: «24 мая». */
export const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

/** Короткие названия дней недели. Индексация: Пн=0 … Вс=6. */
export const WD_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Полные названия дней недели. Индексация: Пн=0 … Вс=6. */
export const WD_LONG = [
  'Понедельник', 'Вторник', 'Среда', 'Четверг',
  'Пятница', 'Суббота', 'Воскресенье'
];

/** Человеческие названия статусов записи. */
export const STATUS_LABEL = {
  pending:   'Ожидает',
  confirmed: 'Подтверждена',
  done:      'Выполнена',
  cancelled: 'Отменена',
  noshow:    'Не пришёл'
};

/** Цвета статусов — для inline-стилей в модалке деталей. */
export const STATUS_COLOR = {
  pending:   'var(--amber)',
  confirmed: 'var(--blue)',
  done:      'var(--green)',
  cancelled: 'var(--muted)',
  noshow:    'var(--red)'
};


/* ═══════════════════════════════════════════════════════════════
   ДАТЫ — работаем со строками 'YYYY-MM-DD' как с ключами,
   Date — только для арифметики и парсинга.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Дополняет число до 2 цифр: pad(5) → '05'.
 * @param {number} n
 * @returns {string}
 */
export function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Date → 'YYYY-MM-DD'. Ключ для группировки записей по дате.
 * @param {Date} d
 * @returns {string}
 */
export function fmtDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * 'YYYY-MM-DD' → Date (локальное, без TZ-сюрпризов).
 * Внимание: НЕ используем new Date('2025-05-24') — это UTC-полночь,
 * в РФ даст «вчерашнюю» дату.
 * @param {string} s
 * @returns {Date}
 */
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Сегодня как 'YYYY-MM-DD' (локальная дата).
 * @returns {string}
 */
export function todayStr() {
  return fmtDate(new Date());
}

/**
 * '2025-05-24' → '24 мая'. Для заголовков дней.
 * @param {string} s
 * @returns {string}
 */
export function fmtRu(s) {
  const d = parseDate(s);
  return d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
}

/**
 * '2025-05-24' → 'Понедельник, 24 мая'. Для акцентных заголовков.
 * @param {string} s
 * @returns {string}
 */
export function fmtLong(s) {
  const d = parseDate(s);
  return WD_LONG[weekdayIndex(d)] + ', ' + d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
}

/**
 * Date → 'Май 2026'. Для заголовка календаря.
 * @param {Date} d
 * @returns {string}
 */
export function fmtMonthYear(d) {
  return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

/**
 * Индекс дня недели, где Пн=0, Вс=6 (а не 0..6 как в JS).
 * JS: getDay() → Вс=0. Наш: Пн=0. Формула смещает на 6.
 * @param {Date} d
 * @returns {number} 0..6
 */
export function weekdayIndex(d) {
  return (d.getDay() + 6) % 7;
}

/**
 * Количество дней в месяце.
 * @param {number} year
 * @param {number} month 0..11 (как в Date)
 * @returns {number}
 */
export function monthDays(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Прибавляет дни к строке-дате. Возвращает строку.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} n может быть отрицательным
 * @returns {string}
 */
export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

/**
 * Разница в целых днях b − a.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function diffDays(a, b) {
  const MS = 86400000;
  return Math.round((parseDate(b) - parseDate(a)) / MS);
}

/**
 * Сравнение двух дат по календарю.
 * @param {string|Date} a
 * @param {string|Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  const da = typeof a === 'string' ? parseDate(a) : a;
  const db = typeof b === 'string' ? parseDate(b) : b;
  return fmtDate(da) === fmtDate(db);
}

/**
 * Проверка «дата в прошлом» (строго до сегодня).
 * @param {string} dateStr
 * @returns {boolean}
 */
export function isPast(dateStr) {
  return dateStr < todayStr();
}

/**
 * Проверка «дата в будущем или сегодня» (>= сегодня).
 * @param {string} dateStr
 * @returns {boolean}
 */
export function isUpcoming(dateStr) {
  return dateStr >= todayStr();
}


/* ═══════════════════════════════════════════════════════════════
   ВРЕМЯ — работаем с 'HH:MM' как со строками, переводим в минуты
   для арифметики (сложение слотов, пересечения).
   ═══════════════════════════════════════════════════════════════ */

/**
 * '09:30' → 570 (минут от полуночи).
 * @param {string} t
 * @returns {number}
 */
export function t2m(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 570 → '09:30'.
 * @param {number} m
 * @returns {string}
 */
export function m2t(m) {
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}

/**
 * Генерирует массив времён слотов по рабочим часам.
 * Пример: timeSlots('09:00', '21:00', 60) → ['09:00', '10:00', …, '20:00']
 * @param {string} start 'HH:MM'
 * @param {string} end   'HH:MM'
 * @param {number} step  минуты
 * @returns {string[]}
 */
export function timeSlots(start, end, step) {
  const out = [];
  const s = t2m(start);
  const e = t2m(end);
  for (let t = s; t + step <= e; t += step) out.push(m2t(t));
  return out;
}

/**
 * Проверяет пересечение двух интервалов [s1,e1) и [s2,e2).
 * @param {number} s1
 * @param {number} e1
 * @param {number} s2
 * @param {number} e2
 * @returns {boolean}
 */
export function intervalsOverlap(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}


/* ═══════════════════════════════════════════════════════════════
   ФОРМАТИРОВАНИЕ — русские окончания, деньги, HTML-escape.
   ═══════════════════════════════════════════════════════════════ */

/**
 * HTML-escape. Обязательно для любого user-input в innerHTML.
 * @param {*} s
 * @returns {string}
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

/**
 * 4500 → '4 500 ₽'. Тонкий неразрывный пробел для читаемости.
 * @param {number} n
 * @param {string} suffix
 * @returns {string}
 */
export function formatMoney(n, suffix = ' ₽') {
  return Math.round(n).toLocaleString('ru-RU') + suffix;
}

/**
 * Русское склонение: plural(5, ['запись','записи','записей']) → 'записей'.
 * @param {number} n
 * @param {[string,string,string]} forms [1, 2-4, 5+]
 * @returns {string}
 */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5)   return forms[1];
  if (last === 1)             return forms[0];
  return forms[2];
}

/**
 * 'мария' → 'Мария'.
 * @param {string} s
 * @returns {string}
 */
export function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}


/* ═══════════════════════════════════════════════════════════════
   ТЕЛЕФОНЫ — единая маска +7 (___) ___-__-__ для РФ.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Оставляет только цифры.
 * @param {string} s
 * @returns {string}
 */
export function cleanPhone(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * Маска +7 (999) 123-45-67 на лету. Принимает любое,
 * приводит к российскому формату. Для input-события.
 * @param {string} input
 * @returns {string}
 */
export function formatPhone(input) {
  let d = cleanPhone(input);
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (d && !d.startsWith('7')) d = '7' + d;
  d = d.slice(0, 11);
  let r = '';
  if (d.length >= 1) r = '+7';
  if (d.length >= 2) r += ' (' + d.slice(1, 4);
  if (d.length >= 5) r += ') ' + d.slice(4, 7);
  if (d.length >= 8) r += '-' + d.slice(7, 9);
  if (d.length >= 10) r += '-' + d.slice(9, 11);
  return r;
}

/**
 * Валидный ли телефон РФ (11 цифр, начинается с 7).
 * @param {string} s
 * @returns {boolean}
 */
export function validPhone(s) {
  const d = cleanPhone(s);
  return d.length === 11 && d.startsWith('7');
}

/**
 * Телефон в формат для tel:-ссылки.
 * @param {string} s
 * @returns {string}
 */
export function telHref(s) {
  return 'tel:+' + cleanPhone(s);
}


/* ═══════════════════════════════════════════════════════════════
   ID И ХЭШИ — генерация ID и хэш пароля администратора.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Уникальный ID вида 'b1712345678abcd'. Префикс — тип сущности.
 * @param {string} prefix 'b' bookings, 'c' clients, 's' services, 'e' expenses
 * @returns {string}
 */
export function uid(prefix = 'id') {
  return prefix + Date.now() + Math.random().toString(36).slice(2, 6);
}

/**
 * djb2-хэш для пароля. НЕ криптографический — только для того,
 * чтобы в localStorage не лежал открытый пароль.
 * В продакшене заменяется на bcrypt на сервере.
 * @param {string} password
 * @returns {string} 'h1a2b3c4'
 */
export function hashPass(password) {
  let h = 5381;
  for (let i = 0; i < password.length; i++) {
    h = ((h << 5) + h + password.charCodeAt(i)) >>> 0;
  }
  return 'h' + h.toString(16);
}


/* ═══════════════════════════════════════════════════════════════
   UX — обратная связь для пользователя.
   ═══════════════════════════════════════════════════════════════ */

/** Внутренний таймер, чтобы несколько toast() подряд не мигали. */
let _toastTimer = null;

/**
 * Показать тост в верхней части экрана на 2.4 с.
 * Требует элемент #toast в DOM (index.html это даёт).
 * @param {string} msg
 * @param {number} [duration=2400]
 */
export function toast(msg, duration = 2400) {
  const el = document.getElementById('toast');
  if (!el) {
    console.warn('[toast] #toast не найден:', msg);
    return;
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/**
 * Короткая вибрация (если поддерживается).
 * @param {number} ms
 */
export function buzz(ms = 10) {
  if (navigator.vibrate) {
    try { navigator.vibrate(ms); } catch (_) { /* iOS Safari может кинуть */ }
  }
}

/**
 * Debounce — откладывает вызов fn до паузы в ms мс.
 * Используется в поиске клиентов.
 * @template {Function} F
 * @param {F} fn
 * @param {number} ms
 * @returns {(...args: Parameters<F>) => void}
 */
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}


/* ═══════════════════════════════════════════════════════════════
   ПРОЧЕЕ — мелкие помощники, которые понадобятся в views.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Безопасный доступ по вложенному пути: get(obj, 'a.b.c', fallback).
 * @param {*} obj
 * @param {string} path
 * @param {*} fallback
 * @returns {*}
 */
export function get(obj, path, fallback = undefined) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

/**
 * Сумма по массиву через селектор: sumBy(arr, x => x.price).
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => number} fn
 * @returns {number}
 */
export function sumBy(arr, fn) {
  return arr.reduce((s, item) => s + (fn(item) || 0), 0);
}

/**
 * Группировка по ключу: groupBy(bookings, b => b.date).
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => string} keyFn
 * @returns {Record<string, T[]>}
 */
export function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] ||= []).push(item);
  }
  return out;
}