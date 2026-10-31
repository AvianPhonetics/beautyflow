/**
 * platform.js — абстракция платформы.
 *
 * ЕДИНСТВЕННЫЙ модуль, который знает о разнице между VK Mini App и браузером.
 * Всё остальное (store, subscription, views, modals) вызывает platform.*
 * и не подозревает, где работает приложение.
 *
 * Контракт:
 *   await platform.init()                 — вызвать ОДИН раз при загрузке
 *   await platform.loadState()            — вернуть state или null
 *   await platform.saveState(state)       — сохранить state
 *   await platform.clearState()           — удалить всё
 *   await platform.getUser()              — VK-юзер или null
 *   await platform.requestVKPayment(item) — оплата через VK
 *
 * Ничего не импортирует из проекта — только из utils (formatPhone, cleanPhone).
 * Это позволяет использовать platform.js даже в отдельных маленьких фичах.
 */

/* ═══════════════════════════════════════════════════════════════
   ОПРЕДЕЛЕНИЕ ПЛАТФОРМЫ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Находимся ли мы внутри VK Mini App.
 *
 * Признаки (любой из):
 *   1. VK Bridge загружен (скрипт <script src="...vk-bridge...">
 *   2. В URL есть vk_app_id или vk_user_id (VK всегда их добавляет)
 *   3. Домен — vk.com или vk.ru
 *   4. Мы в iframe (VK всегда открывает мини-апп в iframe)
 *
 * Все четыре проверки — для надёжности. Даже если vkBridge не загрузился
 * (например, unpkg упал), но домен vk.com — считаем VK.
 */
function detectVK() {
  // 1. VK Bridge загружен?
  const hasBridge = typeof window.vkBridge !== 'undefined';

  // 2. Параметры VK в URL?
  const params = new URLSearchParams(window.location.search);
  const hasVKParams = params.has('vk_app_id') || params.has('vk_user_id');

  // 3. Домен VK?
  const host = window.location.hostname;
  const onVK = host.endsWith('vk.com') || host.endsWith('vk.ru');

  // 4. В iframe?
  const inIframe = window.self !== window.top;

  // Считаем VK если: есть bridge И (параметры ИЛИ домен ИЛИ iframe)
  // — это отсекает случай, когда пользователь просто открыл нашу страницу
  //   в браузере, а рядом случайно загрузился vk-bridge (не бывает, но на всякий)
  return hasBridge && (hasVKParams || onVK || inIframe);
}

/** Публичный флаг — можно использовать в views для UI-подсказок. */
export const isVK = detectVK();


/* ═══════════════════════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ
   ═══════════════════════════════════════════════════════════════ */

/** Инициализирован ли platform (защита от двойного вызова init). */
let _initialized = false;

/**
 * Инициализация платформы. Вызывать ОДИН раз в main.js.
 *
 * В VK: говорит VK Bridge «я готов», получает разрешение на Storage.
 * В браузере: ничего не делает.
 *
 * @returns {Promise<void>}
 */
async function init() {
  if (_initialized) return;
  _initialized = true;

  if (!isVK) return;

  try {
    // VKWebAppInit — обязательный первый вызов. Без него
    // остальные методы VK Bridge работать не будут.
    await window.vkBridge.send('VKWebAppInit');
    console.info('[platform] VK Bridge инициализирован');
  } catch (err) {
    console.error('[platform] VKWebAppInit failed:', err);
    // Не падаем — вдруг VK WebView глючит, попробуем работать как есть
  }
}


/* ═══════════════════════════════════════════════════════════════
   ХРАНИЛИЩЕ — VK Storage (с чанкованием) или localStorage
   ═══════════════════════════════════════════════════════════════ */

/* ─── Константы хранилища ─────────────────────────────────────── */

/** Ключ localStorage (браузер). */
const LS_KEY = 'beautyflow:v6';

/** Мета-ключ VK Storage: хранит, сколько чанков сейчас записано. */
const VK_META_KEY = 'bf_meta';

/** Префикс чанков VK Storage: bf_c_0, bf_c_1, … */
const VK_CHUNK_PREFIX = 'bf_c_';

/**
 * Размер одного чанка в байтах.
 * VK Storage: лимит 4096 байт на ключ. Берём 4000 — запас на UTF-8
 * (русские буквы занимают 2 байта в UTF-8, но в JSON.stringify
 * они уже сериализованы как \uXXXX, так что .length ≈ байтам).
 */
const VK_CHUNK_SIZE = 4000;


/* ─── VK Storage: чтение ──────────────────────────────────────── */

/**
 * Прочитать значение по ключу из VK Storage.
 * @param {string[]} keys
 * @returns {Promise<Record<string, string>>} { key: value }
 */
