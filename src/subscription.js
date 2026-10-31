/**
 * subscription.js — весь платный доступ.
 *
 * Что входит:
 *  1. Тарифы и лимиты (PLAN_LIMITS, PLANS).
 *  2. Проверка статуса подписки (checkSub).
 *  3. Trial: активация 14-дневного периода (startTrial).
 *  4. Активация кода (activateCode) — HMAC-валидация.
 *  5. Оплата через VK (purchase).
 *  6. Рендер paywall + обработчики.
 *  7. Хелпер для dev: генерация кодов (generateCode).
 *  8. Retention: чистка старых записей (pruneOldBookings).
 *
 * Зависимости:
 *  - store.js: state, setSubscription, deleteBooking (для prune)
 *  - platform.js: isVK, requestVKPayment
 *  - utils.js: toast, formatMoney, todayStr, addDays
 *
 * Не работает с DOM напрямую (кроме bindPaywall — он вешает
 * обработчики на существующие элементы).
 */

import { state, setSubscription, deleteBooking } from './store.js';
import { platform } from './platform.js';
import { toast, formatMoney, todayStr, addDays } from './utils.js';


/* ═══════════════════════════════════════════════════════════════
   КОНСТАНТЫ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Секрет для HMAC-подписи кодов активации.
 *
 * ⚠️ В продакшене этот секрет НЕ должен быть на клиенте.
 * Правильно: сервер выдаёт код, подписанный приватным ключом;
 * клиент проверяет публичным. Но для MVP / GH Pages — так:
 * секрет в коде, защита "от честных людей". Подделать код без
 * знания секрета нельзя, но если секрет утёк — защита пала.
 *
 * Меняйте при каждом релизе. Покупателям выдавайте новый код.
 */
const LICENSE_SECRET = 'bf-v6-2025-secret-change-me';

/**
 * Цены и лимиты по тарифам.
 * Используются в paywall и в проверках canAddBooking и т.п.
 */
export const PLANS = {
  trial: {
    id: 'trial',
    title: 'Пробный период',
    price: 0,
    days: 14,
    features: [
      'Все функции на 14 дней',
      'До 200 записей',
      'До 100 клиентов',
      'Без карты'
    ]
  },
  monthly: {
    id: 'monthly',
    title: 'Месяц',
    price: 299,
    days: 30,
    itemId: 'subscription_month',
    badge: null,
    features: [
      'Без ограничений по времени',
      'До 2 000 записей',
      'До 1 000 клиентов',
      'Экспорт и импорт JSON'
    ]
  },
  yearly: {
    id: 'yearly',
    title: 'Год',
    price: 2870,             // 299 * 12 * 0.8 = 2870, экономия 20%
    days: 365,
    itemId: 'subscription_year',
    badge: '-20%',
    features: [
      'Всё из тарифа «Месяц»',
      'До 5 000 записей',
      'До 3 000 клиентов',
      'Приоритетная поддержка'
    ]
  }
};

/**
 * Лимиты данных по тарифам. Проверяются в views перед созданием записи.
 * retentionMonths: через сколько месяцев старые записи архивируются
 * (реализовано в pruneOldBookings).
 */
export const PLAN_LIMITS = {
  trial:   { bookings: 200,  clients: 100,  retentionMonths: 12 },
  monthly: { bookings: 2000, clients: 1000, retentionMonths: 24 },
  yearly:  { bookings: 5000, clients: 3000, retentionMonths: 36 }
};


/* ═══════════════════════════════════════════════════════════════
   ПРОВЕРКА СТАТУСА
   ═══════════════════════════════════════════════════════════════ */

/**
 * Текущий статус подписки. Главный селектор.
 *
 * Возможные состояния:
 *   - Нет подписки:       { active: false, reason: 'no-subscription' }
 *   - Истекла:            { active: false, reason: 'expired', daysLeft: 0, ... }
 *   - Активна (trial):    { active: true, isTrial: true, daysLeft: N, ... }
 *   - Активна (платная):  { active: true, isTrial: false, plan, daysLeft, ... }
 *
 * @returns {{
 *   active: boolean,
 *   reason?: 'no-subscription'|'expired',
 *   plan?: 'trial'|'monthly'|'yearly',
 *   daysLeft?: number,
 *   expiresAt?: string,
 *   isTrial?: boolean,
 *   trialUsed?: boolean
 * }}
 */
