/**
 * vk.js — все функции VK Mini App в одном модуле.
 *
 * В браузере работает как «no-op»: методы возвращают пустые значения,
 * чтобы views и modals не падали. Логика определяется флагом isVK.
 *
 * Публичный API:
 *   isVK                              — флаг
 *   init()                            — VK Bridge init
 *   getUser()                         — VK ID, имя, фото
 *   haptic(type)                      — вибрация (успех/ошибка/выбор)
 *   showToast(msg)                    — нативный toast VK
 *   shareBooking(booking)             — поделиться записью
 *   shareToStory()                    — сторис с обложкой
 *   openVKMessage(text)               — открыть чат VK с текстом
 *   openVKGroup(groupId)              — перейти в группу
 *   purchaseVKItem(itemId)            — VK Payments
 *   purchaseVKSubscription(itemId)    — VK Subscription (рекуррент)
 *   allowNotifications()              — разрешение на уведомления
 *   showNativeAds()                   — показать рекламу (VK Ads)
 */

/* ═══════════════════════════════════════════════════════════════
   ОПРЕДЕЛЕНИЕ ПЛАТФОРМЫ
   ═══════════════════════════════════════════════════════════════ */

function detectVK() {
  const hasBridge = typeof window.vkBridge !== 'undefined';
  const params = new URLSearchParams(window.location.search);
  const hasVKParams = params.has('vk_app_id') || params.has('vk_user_id');
  const host = window.location.hostname;
  const onVK = host.endsWith('vk.com') || host.endsWith('vk.ru');
  const inIframe = window.self !== window.top;
  return hasBridge && (hasVKParams || onVK || inIframe);
}

export const isVK = detectVK();


/* ═══════════════════════════════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ
   ═══════════════════════════════════════════════════════════════ */

let _initialized = false;

export async function init() {
  if (_initialized) return true;
  _initialized = true;

  if (!isVK) return false;

  try {
    await window.vkBridge.send('VKWebAppInit');
    console.info('[vk] инициализирован');
    return true;
  } catch (err) {
    console.error('[vk] init failed:', err);
    return false;
  }
}


/* ═══════════════════════════════════════════════════════════════
   АВТОРИЗАЦИЯ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Получить данные пользователя VK.
 * @returns {Promise<{
 *   id: number, name: string, photo: string, city: string, isVK: true
 * }|null>}
 */
export async function getUser() {
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
    console.error('[vk] getUser failed:', err);
    return null;
  }
}


/* ═══════════════════════════════════════════════════════════════
   HAPTIC FEEDBACK
   ═══════════════════════════════════════════════════════════════ */

/**
 * Тактильная отдача VK.
 * @param {'success'|'error'|'warning'|'selection'|'light'|'medium'|'heavy'} type
 */
export async function haptic(type = 'light') {
  if (!isVK) {
    // Fallback в браузере
    if (navigator.vibrate) {
      const ms = type === 'success' ? 20 : type === 'error' ? 40 : 10;
      try { navigator.vibrate(ms); } catch (_) {}
    }
    return;
  }

  const map = {
    success: 'VKWebAppTapticNotificationOccurred',
    error: 'VKWebAppTapticNotificationOccurred',
    warning: 'VKWebAppTapticNotificationOccurred',
    selection: 'VKWebAppTapticSelectionChanged',
    light: 'VKWebAppTapticImpactOccurred',
    medium: 'VKWebAppTapticImpactOccurred',
    heavy: 'VKWebAppTapticImpactOccurred'
  };

  const payload = {
    success: { type: 'success' },
    error: { type: 'error' },
    warning: { type: 'warning' },
    selection: {},
    light: { style: 'light' },
    medium: { style: 'medium' },
    heavy: { style: 'heavy' }
  };

  try {
    await window.vkBridge.send(map[type], payload[type]);
  } catch (_) {}
}