async function vkGet(keys) {
  const result = await window.vkBridge.send('VKWebAppStorageGet', { keys });
  // result — массив [{ key, value }]
  const map = {};
  for (const item of result.keys || []) {
    map[item.key] = item.value || '';
  }
  return map;
}

/**
 * Записать значение в VK Storage.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
async function vkSet(key, value) {
  await window.vkBridge.send('VKWebAppStorageSet', { key, value });
}

/**
 * Загрузить state из VK Storage.
 *
 * Алгоритм:
 *   1. Читаем мета-ключ — узнаём количество чанков.
 *   2. Если меты нет — state пустой, возвращаем null.
 *   3. Читаем все чанки одним батч-запросом (VK API поддерживает до 100 ключей).
 *   4. Склеиваем и парсим JSON.
 *
 * @returns {Promise<object|null>}
 */
async function vkLoadState() {
  try {
    // 1. Читаем мету
    const meta = await vkGet([VK_META_KEY]);
    const metaRaw = meta[VK_META_KEY];
    if (!metaRaw) return null;

    let metaData;
    try {
      metaData = JSON.parse(metaRaw);
    } catch {
      console.warn('[platform] битая мета, начинаем с чистого листа');
      return null;
    }

    const chunksCount = metaData.chunks || 0;
    if (chunksCount === 0) return null;

    // 2. Собираем ключи всех чанков
    const chunkKeys = [];
    for (let i = 0; i < chunksCount; i++) {
      chunkKeys.push(VK_CHUNK_PREFIX + i);
    }

    // 3. Читаем все чанки одним запросом
    const chunks = await vkGet(chunkKeys);

    // 4. Склеиваем в том же порядке
    let json = '';
    for (let i = 0; i < chunksCount; i++) {
      json += chunks[VK_CHUNK_PREFIX + i] || '';
    }

    if (!json) return null;
    return JSON.parse(json);
  } catch (err) {
    console.error('[platform] vkLoadState failed:', err);
    return null;
  }
}

/**
 * Сохранить state в VK Storage.
 *
 * Алгоритм:
 *   1. Сериализуем state.
 *   2. Режем JSON на чанки по 4000 символов.
 *   3. Узнаём, сколько чанков было в прошлый раз (из старой меты).
 *   4. Пишем новые чанки.
 *   5. Затираем «хвост» — если раньше было больше чанков, чем сейчас.
 *   6. Мета пишется ПОСЛЕДНЕЙ — это гарантирует, что при падении
 *      посреди записи мы не прочитаем «половину» state.
 *
 * @param {object} state
 * @returns {Promise<void>}
 */
async function vkSaveState(state) {
  try {
    const json = JSON.stringify(state);
    const chunks = [];
    for (let i = 0; i < json.length; i += VK_CHUNK_SIZE) {
      chunks.push(json.slice(i, i + VK_CHUNK_SIZE));
    }

    // Сколько чанков было раньше? (чтобы затереть хвост)
    let oldChunksCount = 0;
    try {
      const oldMeta = await vkGet([VK_META_KEY]);
      const raw = oldMeta[VK_META_KEY];
      if (raw) oldChunksCount = JSON.parse(raw).chunks || 0;
    } catch { /* меты не было — ок */ }

    // Пишем новые чанки последовательно
    for (let i = 0; i < chunks.length; i++) {
      await vkSet(VK_CHUNK_PREFIX + i, chunks[i]);
    }

    // Затираем «хвост», если он длиннее новых данных
    for (let i = chunks.length; i < oldChunksCount; i++) {
      await vkSet(VK_CHUNK_PREFIX + i, '');
    }

    // Мета — в самом конце
    await vkSet(VK_META_KEY, JSON.stringify({
      chunks: chunks.length,
      size: json.length,
      savedAt: Date.now()
    }));
  } catch (err) {
    console.error('[platform] vkSaveState failed:', err);
    // Пробрасываем наверх — store решит, показать ли toast
    throw err;
  }
}

/**
 * Полная очистка VK Storage (все чанки + мета).
 * @returns {Promise<void>}
 */
async function vkClearState() {
  try {
    const meta = await vkGet([VK_META_KEY]);
    const raw = meta[VK_META_KEY];
    const count = raw ? (JSON.parse(raw).chunks || 0) : 0;

    const keys = [VK_META_KEY];
    for (let i = 0; i < count; i++) keys.push(VK_CHUNK_PREFIX + i);

    // Записываем пустые строки (VK API не имеет «delete», только set '')
    for (const key of keys) {
      await vkSet(key, '');
    }
  } catch (err) {
    console.error('[platform] vkClearState failed:', err);
  }
}


/* ─── localStorage: чтение ───────────────────────────────────── */