export function checkSub() {
  const sub = state.subscription;

  // Нет подписки — сразу предложить trial или оплату
  if (!sub || !sub.expiresAt) {
    return {
      active: false,
      reason: 'no-subscription',
      trialUsed: !!sub?.trialUsed
    };
  }

  const now = Date.now();
  const exp = new Date(sub.expiresAt).getTime();
  const daysLeft = Math.max(0, Math.ceil((exp - now) / 86400000));

  // Истекла
  if (exp <= now) {
    return {
      active: false,
      reason: 'expired',
      plan: sub.plan,
      daysLeft: 0,
      expiresAt: sub.expiresAt,
      trialUsed: !!sub.trialUsed
    };
  }

  // Активна
  return {
    active: true,
    plan: sub.plan,
    daysLeft,
    expiresAt: sub.expiresAt,
    isTrial: sub.plan === 'trial',
    trialUsed: !!sub.trialUsed
  };
}

/**
 * Доступен ли ещё trial (не использовался ни разу).
 * @returns {boolean}
 */
export function isTrialAvailable() {
  return !state.subscription?.trialUsed;
}


/* ═══════════════════════════════════════════════════════════════
   TRIAL
   ═══════════════════════════════════════════════════════════════ */

/**
 * Запустить 14-дневный пробный период. Один раз на аккаунт.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function startTrial() {
  if (!isTrialAvailable()) {
    return { ok: false, error: 'Пробный период уже использован' };
  }

  const plan = PLANS.trial;
  const expiresAt = new Date(Date.now() + plan.days * 86400000).toISOString();

  setSubscription({
    plan: 'trial',
    expiresAt,
    activatedAt: new Date().toISOString(),
    trialUsed: true
  });

  return { ok: true };
}


/* ═══════════════════════════════════════════════════════════════
   АКТИВАЦИЯ КОДА (HMAC)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Активировать код подписки.
 *
 * Формат кода: BASE64(payload) + '.' + BASE64(HMAC-SHA256(payload, secret))
 * где payload = "YYYY-MM-DDTHH:MM:SS.sssZ|monthly"  (ISO-дата истечения | план)
 *
 * Проверка:
 *   1. Код разбивается на payload и подпись.
 *   2. Подпись пересчитывается на клиенте с LICENSE_SECRET.
 *   3. Если совпала — проверяется, что дата истечения ещё не наступила.
 *   4. Если всё ок — продлевает подписку от текущей даты (или от expiresAt, если активна).
 *
 * @param {string} rawCode
 * @returns {Promise<{ ok: boolean, error?: string, plan?: string, expiresAt?: string }>}
 */