/* ═══════════════════════════════════════════════════════════════
   НАТИВНЫЕ УВЕДОМЛЕНИЯ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Показать нативный toast VK (в отличие от нашего HTML — появляется
 * поверх WebView, выглядит системно).
 * @param {string} message
 */
export async function showToast(message) {
  if (!isVK) return false;
  try {
    await window.vkBridge.send('VKWebAppShowNativeAds', {});
    // На самом деле VK не имеет «showToast», но есть Taptic
    // Используем наш HTML-toast как fallback
    return false;
  } catch (_) {
    return false;
  }
}


/* ═══════════════════════════════════════════════════════════════
   ШАРИНГ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Поделиться записью в VK.
 * @param {{date: string, time: string, serviceName: string, price: number}} booking
 * @returns {Promise<boolean>}
 */
export async function shareBooking(booking) {
  if (!isVK) return false;

  const text = `Я записан(а) на ${booking.serviceName} ` +
               `${formatBookingDate(booking.date)} в ${booking.time}. ` +
               `BeautyFlow — онлайн-запись в салон 💅`;

  try {
    await window.vkBridge.send('VKWebAppShare', {
      link: 'https://vk.com/app54868657'
    });
    return true;
  } catch (err) {
    console.error('[vk] shareBooking failed:', err);
    return false;
  }
}

/**
 * Поделиться в VK Stories.
 * Требует одобренного приложения и загруженной обложки.
 * @param {string} [bgUrl] — URL фонового изображения
 * @returns {Promise<boolean>}
 */
export async function shareToStory(bgUrl) {
  if (!isVK) return false;

  try {
    await window.vkBridge.send('VKWebAppShowStoryBox', {
      background_type: bgUrl ? 'image' : 'none',
      ...(bgUrl && { url: bgUrl }),
      stickers: [
        {
          sticker_type: 'renderable',
          sticker: {
            content_type: 'image',
            blob: '',
            background_type: 'none'
          }
        }
      ]
    });
    return true;
  } catch (err) {
    console.error('[vk] shareToStory failed:', err);
    return false;
  }
}


/* ═══════════════════════════════════════════════════════════════
   ССЫЛКИ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Открыть чат VK с предзаполненным текстом.
 * @param {string} text
 * @param {number} [peerId] — ID получателя
 */
export async function openVKMessage(text, peerId) {
  const params = new URLSearchParams();
  if (peerId) params.set('peer', peerId);
  if (text) params.set('message', text);
  const url = 'https://vk.com/im?' + params.toString();

  if (isVK) {
    try {
      await window.vkBridge.send('VKWebAppOpenApp', {
        app_id: 51812345,
        location: url
      });
      return true;
    } catch (_) {}
  }

  window.open(url, '_blank');
  return true;
}

/**
 * Открыть группу VK.
 * @param {string|number} groupId
 */
export async function openVKGroup(groupId) {
  const url = `https://vk.com/club${groupId}`;
  if (isVK) {
    try {
      await window.vkBridge.send('VKWebAppOpenApp', { app_id: 51812345 });
      window.location.href = url;
      return true;
    } catch (_) {}
  }
  window.open(url, '_blank');
  return true;
}

/**
 * Открыть профиль VK.
 * @param {number} userId
 */
export async function openVKProfile(userId) {
  const url = `https://vk.com/id${userId}`;
  window.open(url, '_blank');
}


/* ═══════════════════════════════════════════════════════════════
   ПЛАТЕЖИ VK
   ═══════════════════════════════════════════════════════════════ */

/**
 * Разовая покупка через VK Payments (VKWebAppShowOrderBox).
 * Требует одобрения приложения + настройки товаров в VK Dev Console.
 *
 * @param {string} itemId — например 'subscription_month'
 * @returns {Promise<{ ok: boolean, orderId?: string, error?: string, reason?: string }>}
 */
export async function purchaseVKItem(itemId) {
  if (!isVK) {
    return { ok: false, reason: 'not-vk', error: 'Оплата только в VK' };
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
    if (err?.error_data?.error_code === 4) {
      return { ok: false, error: 'Оплата отменена' };
    }
    console.error('[vk] purchaseVKItem failed:', err);
    return { ok: false, error: 'Ошибка оплаты' };
  }
}

