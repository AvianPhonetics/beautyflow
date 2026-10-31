/**
 * main.js — точка сборки приложения.
 * Views подгружаются динамически. Если файлов ещё нет — работает fallback.
 */

import { platform } from './platform.js';
import { load, state, saveImmediate } from './store.js';
import { checkSub, renderPaywall, bindPaywall, pruneOldBookings } from './subscription.js';
import { openLogin, askConfirm } from './modals.js';

let viewsGuest = null;
let viewsAdmin = null;

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  book: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  clients: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  services: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21 8 14 2 9.4h7.6z"/></svg>',
  profile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3-7 8-7s8 3 8 7"/></svg>',
  my: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
};

const ROUTES_GUEST = [
  { id: 'home',    icon: ICONS.home,    label: 'Главная' },
  { id: 'book',    icon: ICONS.book,    label: 'Запись' },
  { id: 'my',      icon: ICONS.my,      label: 'Мои' },
  { id: 'profile', icon: ICONS.profile, label: 'Профиль' }
];

const ROUTES_ADMIN = [
  { id: 'home',     icon: ICONS.home,     label: 'Главная' },
  { id: 'book',     icon: ICONS.book,     label: 'Записи' },
  { id: 'clients',  icon: ICONS.clients,  label: 'Клиенты' },
  { id: 'services', icon: ICONS.services, label: 'Услуги' },
  { id: 'profile',  icon: ICONS.profile,  label: 'Профиль' }
];

let _booted = false;

async function boot() {
  if (_booted) return;
  _booted = true;

  document.getElementById('view').innerHTML = `
    <div class="boot-loader">
      <div class="boot-spinner"></div>
      <div>Загрузка…</div>
    </div>
  `;

  try {
    await platform.init();
    console.info('[main] platform:', platform.info());

    await load();
    console.info('[main] state:', {
      services: state.services.length,
      clients: state.clients.length,
      bookings: state.bookings.length,
      role: state.role
    });

    const pruned = pruneOldBookings();
    if (pruned > 0) console.info('[main] pruned', pruned, 'записей');

    await loadViews();
    bindGlobalEvents();
    renderApp();

  } catch (err) {
    console.error('[main] boot failed:', err);
    document.getElementById('view').innerHTML = `
      <div style="padding:20px;color:var(--red);font-family:monospace;
                  font-size:.82rem;white-space:pre-wrap;word-break:break-word">
        <div style="font-weight:700;margin-bottom:8px">Ошибка загрузки</div>
        <div>${err?.message || err}</div>
        <pre style="margin-top:12px;font-size:.72rem;color:var(--muted)">
${err?.stack || ''}</pre>
        <button onclick="location.reload()" style="margin-top:20px;padding:10px 16px;
                border-radius:10px;background:var(--terra);color:#fff;font-weight:700">
          Перезагрузить
        </button>
      </div>
    `;
  }
}

async function loadViews() {
  try {
    viewsGuest = await import('./views-guest.js');
    console.info('[main] views-guest.js загружен');
  } catch (e) {
    console.warn('[main] views-guest.js недоступен');
  }
  try {
    viewsAdmin = await import('./views-admin.js');
    console.info('[main] views-admin.js загружен');
  } catch (e) {
    console.warn('[main] views-admin.js недоступен');
  }
}

/* ─── Главный рендер ─── */

function renderApp() {
  const sub = checkSub();

  if (state.role === 'admin' && !sub.active) {
    const topbar = document.getElementById('topbar');
    const nav = document.getElementById('bottomNav');
    if (topbar) topbar.classList.add('hidden');
    if (nav) nav.style.display = 'none';

    document.getElementById('view').innerHTML = renderPaywall(sub);
    bindPaywall(() => renderApp());
    return;
  }

  const topbar = document.getElementById('topbar');
  if (topbar) topbar.classList.remove('hidden');
  render();
}

function render() {
  renderTopbar();
  renderView();
  renderBottomNav();
}

function renderTopbar() {
  const nameEl = document.getElementById('salonName');
  if (nameEl) nameEl.textContent = state.salon.name || 'BeautyFlow';

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.classList.toggle('hidden', !state.role);
    logoutBtn.onclick = handleLogout;
  }
}

function renderView() {
  const viewEl = document.getElementById('view');
  viewEl.innerHTML = renderViewHtml();
  bindCurrentView();
  viewEl.scrollTop = 0;
}

function renderViewHtml() {
  if (!state.role) {
    if (viewsGuest?.renderPublicHome) return viewsGuest.renderPublicHome();
    return renderFallback('Главная', 'guest');
  }

  if (state.role === 'admin') {
    const map = {
      home:     'renderAdminHome',
      book:     'renderAdminBook',
      clients:  'renderClients',
      services: 'renderServices',
      reports:  'renderReports',
      expenses: 'renderExpenses',
      profile:  'renderAdminProfile'
    };
    const fn = viewsAdmin?.[map[state.view]];
    return fn ? fn() : renderFallback(labelFor(state.view, 'admin'), 'admin');
  }

  const map = {
    home:    'renderGuestHome',
    book:    'renderGuestBook',
    my:      'renderGuestBookings',
    profile: 'renderGuestProfile'
  };
  const fn = viewsGuest?.[map[state.view]];
  return fn ? fn() : renderFallback(labelFor(state.view, 'guest'), 'guest');
}