export async function activateCode(rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return { ok: false, error: 'Введите код' };

  const [payloadB64, sigB64] = code.split('.');
  if (!payloadB64 || !sigB64) {
    return { ok: false, error: 'Неверный формат кода' };
  }

  try {
    // 1. Восстанавливаем payload
    const payload = atob(padBase64(payloadB64));

    // 2. Пересчитываем подпись
    const expectedSig = await hmacB64(payload, LICENSE_SECRET);
    if (expectedSig !== sigB64) {
      return { ok: false, error: 'Код недействителен' };
    }

    // 3. Разбираем payload: "ISO_DATE|plan"
    const [expiresISO, planId] = payload.split('|');
    if (!expiresISO || !planId) {
      return { ok: false, error: 'Повреждённый код' };
    }

    // 4. Проверяем срок
    const expiresTs = new Date(expiresISO).getTime();
    if (!Number.isFinite(expiresTs)) {
      return { ok: false, error: 'Некорректная дата в коде' };
    }
    if (expiresTs <= Date.now()) {
      return { ok: false, error: 'Срок действия кода истёк' };
    }

    // 5. Определяем новый expiresAt:
    //    если текущая подписка активна — продлеваем от её конца
    //    иначе — от даты в коде
    const currentTs = state.subscription?.expiresAt
      ? new Date(state.subscription.expiresAt).getTime()
      : 0;
    const baseTs = Math.max(currentTs, Date.now());
    const bonusDays = Math.ceil((expiresTs - Date.now()) / 86400000);
    const newExpiresTs = baseTs + bonusDays * 86400000;

    setSubscription({
      plan: planId,
      expiresAt: new Date(newExpiresTs).toISOString(),
      activatedAt: new Date().toISOString(),
      trialUsed: !!state.subscription?.trialUsed,
      lastCode: payloadB64.slice(0, 8) + '…'   // для отладки, не полный код
    });

    return {
      ok: true,
      plan: planId,
      expiresAt: new Date(newExpiresTs).toISOString()
    };
  } catch (err) {
    console.error('[subscription] activateCode failed:', err);
    return { ok: false, error: 'Ошибка обработки кода' };
  }
}


/* ═══════════════════════════════════════════════════════════════
   ОПЛАТА ЧЕРЕЗ VK
   ═══════════════════════════════════════════════════════════════ */

/**
 * Купить тариф.
 *
 * В VK: вызывает VKWebAppShowOrderBox через platform.requestVKPayment.
 *       После успеха продлевает подписку.
 * В браузере: возвращает ошибку (оплата доступна только через код).
 *
 * @param {'monthly'|'yearly'} planId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function purchase(planId) {
  const plan = PLANS[planId];
  if (!plan || !plan.itemId) {
    return { ok: false, error: 'Неизвестный тариф' };
  }

  if (!platform.isVK) {
    return {
      ok: false,
      error: 'Оплата доступна только в приложении ВКонтакте'
    };
  }

  const result = await platform.requestVKPayment(plan.itemId);

  if (!result.ok) {
    return { ok: false, error: result.error || 'Оплата не завершена' };
  }

  // Успех — продлеваем подписку
  extendSubscription(planId, plan.days, result.orderId);
  return { ok: true };
}

/**
 * Продлить или активировать подписку.
 * Внутренняя: вызывается из purchase и activateCode.
 *
 * @param {'trial'|'monthly'|'yearly'} planId
 * @param {number} days
 * @param {string} [orderId]
 */
function extendSubscription(planId, days, orderId) {
  const currentTs = state.subscription?.expiresAt
    ? new Date(state.subscription.expiresAt).getTime()
    : 0;
  const baseTs = Math.max(currentTs, Date.now());
  const newExpiresTs = baseTs + days * 86400000;

  setSubscription({
    plan: planId,
    expiresAt: new Date(newExpiresTs).toISOString(),
    activatedAt: state.subscription?.activatedAt || new Date().toISOString(),
    trialUsed: !!state.subscription?.trialUsed,
    vkOrderId: orderId || null
  });
}


/* ═══════════════════════════════════════════════════════════════
   ХЕЛПЕРЫ ДЛЯ HMAC
   ═══════════════════════════════════════════════════════════════ */

/**
 * Base64 → добавляем "=" до кратной длины. Нужно для atob.
 * @param {string} s
 * @returns {string}
 */
function padBase64(s) {
  return s + '='.repeat((4 - s.length % 4) % 4);
}

/**
 * HMAC-SHA256 в Base64 (без "=" padding для компактности).
 *
 * Используется и для подписи кода (в generateCode),
 * и для проверки (в activateCode).
 *
 * @param {string} payload
 * @param {string} secret
 * @returns {Promise<string>}
 */
async function hmacB64(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=+$/, '');
}


/* ═══════════════════════════════════════════════════════════════
   ГЕНЕРАЦИЯ КОДОВ — только для разработчика
   ═══════════════════════════════════════════════════════════════ */