/**
 * Рекуррентная подписка VK.
 * Требует отдельного одобрения VK для subscriptions.
 * VK сам списывает платёж каждый месяц.
 *
 * @param {string} itemId — например 'monthly_sub'
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function purchaseVKSubscription(itemId) {
  if (!isVK) {
    return { ok: false, error: 'Оплата только в VK' };
  }

  try {
    const result = await window.vkBridge.send('VKWebAppShowSubscriptionBox', {
      action: 'create',
      item: itemId
    });
    return { ok: !!result.success };
  } catch (err) {
    console.error('[vk] purchaseVKSubscription failed:', err);
    return { ok: false, error: err?.message || 'Ошибка подписки' };
  }
}


/* ═══════════════════════════════════════════════════════════════
   УВЕДОМЛЕНИЯ
   ═══════════════════════════════════════════════════════════════ */

/**
 * Запросить разрешение на push-уведомления от имени приложения.
 * @returns {Promise<{ allowed: boolean }>}
 */
export async function allowNotifications() {
  if (!isVK) return { allowed: false };

  try {
    const result = await window.vkBridge.send('VKWebAppAllowNotifications');
    return { allowed: !!result.result };
  } catch (err) {
    console.error('[vk] allowNotifications failed:', err);
    return { allowed: false };
  }
}

/**
 * Запросить доступ к сообщениям (VKWebAppAllowMessagesFromGroup).
 * Позволяет слать персональные уведомления через VK messages.
 * @param {number} groupId
 * @returns {Promise<{ allowed: boolean }>}
 */
export async function allowMessages(groupId) {
  if (!isVK) return { allowed: false };

  try {
    const result = await window.vkBridge.send('VKWebAppAllowMessagesFromGroup', {
      group_id: groupId
    });
    return { allowed: !!result.result };
  } catch (err) {
    console.error('[vk] allowMessages failed:', err);
    return { allowed: false };
  }
}


/* ═══════════════════════════════════════════════════════════════
   РЕКЛАМА VK ADS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Показать interstitial рекламу VK Ads (монетизация).
 * Требует подключения VK Ads в настройках приложения.
 * Показ возможен НЕ чаще одного раза в 60 секунд.
 * @returns {Promise<{ shown: boolean }>}
 */
export async function showInterstitialAd() {
  if (!isVK) return { shown: false };

  try {
    const result = await window.vkBridge.send('VKWebAppShowNativeAds', {
      ad_format: 'interstitial'
    });
    return { shown: !!result.result };
  } catch (err) {
    console.error('[vk] ad failed:', err);
    return { shown: false };
  }
}

/**
 * Показать rewarded рекламу (за просмотр — бонус).
 * @returns {Promise<{ shown: boolean }>}
 */
export async function showRewardedAd() {
  if (!isVK) return { shown: false };

  try {
    const result = await window.vkBridge.send('VKWebAppShowNativeAds', {
      ad_format: 'reward'
    });
    return { shown: !!result.result };
  } catch (err) {
    console.error('[vk] rewarded ad failed:', err);
    return { shown: false };
  }
}


/* ═══════════════════════════════════════════════════════════════
   УТИЛИТЫ
   ═══════════════════════════════════════════════════════════════ */

function formatBookingDate(dateStr) {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${months[m - 1]}`;
}


/* ═══════════════════════════════════════════════════════════════
   ЭКСПОРТ
   ═══════════════════════════════════════════════════════════════ */

export const vk = {
  isVK,
  init,
  getUser,
  haptic,
  showToast,
  shareBooking,
  shareToStory,
  openVKMessage,
  openVKGroup,
  openVKProfile,
  purchaseVKItem,
  purchaseVKSubscription,
  allowNotifications,
  allowMessages,
  showInterstitialAd,
  showRewardedAd
};