/**
 * Загрузить state из localStorage.
 * @returns {Promise<object|null>}
 */
async function lsLoadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[platform] lsLoadState failed:', err);
    return null;
  }
}

/**
 * Сохранить state в localStorage.
 * @param {object} state
 * @returns {Promise<void>}
 */
async function lsSaveState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (err) {
    // QuotaExceededError — localStorage полон
    if (err.name === 'QuotaExceededError') {
      console.error('[platform] localStorage переполнен');
      throw new Error('Хранилище переполнено. Удалите старые записи.');
    }
    console.error('[platform] lsSaveState failed:', err);
    throw err;
  }
}

/**
 * Очистить localStorage.
 * @returns {Promise<void>}
 */
async function lsClearState() {
  localStorage.removeItem(LS_KEY);
}


/* ─── Публичные методы хранилища ─────────────────────────────── */

/**
 * Загрузить state. Возвращает null, если данных нет.
 * @returns {Promise<object|null>}
 */
async function loadState() {
  return isVK ? vkLoadState() : lsLoadState();
}

/**
 * Сохранить state.
 * @param {object} state
 * @returns {Promise<void>}
 */
async function saveState(state) {
  return isVK ? vkSaveState(state) : lsSaveState(state);
}

/**
 * Очистить все сохранённые данные.
 * @returns {Promise<void>}
 */
async function clearState() {
  return isVK ? vkClearState() : lsClearState();
}


/* ═══════════════════════════════════════════════════════════════
   ПОЛЬЗОВАТЕЛЬ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Получить данные пользователя.
 *
 * В VK: возвращает { id, name, photo, city, isVK: true }
 *       VK автоматически авторизует — пользователь уже вошёл во ВКонтакте.
 *
 * В браузере: null — гость вводит имя и телефон вручную.
 *
 * @returns {Promise<{id:number, name:string, photo:string, city:string, isVK:true}|null>}
 */
async function getUser() {
  if (!isVK) return null;

  try {
    const info = await window.vkBridge.send('VKWebAppGetUserInfo');
    return {
      id: info.id,
      name: [info.first_name, info.last_name].filter(Boolean).join(' '),
      photo: info.photo_200 || info.photo_100 || '',
      city: info.city?.title || '',
      isVK: true
    };
  } catch (err) {
    console.error('[platform] getUser failed:', err);
    return null;
  }
}


/* ═══════════════════════════════════════════════════════════════
   ОПЛАТА ЧЕРЕЗ VK
   ═══════════════════════════════════════════════════════════════ */

/**
 * Запросить оплату через VK.
 *
 * Работает ТОЛЬКО в VK Mini App с включёнными Payments.
 * В браузере возвращает { ok:false, reason:'not-vk' } — subscription.js
 * переключится на UI с кодом активации.
 *
 * ВАЖНО: VK присылает success на клиент, но настоящая проверка оплаты
 * делается на сервере через callback URL. Для MVP (без сервера) считаем
 * успех VK достаточным — риск минимален, суммы небольшие. Для продакшена
 * добавить Cloudflare Worker, который пишет состояние в VK Storage.
 *
 * @param {string} itemId — например 'subscription_month' или 'subscription_year'
 * @returns {Promise<{ok:boolean, orderId?:string, error?:string, reason?:string}>}
 */
async function requestVKPayment(itemId) {
  if (!isVK) {
    return { ok: false, reason: 'not-vk', error: 'Оплата через VK недоступна' };
  }

  try {
    const result = await window.vkBridge.send('VKWebAppShowOrderBox', {
      type: 'item',
      item: itemId
    });

    if (result.success) {
      return { ok: true, orderId: result.order_id || null };
    }

    return { ok: false, error: 'Оплата не завершена' };
  } catch (err) {
    // VK возвращает error_code: 4 — пользователь отменил
    if (err?.error_data?.error_code === 4) {
      return { ok: false, error: 'Оплата отменена' };
    }
    console.error('[platform] requestVKPayment failed:', err);
    return { ok: false, error: 'Ошибка оплаты: ' + (err?.message || 'unknown') };
  }
}


/* ═══════════════════════════════════════════════════════════════
   ЭКСПОРТ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Публичный API платформы.
 * Все остальные модули используют ТОЛЬКО его.
 */
export const platform = {
  isVK,
  init,
  loadState,
  saveState,
  clearState,
  getUser,
  requestVKPayment,

  // Для отладки в DevTools: platform.info() → { platform:'vk'|'browser', chunk:4000 }
  info() {
    return {
      platform: isVK ? 'vk' : 'browser',
      chunkSize: isVK ? VK_CHUNK_SIZE : null,
      storageKey: isVK ? VK_META_KEY : LS_KEY
    };
  }
};