/**
 * Сгенерировать код подписки. Используется для тестов
 * и для ручной продажи клиентам.
 *
 * ⚠️ В продакшене это должно быть в отдельном админском
 * инструменте с серверным секретом, а не в клиенте.
 * Но для MVP — можно звать из консоли:
 *
 *   const s = await import('./src/subscription.js');
 *   const code = await s.generateCode(1, 'monthly');
 *   console.log(code);  // передать покупателю
 *
 * @param {number} months 1 = месяц, 12 = год, 0.5 = 15 дней
 * @param {'monthly'|'yearly'|'trial'} plan
 * @returns {Promise<string>}
 */
export async function generateCode(months = 1, plan = 'monthly') {
  const days = Math.round(months * 30);
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const payload = `${expires}|${plan}`;
  const sig = await hmacB64(payload, LICENSE_SECRET);

  // Payload кодируем в base64 (UTF-8 safe)
  const enc = new TextEncoder();
  const bytes = enc.encode(payload);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const payloadB64 = btoa(binary).replace(/=+$/, '');

  return payloadB64 + '.' + sig;
}


/* ═══════════════════════════════════════════════════════════════
   RETENTION — чистка старых записей
   ═══════════════════════════════════════════════════════════════ */

/**
 * Удалить записи старше retention плана.
 * Вызывать раз в сутки при загрузке (в main.js после store.load()).
 *
 * Что делает: проверяет дату каждой записи. Если она старше
 * retentionMonths для текущего плана — удаляет. Не активные,
 * а завершённые (done/cancelled/noshow). Pending/confirmed
 * не удаляются, даже если дата в прошлом (админ должен
 * вручную разобраться).
 *
 * @returns {number} сколько удалено
 */
export function pruneOldBookings() {
  const sub = checkSub();
  if (!sub.active) return 0;

  const limits = PLAN_LIMITS[sub.plan] || PLAN_LIMITS.monthly;
  const months = limits.retentionMonths;
  if (!months || months <= 0) return 0;

  const cutoff = addDays(todayStr(), -months * 30);
  const toDelete = state.bookings.filter(b =>
    b.date < cutoff &&
    b.status !== 'pending' &&
    b.status !== 'confirmed'
  );

  for (const b of toDelete) {
    deleteBooking(b.id);
  }

  return toDelete.length;
}


/* ═══════════════════════════════════════════════════════════════
   PAYWALL — рендер и обработчики
   ═══════════════════════════════════════════════════════════════ */

/**
 * Отрендерить экран paywall.
 *
 * Логика по статусу:
 *   - no-subscription + trialAvailable → кнопка trial + коды + планы
 *   - no-subscription + trialUsed      → только коды + планы
 *   - expired                          → продление (коды + планы)
 *
 * В VK дополнительно показываются кнопки "Купить через VK".
 * В браузере — поле для ввода кода.
 *
 * @param {object} sub — результат checkSub()
 * @returns {string} HTML
 */