function labelFor(viewId, role) {
  const routes = role === 'admin' ? ROUTES_ADMIN : ROUTES_GUEST;
  return routes.find(r => r.id === viewId)?.label || viewId;
}

function bindCurrentView() {
  if (!state.role) {
    viewsGuest?.bindPublicEvents?.();
  } else if (state.role === 'admin') {
    viewsAdmin?.bindAdminEvents?.();
  } else {
    viewsGuest?.bindGuestEvents?.();
  }
}

function renderFallback(title, roleName) {
  const fileNum = roleName === 'guest' ? '7' : '8';

  // Кнопки тестового входа — пока views не готовы
  const loginButtons = !state.role ? `
    <div style="margin-top:20px;display:flex;flex-direction:column;gap:8px">
      <button class="btn btn-primary" id="tmpLoginGuest">Войти как гость (тест)</button>
      <button class="btn btn-ghost" id="tmpLoginAdmin">Войти как админ (тест)</button>
    </div>
  ` : '';

  return `
    <div class="section-head">
      <h2>${title}</h2>
      <p>views-${roleName}.js — файл ${fileNum}</p>
    </div>
    <div class="empty-box" style="padding:32px 20px;text-align:center">
      <div style="font-size:2rem;margin-bottom:12px">🚧</div>
      <div style="font-weight:700;margin-bottom:6px;font-size:1rem">
        Модуль в разработке
      </div>
      <div style="font-size:.82rem;color:var(--muted);margin-bottom:16px">
        База работает. UI будет в файле <b>${fileNum}</b>.
      </div>
      <div style="padding:14px;background:var(--cream);border-radius:12px;
                  font-size:.78rem;text-align:left;line-height:1.7">
        <div style="font-weight:700;margin-bottom:6px;color:var(--ink)">State:</div>
        <div>Услуг: <b>${state.services.length}</b></div>
        <div>Клиентов: <b>${state.clients.length}</b></div>
        <div>Записей: <b>${state.bookings.length}</b></div>
        <div>Расходов: <b>${state.expenses.length}</b></div>
        <div>Роль: <b>${state.role || '—'}</b></div>
      </div>
      ${loginButtons}
    </div>
  `;
}

function renderBottomNav() {
  const nav = document.getElementById('bottomNav');

  if (!state.role) {
    nav.style.display = 'none';
    nav.innerHTML = '';
    document.getElementById('view').style.paddingBottom = '24px';
    return;
  }

  nav.style.display = '';
  document.getElementById('view').style.paddingBottom =
    'calc(var(--bnav-h) + var(--safe-b) + 24px)';

  const isAdmin = state.role === 'admin';
  const routes = isAdmin ? ROUTES_ADMIN : ROUTES_GUEST;
  nav.style.gridTemplateColumns = `repeat(${routes.length}, 1fr)`;

  const pendingCount = isAdmin
    ? state.bookings.filter(b => b.status === 'pending').length
    : 0;

  nav.innerHTML = routes.map(r => {
    const active = state.view === r.id;
    const badge = (r.id === 'book' && pendingCount > 0)
      ? `<span class="tab-badge">${pendingCount > 9 ? '9+' : pendingCount}</span>`
      : '';
    return `<button class="tab ${active ? 'active' : ''}" data-view="${r.id}">
      ${r.icon}
      ${r.label}
      ${badge}
    </button>`;
  }).join('');

  nav.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const viewId = tab.dataset.view;
      if (viewId === state.view) return;
      state.view = viewId;
      if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {}
      render();
    });
  });

  // Временные кнопки тестового входа (в fallback)
  const tmpGuest = document.getElementById('tmpLoginGuest');
  const tmpAdmin = document.getElementById('tmpLoginAdmin');
  if (tmpGuest) tmpGuest.onclick = () => openLogin('guest', () => renderApp());
  if (tmpAdmin) tmpAdmin.onclick = () => openLogin('admin', () => renderApp());
}

function handleLogout() {
  askConfirm('Выйти из аккаунта?', 'Вы вернётесь на главный экран.', async () => {
    state.role = null;
    state.user = { name: '', phone: '' };
    state.view = 'home';
    await saveImmediate();
    renderApp();
  }, { yesLabel: 'Выйти', danger: true });
}

function bindGlobalEvents() {
  window.addEventListener('bf:refresh', () => render());

  window.addEventListener('error', (e) => {
    console.error('[main] global error:', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[main] unhandled rejection:', e.reason);
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__installPrompt = e;
    render();
  });
  window.addEventListener('appinstalled', () => {
    window.__installPrompt = null;
    console.info('[main] PWA установлено');
  });

  if ('serviceWorker' in navigator && !platform.isVK) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.info('[main] SW зарегистрирован'))
        .catch((err) => console.warn('[main] SW:', err.message));
    });
  }
}

export function switchView(viewId) {
  if (state.view === viewId) return;
  state.view = viewId;
  render();
}

export function showLogin(role = 'guest') {
  openLogin(role, () => renderApp());
}

boot();