/**
 * sw.js — service worker для PWA.
 *
 * Стратегии:
 *   - Навигация (HTML)   → network-first, offline fallback на кеш index.html
 *   - JS / CSS / assets  → stale-while-revalidate (сразу из кеша, потом обновление)
 *   - Остальное          → network-only
 *
 * При обновлении CACHE_VERSION старый кеш удаляется.
 */

const CACHE_VERSION = 'beautyflow-v6-1';
const OFFLINE_URL = './index.html';

// Что кешируем сразу при установке (core shell)
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './src/main.js',
  './src/utils.js',
  './src/platform.js',
  './src/store.js',
  './src/subscription.js',
  './src/modals.js',
  './src/views-guest.js',
  './src/views-admin.js'
];

/* ─── Install: precache shell ─── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.warn('[sw] precache partial fail:', err);
        // Не блокируем установку — часть файлов закешируется при первом запросе
      })
  );
});

/* ─── Activate: удалить старые кеши ─── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ─── Fetch: стратегии ─── */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Только GET
  if (request.method !== 'GET') return;

  // Не кешируем VK Bridge и внешние CDN
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Навигация (переход на страницу)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Обновляем кеш свежей страницей
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Статика: JS, CSS, изображения, шрифты
  const isAsset = /\.(js|css|svg|png|jpg|jpeg|woff2?|json|webmanifest)(\?|$)/i
    .test(url.pathname);

  if (isAsset) {
    event.respondWith(
      caches.match(request).then(cached => {
        // Возвращаем из кеша сразу
        const networkFetch = fetch(request)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);   // при ошибке сети — кеш

        return cached || networkFetch;
      })
    );
    return;
  }

  // Остальное — просто сеть
});

/* ─── Message: обновить кеш по команде из UI ─── */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});