export function renderPaywall(sub) {
  const trialAvailable = !sub.trialUsed;
  const isExpired = sub.reason === 'expired';
  const showVKButtons = platform.isVK;

  return `
    <div class="paywall">
      <div class="paywall-logo">B</div>
      <h2>${isExpired ? 'Подписка истекла' : 'BeautyFlow'}</h2>
      <p>${isExpired
        ? 'Продлите доступ, чтобы продолжить работу'
        : 'Управление салоном — в вашем кармане'}</p>

      ${trialAvailable ? `
        <button class="paywall-btn primary" id="btnTrial">
          Попробовать 14 дней бесплатно
        </button>
        <div class="paywall-divider">или выберите тариф</div>
      ` : ''}

      ${showVKButtons ? `
        <button class="paywall-card" data-plan="monthly">
          <div>
            <div class="pc-title">${PLANS.monthly.title}</div>
            <div class="pc-sub">${PLANS.monthly.features[0]}</div>
          </div>
          <div>
            <div class="pc-price">${formatMoney(PLANS.monthly.price)}</div>
            <div class="pc-sub">в месяц</div>
          </div>
        </button>
        <button class="paywall-card" data-plan="yearly">
          <div>
            <div class="pc-title">
              ${PLANS.yearly.title}
              <span class="pc-badge">${PLANS.yearly.badge}</span>
            </div>
            <div class="pc-sub">≈ ${formatMoney(Math.round(PLANS.yearly.price / 12))}/мес</div>
          </div>
          <div>
            <div class="pc-price">${formatMoney(PLANS.yearly.price)}</div>
            <div class="pc-sub">в год</div>
          </div>
        </button>
      ` : `
        <div class="hint-box" style="text-align:left">
          <b>Оплата недоступна в браузере.</b>
          Коды активации выдаются после оплаты — свяжитесь с нами
          или откройте приложение в VK.
        </div>
      `}

      <div style="margin-top:16px">
        <input id="paywallCode" type="text" placeholder="Код активации"
               style="width:100%;padding:12px;border:1px solid var(--line);
                      border-radius:12px;font-size:.88rem;font-family:monospace;
                      background:var(--cream);margin-bottom:8px">
        <button class="paywall-btn" id="btnActivate"
                style="background:var(--ink);color:#fff">
          Активировать код
        </button>
      </div>

      <p class="paywall-note" id="paywallErr"></p>
    </div>
  `;
}

/**
 * Повесить обработчики на элементы paywall.
 * После успешной активации/оплаты — перезагружает страницу,
 * чтобы main.js пересобрал приложение с новой подпиской.
 *
 * @param {() => void} [onSuccess] — если не передан, делаем location.reload()
 */
export function bindPaywall(onSuccess) {
  const success = () => {
    if (typeof onSuccess === 'function') onSuccess();
    else location.reload();
  };

  const errEl = document.getElementById('paywallErr');
  const showError = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.color = 'var(--red)';
    } else {
      toast(msg);
    }
  };

  // Trial
  const trialBtn = document.getElementById('btnTrial');
  if (trialBtn) {
    trialBtn.addEventListener('click', () => {
      const res = startTrial();
      if (res.ok) {
        toast('Пробный период активирован');
        setTimeout(success, 500);
      } else {
        showError(res.error || 'Ошибка');
      }
    });
  }

  // Активация кода
  const activateBtn = document.getElementById('btnActivate');
  const codeInput = document.getElementById('paywallCode');
  if (activateBtn && codeInput) {
    activateBtn.addEventListener('click', async () => {
      activateBtn.disabled = true;
      activateBtn.textContent = 'Проверяем…';

      const res = await activateCode(codeInput.value);

      activateBtn.disabled = false;
      activateBtn.textContent = 'Активировать код';

      if (res.ok) {
        toast('Подписка активирована');
        setTimeout(success, 500);
      } else {
        showError(res.error || 'Код не принят');
      }
    });

    // Enter в поле — активировать
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') activateBtn.click();
    });
  }

  // Кнопки VK-оплаты
  document.querySelectorAll('[data-plan]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const planId = btn.dataset.plan;
      btn.disabled = true;
      btn.style.opacity = '.6';

      const res = await purchase(planId);

      btn.disabled = false;
      btn.style.opacity = '';

      if (res.ok) {
        toast('Оплата прошла, спасибо!');
        setTimeout(success, 500);
      } else {
        showError(res.error || 'Ошибка оплаты');
      }
    });
  });
}


/* ═══════════════════════════════════════════════════════════════
   ДИАГНОСТИКА (для отладки в DevTools)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Вернуть «снимок» состояния подписки для DevTools.
 * Использование: const s = await import('./src/subscription.js'); s.debugSub();
 */
export function debugSub() {
  const sub = checkSub();
  console.table({
    'Активна': sub.active,
    'План': sub.plan || '—',
    'Дней осталось': sub.daysLeft ?? '—',
    'Истекает': sub.expiresAt || '—',
    'Trial доступен': isTrialAvailable(),
    'Причина': sub.reason || 'ok'
  });
  return sub;
}