// Macai TCG — SPA en JavaScript puro con rutas por hash (#/...)
import { sceneSVG, emblemSVG } from './scene.js';
import { SECTIONS, SECTION_LABEL, CATEGORY_LABEL, MAX_QTY, deckSummary, deckToText, parseDeckText, mergeCards } from './deck-rules.js';
import { parseLog, analyze, guessDeck, turnSummary } from './ptcgl-log.js';
import { mountCardBackground } from './bg-cards.js';
import { startRoundTimer, applyTimer, clockHTML, alertsEnabled, enableAlerts, disableAlerts } from './round-timer.js';

mountCardBackground();

// Efecto holográfico: la carta se inclina en 3D y el brillo sigue al ratón
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.addEventListener('pointermove', (e) => {
  if (reduceMotion || e.pointerType !== 'mouse') return;
  const card = e.target.closest?.('.card, .gallery-main, .floater');
  document.querySelectorAll('.holo-on').forEach(c => { if (c !== card) resetHolo(c); });
  if (!card) return;
  const r = card.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  card.classList.add('holo-on');
  card.style.setProperty('--rx', `${(0.5 - y) * 14}deg`);
  card.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
  card.style.setProperty('--mx', `${x * 100}%`);
  card.style.setProperty('--my', `${y * 100}%`);
});
function resetHolo(c) {
  c.classList.remove('holo-on');
  ['--rx', '--ry', '--mx', '--my'].forEach(p => c.style.removeProperty(p));
}

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let currentUser = null;

// ---------- Celular: menú desplegable, tablas como tarjetas y altura de la barra ----------
const $topbar = document.querySelector('.topbar');


// El aviso de partida se pega justo debajo de la barra, mida lo que mida
const syncTopbar = () => document.documentElement.style.setProperty('--topbar-h', `${$topbar.offsetHeight}px`);
new ResizeObserver(syncTopbar).observe($topbar);

// En pantallas angostas cada fila de tabla se ve como tarjeta: cada celda lleva el nombre de su columna
function labelTables(root = $app) {
  root.querySelectorAll('table.mine').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (heads[i] && !td.dataset.label) td.dataset.label = heads[i];
      td.classList.toggle('no-label', !heads[i]);
    }));
  });
}
new MutationObserver(() => labelTables()).observe($app, { childList: true, subtree: true });

const GAME_LABEL = { pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!', any: 'Universal' };
// Accesorios (mismas claves que el servidor)
const ACC_CATEGORIES = {
  sleeves: { label: 'Micas y protectores', icon: '🛡️' },
  deckbox: { label: 'Deck box', icon: '📦' },
  playmat: { label: 'Tapetes', icon: '🟪' },
  binder: { label: 'Carpetas', icon: '📒' },
  toploader: { label: 'Toploaders y estuches', icon: '💎' },
  dice: { label: 'Dados y marcadores', icon: '🎲' },
  storage: { label: 'Cajas y organizadores', icon: '🗃️' },
  other: { label: 'Otros', icon: '✨' },
};
const ACC_CONDITIONS = { NEW: 'Nuevo (sellado)', LIKE_NEW: 'Como nuevo', USED: 'Usado' };
const ACC_GAMES = { any: 'Cualquier juego', pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };
const isAcc = (l) => l.kind === 'accessory';
const condLabel = (l) => (isAcc(l) ? ACC_CONDITIONS[l.condition] || l.condition : l.condition);
const CONDITIONS = {
  NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Dañada',
};
const LANGUAGES = ['Español', 'Inglés', 'Japonés', 'Portugués', 'Francés', 'Alemán', 'Italiano', 'Coreano', 'Chino'];

// ---------- Utilidades ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Precios en pesos mexicanos: "$1,250 MXN" (sin centavos si el monto es entero)
const money = (n) => {
  const v = Number(n) || 0;
  const d = Number.isInteger(v) ? 0 : 2;
  return `${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: d, maximumFractionDigits: d }).format(v)} MXN`;
};
const usd = (n) => `US${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)}`;
// Texto del tipo de cambio usado para convertir el precio de mercado
const fxNote = (fx) => (fx ? `tipo de cambio ${fx.rate.toFixed(2)} MXN por dólar (${esc(fx.source)}, ${esc(fx.date || '')})` : '');
const safeImg = (url) => (/^(https?:\/\/|\/uploads\/)/i.test(url || '') ? url : '');
const MAX_PHOTOS = 6;
// Fecha corta (ej. 24/11/2026). Acepta ISO con zona o 'YYYY-MM-DD HH:MM:SS' en UTC sin zona.
const fmtDay = (v) => {
  if (!v) return '—';
  const s = String(v);
  const d = new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-MX');
};

// Botones para llamar o escribir por WhatsApp al vendedor (números de 10 dígitos se toman como de México, +52)
function contactButtons(contact, cardName) {
  const digits = String(contact).replace(/\D/g, '');
  if (digits.length < 8) return '';
  const intl = digits.length === 10 ? `52${digits}` : digits;
  const msg = encodeURIComponent(`Hola, vi tu carta "${cardName}" en Macai TCG. ¿Sigue disponible?`);
  return `<div class="contact-btns">
    <a class="btn small" href="tel:+${intl}">📞 Llamar</a>
    <a class="btn small whatsapp" href="https://wa.me/${intl}?text=${msg}" target="_blank" rel="noopener">💬 WhatsApp</a>
  </div>`;
}

// Imagen que representa la carta en el catálogo: la oficial si existe, si no la primera foto real
const coverImg = (l) => safeImg(l.image_url) || safeImg(l.cover_photo);

// Comparación del precio del vendedor con el precio estimado de mercado
function marketCompare(price, market) {
  if (!market) return '';
  const diff = Math.round(((price - market) / market) * 100);
  if (Math.abs(diff) < 3) return '<span class="cmp eq">≈ precio de mercado</span>';
  return diff < 0
    ? `<span class="cmp low">${-diff}% bajo mercado</span>`
    : `<span class="cmp high">${diff}% sobre mercado</span>`;
}

// Reduce las fotos en el navegador antes de subirlas (máx. 1400 px, JPEG)
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2500);
}

const go = (hash) => { location.hash = hash; };
const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- Navegación ----------

// Secciones principales: en computadora van en la barra superior; en celular, en la barra inferior
const SECTIONS_NAV = [
  { key: '', href: '#/', icon: '🃏', label: 'Cartas' },
  { key: 'accesorios', href: '#/accesorios', icon: '🎒', label: 'Accesorios' },
  { key: 'decks', href: '#/decks', icon: '📚', label: 'Decks' },
  { key: 'competitivo', href: '#/competitivo', icon: '🏆', label: 'Competitivo' },
];
const initials = (u) => {
  const [a = '', b = ''] = (u.first_name ? [u.first_name, u.last_name || ''] : String(u.display_name || u.username || '?').split(' '));
  return ((a[0] || '?') + (b[0] || '')).toUpperCase();
};
const sellMenu = (cls = '') => `
  <div class="menu ${cls}">
    <button type="button" class="btn primary small" data-menu aria-haspopup="true" aria-expanded="false">＋ Vender</button>
    <div class="menu-pop" role="menu">
      <a role="menuitem" href="#/vender"><span>🃏</span><div><b>Una carta</b><small>Pokémon o Yu-Gi-Oh!</small></div></a>
      <a role="menuitem" href="#/vender-accesorio"><span>🎒</span><div><b>Un accesorio</b><small>Micas, deck box, tapetes…</small></div></a>
    </div>
  </div>`;

function renderNav() {
  const u = currentUser;
  const links = SECTIONS_NAV.map(s => `<a class="nav-link" data-sec="${s.key}" href="${s.href}">${s.label}</a>`).join('');
  $nav.innerHTML = `
    <div class="nav-links">${links}</div>
    <div class="nav-right">
      ${u ? `${sellMenu('only-desktop')}
        <div class="menu">
          <button type="button" class="account-btn" data-menu aria-haspopup="true" aria-expanded="false" aria-label="Mi cuenta">
            <span class="avatar">${esc(initials(u))}</span><span class="account-name">${esc(u.first_name || u.username)}</span><span class="caret">▾</span>
          </button>
          <div class="menu-pop right" role="menu">
            <div class="menu-head"><b>${esc(u.display_name)}</b><small>@${esc(u.username)}</small></div>
            <a role="menuitem" href="#/mis-cartas"><span>🏷️</span><div><b>Mis publicaciones</b></div></a>
            <a role="menuitem" href="#/decks"><span>📚</span><div><b>Mis decks</b></div></a>
            <a role="menuitem" href="#/partidas"><span>📝</span><div><b>Mis partidas</b></div></a>
            <a role="menuitem" href="#/torneos"><span>⚔️</span><div><b>Torneos locales</b></div></a>
            <a role="menuitem" href="#/perfil"><span>👤</span><div><b>Mi perfil</b></div></a>
            ${u.is_admin ? '<a role="menuitem" href="#/admin"><span>🛡️</span><div><b>Administración</b></div></a>' : ''}
            <button type="button" role="menuitem" id="logout"><span>🚪</span><div><b>Cerrar sesión</b></div></button>
          </div>
        </div>`
      : `<a class="btn small ghost" href="#/login">Entrar</a><a class="btn primary small" href="#/registro">Crear cuenta</a>`}
    </div>`;

  // Barra inferior (celular): secciones + botón central para vender
  const tab = (s) => `<a class="tab-item" data-sec="${s.key}" href="${s.href}"><span class="ti-icon">${s.icon}</span><span>${s.label}</span></a>`;
  document.getElementById('tabbar').innerHTML = `
    ${tab(SECTIONS_NAV[0])}${tab(SECTIONS_NAV[1])}
    <div class="menu up tab-sell">
      <button type="button" class="sell-fab" data-menu aria-haspopup="true" aria-expanded="false" aria-label="Vender"><span>＋</span></button>
      <div class="menu-pop" role="menu">
        <a role="menuitem" href="#/vender"><span>🃏</span><div><b>Vender una carta</b></div></a>
        <a role="menuitem" href="#/vender-accesorio"><span>🎒</span><div><b>Vender un accesorio</b></div></a>
      </div>
    </div>
    ${tab(SECTIONS_NAV[2])}${tab(SECTIONS_NAV[3])}`;

  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    currentUser = null; renderNav(); refreshMatchBanner(); toast('Sesión cerrada'); go('#/');
  });
  markActiveNav();
}

// Resalta la sección actual en las dos barras
function markActiveNav() {
  const first = location.hash.slice(2).split(/[/?]/)[0];
  const sec = ['carta', 'vendedor'].includes(first) ? '' : ['torneo', 'torneos', 'partidas'].includes(first) ? 'competitivo' : first;
  document.querySelectorAll('[data-sec]').forEach(a => a.classList.toggle('active', a.dataset.sec === sec));
}

// Menús desplegables (Vender, Mi cuenta): se abren con clic y se cierran al elegir, al tocar fuera o con Esc
function closeMenus(except) {
  document.querySelectorAll('.menu.open').forEach(m => {
    if (m === except) return;
    m.classList.remove('open'); m.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-menu]');
  if (btn) {
    const menu = btn.closest('.menu');
    const open = !menu.classList.contains('open');
    closeMenus(menu);
    menu.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open));
    return;
  }
  if (e.target.closest('.menu-pop a, .menu-pop button') || !e.target.closest('.menu')) closeMenus();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
window.addEventListener('hashchange', () => { closeMenus(); markActiveNav(); });

function cardTile(l, { showSeller = true } = {}) {
  const img = coverImg(l);
  const acc = isAcc(l);
  const cat = ACC_CATEGORIES[l.category];
  return `
    <a class="card ${acc ? 'acc' : ''}" href="#/carta/${l.id}">
      <div class="card-img">${img ? `<img src="${esc(img)}" alt="${esc(l.card_name)}" loading="lazy">`
                                  : `<span class="placeholder">${acc ? cat?.icon || '✨' : '✦'}</span>`}
        ${l.photo_count ? `<span class="photo-badge" title="Fotos reales del vendedor">📷 ${l.photo_count}</span>` : ''}</div>
      <div class="card-body">
        <div class="tile-badges">${acc ? `<span class="badge acc-cat">${esc(cat?.label || 'Accesorio')}</span>` : `<span class="badge ${l.game}">${GAME_LABEL[l.game] || ''}</span>`}
             <span class="badge cond" title="${esc(acc ? condLabel(l) : CONDITIONS[l.condition])}">${esc(acc ? condLabel(l) : l.condition)}</span></div>
        <div class="card-name" title="${esc(l.card_name)}">${esc(l.card_name)}</div>
        <div class="card-meta one-line">${esc((acc ? [l.set_name || ACC_GAMES[l.game]] : [l.set_name, l.card_code]).filter(Boolean).join(' · ')) || '&nbsp;'}</div>
        <div class="card-foot">
          <span class="price">${money(l.price)}</span>
          ${l.quantity > 1 ? `<span class="qty-pill" title="Disponibles">×${l.quantity}</span>` : ''}
        </div>
        <div class="tile-market">${l.market_price_mxn ? marketCompare(l.price, l.market_price_mxn) : ""}</div>
        ${showSeller ? `<div class="tile-seller one-line">@${esc(l.username)}${l.location ? ' · 📍 ' + esc(l.location) : ''}</div>` : ''}
      </div>
    </a>`;
}

// ---------- Vistas ----------

async function viewCatalog(params) {
  const game = params.get('game') || '';
  const q = params.get('q') || '';
  const set = params.get('set') || '';
  const sort = params.get('sort') || '';

  const qs = new URLSearchParams({ game, q, set, sort });
  const [{ listings }, stats, { sets }] = await Promise.all([
    api(`/api/listings?${qs}`), api('/api/stats'), api(`/api/listings/sets?${new URLSearchParams({ game })}`),
  ]);
  // Si la expansión elegida ya no tiene cartas, se sigue mostrando en la lista para poder quitarla
  if (set && !sets.some(s => s.name.toLowerCase() === set.toLowerCase())) sets.unshift({ name: set, count: 0 });
  const g = Object.fromEntries(stats.byGame.map(r => [r.game, r]));
  const pk = g.pokemon?.cards ?? 0, yg = g.yugioh?.cards ?? 0;
  const pct = (n) => (pk + yg ? Math.round((n / (pk + yg)) * 100) : 0);

  // Hasta tres cartas reales flotando en la portada (o dorsos decorativos si aún no hay)
  const showcase = listings.filter(coverImg).slice(0, 3);
  const floaters = [0, 1, 2].map(i => showcase[i]
    ? `<a class="floater f${i}" href="#/carta/${showcase[i].id}"><img src="${esc(coverImg(showcase[i]))}" alt="${esc(showcase[i].card_name)}"></a>`
    : `<div class="floater f${i} back"><span>✦</span></div>`).join('');

  // Con sesión iniciada la portada es más baja y muestra accesos rápidos; sin sesión, la portada completa
  const u = currentUser;
  $app.innerHTML = `
    <section class="scene ${u ? 'compact' : ''}">
      ${sceneSVG()}
      <div class="scene-content">
        <div class="hero-copy">
          ${u ? `
          <span class="kicker">✦ Hola, ${esc(u.first_name || u.username)} ✦</span>
          <h1>¿Qué carta buscas <span class="grad">hoy?</span></h1>
          <div class="quick-actions">
            <a class="qa" href="#/vender"><span>🃏</span>Vender carta</a>
            <a class="qa" href="#/decks/nuevo"><span>📚</span>Armar deck</a>
            <a class="qa" href="#/mis-cartas"><span>🏷️</span>Mis ventas</a>
            <a class="qa" href="#/torneos"><span>⚔️</span>Torneos</a>
          </div>` : `
          <span class="kicker">✦ Pokémon · Yu-Gi-Oh! ✦</span>
          <h1>Cada carta tiene una historia.<br><span class="grad">Encuentra la tuya.</span></h1>
          <p>El mercado donde los coleccionistas del reino intercambian sus tesoros. Fotos reales, precios de referencia y vendedores de tu zona.</p>
          <div class="hero-cta">
            <a class="btn primary big" href="#catalogo" id="exploreBtn">Explorar cartas</a>
            <a class="btn ghost big" href="#/registro">Crear cuenta gratis</a>
          </div>`}
          <div class="stats">
            <div class="stat"><b>${pk}</b><span>cartas Pokémon</span></div>
            <div class="stat"><b>${yg}</b><span>cartas Yu-Gi-Oh!</span></div>
            <div class="stat"><b>${stats.sellers}</b><span>vendedores</span></div>
          </div>
        </div>
        <div class="floaters" aria-hidden="true">${floaters}</div>
      </div>
    </section>
    <div class="section-head" id="catalogo">
      <h2>Cartas en circulación</h2>
      <span class="muted">${listings.length} ${listings.length === 1 ? 'resultado' : 'resultados'}</span>
    </div>
    <div class="catalog-bar">
    <div class="tabs">
      ${[['', 'Todas'], ['pokemon', 'Pokémon'], ['yugioh', 'Yu-Gi-Oh!']].map(([v, t]) =>
        `<button class="tab ${game === v ? 'active' : ''}" data-game="${v}">${t}</button>`).join('')}
      <a class="tab tab-link" href="#/accesorios">🎒 Accesorios</a>
    </div>
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Buscar por nombre, expansión o código…" value="${esc(q)}">
      <select name="set" aria-label="Expansión">
        <option value="">Expansiones</option>
        ${sets.map(s => `<option value="${esc(s.name)}" ${set.toLowerCase() === s.name.toLowerCase() ? 'selected' : ''}>${esc(s.name)} (${s.count})</option>`).join('')}
      </select>
      <select name="sort">
        ${[['', 'Más recientes'], ['price_asc', 'Precio: menor a mayor'], ['price_desc', 'Precio: mayor a menor'], ['name', 'Nombre A-Z']]
          .map(([v, t]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </form>
    </div>
    ${listings.length
      ? `<div class="grid">${listings.map(l => cardTile(l)).join('')}</div>`
      : `<div class="empty">No hay cartas que coincidan.${currentUser ? ' <a href="#/vender">¡Publica la primera!</a>'
                                                                     : ' <a href="#/registro">Crea una cuenta</a> para vender.'}</div>`}
  `;

  const update = (patch) => {
    const next = new URLSearchParams({ game, ...formData(document.getElementById('filters')), ...patch });
    for (const [k, v] of [...next]) if (!v) next.delete(k);
    go(`#/?${next}`);
  };
  // Al cambiar de juego se quita la expansión (las de Pokémon no existen en Yu-Gi-Oh! y viceversa)
  $app.querySelectorAll('.tab[data-game]').forEach(b => b.addEventListener('click', () => update({ game: b.dataset.game, set: '' })));
  const form = document.getElementById('filters');
  form.addEventListener('submit', e => { e.preventDefault(); update({}); });
  form.querySelectorAll('select').forEach(s => s.addEventListener('change', () => update({})));
  form.q.addEventListener('search', () => update({})); // al pulsar la X de limpiar
  document.getElementById('exploreBtn')?.addEventListener('click', e => {
    e.preventDefault(); document.getElementById('catalogo').scrollIntoView({ behavior: 'smooth' });
  });
}

// Tienda de accesorios: micas, deck box, tapetes, carpetas… (filtros por categoría, juego, búsqueda y orden)
async function viewAccessories(params) {
  const category = params.get('category') || '';
  const game = params.get('game') || '';
  const q = params.get('q') || '';
  const sort = params.get('sort') || '';
  const { listings } = await api(`/api/listings?${new URLSearchParams({ kind: 'accessory', category, game, q, sort })}`);

  $app.innerHTML = `
    <div class="acc-hero">
      <div>
        <span class="kicker">🎒 Accesorios TCG</span>
        <h1>La armería del coleccionista</h1>
        <p class="muted">Micas, deck boxes, tapetes, carpetas y todo lo que protege tus cartas. Compra y vende con otros jugadores de tu zona.</p>
      </div>
      <a class="btn primary" href="${currentUser ? '#/vender-accesorio' : '#/registro'}">${currentUser ? '+ Vender accesorio' : 'Crea tu cuenta para vender'}</a>
    </div>
    <div class="chips scroll" id="accCats">
      <button class="chip ${!category ? 'active' : ''}" data-cat="">Todos</button>
      ${Object.entries(ACC_CATEGORIES).map(([k, c]) => `<button class="chip ${category === k ? 'active' : ''}" data-cat="${k}">${c.icon} ${c.label}</button>`).join('')}
    </div>
    <div class="section-head">
      <div class="tabs">
        ${[['', 'Todos'], ['pokemon', 'Pokémon'], ['yugioh', 'Yu-Gi-Oh!'], ['any', 'Universal']].map(([v, t]) =>
          `<button class="tab ${game === v ? 'active' : ''}" data-game="${v}">${t}</button>`).join('')}
      </div>
      <span class="muted">${listings.length} ${listings.length === 1 ? 'accesorio' : 'accesorios'}</span>
    </div>
    <form class="filters acc-filters" id="filters">
      <input name="q" type="search" placeholder="Buscar por nombre o marca…" value="${esc(q)}">
      <select name="sort">
        ${[['', 'Más recientes'], ['price_asc', 'Precio: menor a mayor'], ['price_desc', 'Precio: mayor a menor'], ['name', 'Nombre A-Z']]
          .map(([v, t]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </form>
    ${listings.length
      ? `<div class="grid">${listings.map(l => cardTile(l)).join('')}</div>`
      : `<div class="empty">Todavía no hay accesorios${category ? ` en ${esc(ACC_CATEGORIES[category]?.label || '')}` : ''}.${currentUser
          ? ' <a href="#/vender-accesorio">¡Publica el primero!</a>' : ' <a href="#/registro">Crea una cuenta</a> para vender.'}</div>`}`;

  const update = (patch) => {
    const next = new URLSearchParams({ category, game, ...formData(document.getElementById('filters')), ...patch });
    for (const [k, v] of [...next]) if (!v) next.delete(k);
    go(`#/accesorios${next.toString() ? `?${next}` : ''}`);
  };
  $app.querySelectorAll('#accCats .chip').forEach(b => b.addEventListener('click', () => update({ category: b.dataset.cat })));
  $app.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => update({ game: b.dataset.game })));
  const form = document.getElementById('filters');
  form.addEventListener('submit', e => { e.preventDefault(); update({}); });
  form.sort.addEventListener('change', () => update({}));
  form.q.addEventListener('search', () => update({}));
}

async function viewListing(id) {
  const { listing: l } = await api(`/api/listings/${id}`);
  const mine = currentUser?.id === l.user_id;
  // Galería: primero las fotos reales del vendedor, al final la imagen oficial como referencia
  const gallery = [
    ...l.photos.map((p, i) => ({ url: p.url, label: `Foto real ${i + 1} de ${l.photos.length}`, real: true })),
    ...(safeImg(l.image_url) ? [{ url: l.image_url, label: 'Imagen oficial de referencia', real: false }] : []),
  ];
  const first = gallery[0];
  const acc = isAcc(l);
  const cat = ACC_CATEGORIES[l.category];
  $app.innerHTML = `
    <p>${acc ? '<a href="#/accesorios">← Volver a accesorios</a>' : '<a href="#/">← Volver al catálogo</a>'}</p>
    <div class="detail ${acc ? 'acc' : ''}">
      <div>
        <div class="gallery-main">
          ${first ? `<img id="mainImg" src="${esc(first.url)}" alt="${esc(l.card_name)}">` : `<span class="placeholder">${acc ? cat?.icon || '✨' : '✦'}</span>`}
          ${first ? `<span class="gallery-label ${first.real ? 'real' : ''}" id="mainLabel">${esc(first.label)}</span>
                     <span class="zoom-hint" aria-hidden="true">🔍 Ampliar</span>` : ''}
        </div>
        ${gallery.length > 1 ? `<div class="thumbs">${gallery.map((g, i) => `
          <button type="button" class="thumb ${i === 0 ? 'active' : ''}" data-i="${i}" title="${esc(g.label)}">
            <img src="${esc(g.url)}" alt="" loading="lazy"><span>${g.real ? '📷' : 'Oficial'}</span>
          </button>`).join('')}</div>` : ''}
        ${l.photos.length ? `<p class="card-meta">📷 ${l.photos.length} foto(s) real(es) subidas por el vendedor.</p>`
          : acc ? '<p class="card-meta">El vendedor no subió fotos (son opcionales en accesorios de bajo valor); pídeselas si las necesitas.</p>'
          : '<p class="card-meta">Sin fotos reales: en cartas de bajo valor son opcionales. La imagen es la oficial de referencia; pide fotos al vendedor si las necesitas.</p>'}
      </div>
      <div>
        ${acc ? `<span class="badge acc-cat">${cat?.icon || ''} ${esc(cat?.label || 'Accesorio')}</span>` : ''}
        <span class="badge ${l.game}">${GAME_LABEL[l.game] || ''}</span>
        ${l.status === 'sold' ? `<span class="badge sold">${acc ? 'Vendido' : 'Vendida'}</span>` : ''}
        <h1>${esc(l.card_name)}</h1>
        <div class="price" style="font-size:1.8rem">${money(l.price)}</div>
        ${l.market_price_mxn ? `
          <div class="market-box">
            <div><span class="muted">Precio estimado de mercado</span> <b>${money(l.market_price_mxn)}</b> ${marketCompare(l.price, l.market_price_mxn)}</div>
            <div class="card-meta">${esc(l.market_source)}: ${usd(l.market_price_usd)} (consultado el ${new Date(l.market_updated).toLocaleDateString('es-MX')}),
              convertido con ${fxNote(l.fx)}. Es una referencia, no un precio garantizado.</div>
          </div>` : ''}
        <dl class="specs">${acc ? `
          <dt>Categoría</dt><dd>${esc(cat?.label || '—')}</dd>
          <dt>Marca</dt><dd>${esc(l.set_name) || '—'}</dd>
          <dt>Para</dt><dd>${esc(ACC_GAMES[l.game] || '—')}</dd>
          <dt>Estado</dt><dd>${esc(condLabel(l))}</dd>` : `
          <dt>Expansión</dt><dd>${esc(l.set_name) || '—'}</dd>
          <dt>Código</dt><dd>${esc(l.card_code) || '—'}</dd>
          <dt>Rareza</dt><dd>${esc(l.rarity) || '—'}</dd>
          <dt>Estado</dt><dd>${esc(l.condition)} — ${esc(CONDITIONS[l.condition])}</dd>
          <dt>Idioma</dt><dd>${esc(l.language)}</dd>`}
          <dt>Disponibles</dt><dd>${l.quantity}</dd>
          <dt>Publicada</dt><dd>${fmtDay(l.created_at)}</dd>
        </dl>
        ${l.notes ? `<p>${esc(l.notes).replace(/\n/g, '<br>')}</p>` : ''}
        <div class="panel seller-box">
          <div class="muted">Vendedor</div>
          <div><a href="#/vendedor/${encodeURIComponent(l.username)}"><b>${esc(l.display_name)}</b> @${esc(l.username)}</a></div>
          ${l.location ? `<div class="muted">📍 ${esc(l.location)}</div>` : ''}
          ${l.contact ? `<div>Contacto: ${esc(l.contact)}</div>${contactButtons(l.contact, l.card_name)}` : '<div class="muted">El vendedor no ha dejado un contacto.</div>'}
        </div>
        ${!mine && l.status !== 'sold' && contactButtons(l.contact || '', l.card_name) ? `
          <div class="buy-bar">
            <div><span class="price">${money(l.price)}</span><small>${esc(l.display_name || '@' + l.username)}</small></div>
            ${contactButtons(l.contact, l.card_name).replace('<div class="contact-btns">', '<div class="contact-btns compact">')}
          </div>` : ''}
        ${mine ? `<p style="margin-top:1rem"><a class="btn" href="#/editar/${l.id}">Editar mi publicación</a></p>`
          : currentUser?.is_admin ? `
          <div class="admin-note" style="margin-top:1rem">🛡 Administración
            ${l.seller_blocked ? '<span class="badge sold">Cuenta suspendida: no se ve en el catálogo</span>' : ''}
            <div class="t-actions" style="margin-top:.5rem">
              <a class="btn small" href="#/editar/${l.id}">Editar</a>
              <button class="btn small" id="admToggle">${l.status === 'sold' ? 'Reactivar' : 'Marcar vendida'}</button>
              <button class="btn small danger" id="admDelete">Borrar</button>
            </div>
          </div>` : ''}
      </div>
    </div>`;

  let current = 0;
  const show = (i) => {
    current = i;
    const g = gallery[i];
    document.getElementById('mainImg').src = g.url;
    const label = document.getElementById('mainLabel');
    label.textContent = g.label; label.classList.toggle('real', g.real);
    $app.querySelectorAll('.thumb').forEach(x => x.classList.toggle('active', Number(x.dataset.i) === i));
  };
  $app.querySelectorAll('.thumb').forEach(b => b.addEventListener('click', () => show(Number(b.dataset.i))));
  // Tocar la foto la abre a pantalla completa (con zoom); al cerrar, la galería queda en la última foto vista
  document.querySelector('.gallery-main')?.addEventListener('click', () => {
    if (gallery.length) openLightbox(gallery, current, show);
  });
  document.getElementById('admToggle')?.addEventListener('click', async () => {
    await api(`/api/listings/${l.id}/status`, { method: 'PATCH', body: { status: l.status === 'sold' ? 'available' : 'sold' } });
    toast('Publicación actualizada'); viewListing(l.id);
  });
  document.getElementById('admDelete')?.addEventListener('click', async () => {
    if (!confirm(`¿Borrar la publicación "${l.card_name}" de @${l.username}? No se puede deshacer.`)) return;
    await api(`/api/listings/${l.id}`, { method: 'DELETE' });
    toast('Publicación borrada'); go('#/admin?tab=listings');
  });
}

// ---------- Visor de fotos a pantalla completa ----------
// items: [{ url, label, real }]. Tocar/clic = acercar ahí (o alejar); arrastrar = mover la foto ampliada;
// rueda del ratón o pellizco = zoom; deslizar o flechas = foto anterior/siguiente; Esc, ✕ o fondo = cerrar.
function openLightbox(items, startIndex = 0, onChange = () => {}) {
  let i = startIndex, scale = 1, tx = 0, ty = 0;
  const MAX = 4;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = `
    <div class="lb-stage"><img class="lb-img" alt="" draggable="false"></div>
    <button type="button" class="lb-btn lb-close" aria-label="Cerrar">✕</button>
    ${items.length > 1 ? `<button type="button" class="lb-btn lb-prev" aria-label="Foto anterior">‹</button>
                          <button type="button" class="lb-btn lb-next" aria-label="Foto siguiente">›</button>` : ''}
    <div class="lb-caption"><span class="lb-label"></span><span class="lb-count"></span>
      <span class="lb-tip">Toca para acercar · arrastra para mover</span></div>`;
  document.body.appendChild(box);
  document.body.classList.add('lb-open');
  const img = box.querySelector('.lb-img'), stage = box.querySelector('.lb-stage');

  const apply = (animate = true) => {
    img.style.transition = animate ? 'transform .25s ease' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    box.classList.toggle('zoomed', scale > 1);
  };
  // Evita que la foto ampliada se salga de la pantalla al moverla
  const clamp = () => {
    const w = img.offsetWidth * scale, h = img.offsetHeight * scale;
    const mx = Math.max(0, (w - stage.clientWidth) / 2), my = Math.max(0, (h - stage.clientHeight) / 2);
    tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
  };
  // Zoom manteniendo fijo el punto (cx, cy) de la pantalla
  const zoomAt = (next, cx, cy, animate = true) => {
    next = Math.min(MAX, Math.max(1, next));
    const r = stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    tx = px - (px - tx) * (next / scale); ty = py - (py - ty) * (next / scale);
    scale = next;
    if (scale === 1) { tx = 0; ty = 0; }
    clamp(); apply(animate);
  };
  const go = (n) => {
    if (items.length < 2) return;
    i = (n + items.length) % items.length;
    scale = 1; tx = 0; ty = 0;
    render(); onChange(i);
  };
  const render = () => {
    const it = items[i];
    img.src = it.url; img.alt = it.label;
    box.querySelector('.lb-label').textContent = it.label;
    box.querySelector('.lb-label').classList.toggle('real', !!it.real);
    box.querySelector('.lb-count').textContent = items.length > 1 ? `${i + 1} / ${items.length}` : '';
    apply(false);
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    document.body.classList.remove('lb-open');
    box.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowRight') go(i + 1);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-prev')?.addEventListener('click', () => go(i - 1));
  box.querySelector('.lb-next')?.addEventListener('click', () => go(i + 1));

  // Gestos con punteros (ratón, dedo o lápiz): toque, arrastre, deslizar y pellizco
  const pts = new Map();
  let start = null, pinch = null, moved = false;
  stage.addEventListener('pointerdown', (e) => {
    try { stage.setPointerCapture(e.pointerId); } catch { /* sin captura el gesto sigue funcionando */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) start = { x: e.clientX, y: e.clientY, tx, ty, t: Date.now() };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      moved = true;
      zoomAt(pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2, false);
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    if (scale > 1) { tx = start.tx + dx; ty = start.ty + dy; clamp(); apply(false); }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size > 0 || !start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    const s = start; start = null;
    if (e.type === 'pointercancel') return;
    if (!moved) {
      // Toque sin moverse: sobre la foto acerca/aleja; fuera de la foto (sin zoom) cierra
      // (con la captura del puntero el evento llega al escenario, así que se mira si el punto cae sobre la foto)
      // (se calcula con el zoom actual, no con getBoundingClientRect, que durante la animación aún da el tamaño anterior)
      const sr = stage.getBoundingClientRect();
      const halfW = img.offsetWidth * scale / 2, halfH = img.offsetHeight * scale / 2;
      const cx = sr.left + sr.width / 2 + tx, cy = sr.top + sr.height / 2 + ty;
      const onImg = Math.abs(e.clientX - cx) <= halfW && Math.abs(e.clientY - cy) <= halfH;
      if (onImg) zoomAt(scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
      else if (scale > 1) zoomAt(1, e.clientX, e.clientY);
      else close();
    } else if (scale === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && Date.now() - s.t < 600) {
      go(dx < 0 ? i + 1 : i - 1);   // deslizar sin zoom: cambiar de foto
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(scale * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX, e.clientY, false);
  }, { passive: false });

  render();
  box.querySelector('.lb-close').focus();
}

async function viewSeller(username) {
  const { user, listings, decks } = await api(`/api/users/${encodeURIComponent(username)}`);
  $app.innerHTML = `
    <p><a href="#/">← Volver al catálogo</a></p>
    <h1>${esc(user.display_name)} <span class="muted">@${esc(user.username)}</span></h1>
    <p class="muted">${user.location ? '📍 ' + esc(user.location) + ' · ' : ''}Miembro desde ${fmtDay(user.created_at)}
      ${user.contact ? ' · Contacto: ' + esc(user.contact) : ''}</p>
    <h2>${listings.length} carta(s) a la venta</h2>
    ${listings.length ? `<div class="grid">${listings.map(l => cardTile(l, { showSeller: false })).join('')}</div>`
                      : '<div class="empty">Este usuario no tiene cartas a la venta.</div>'}
    ${decks?.length ? `<h2 style="margin-top:2rem">Decks públicos</h2><div class="deck-grid">${decks.map(deckTile).join('')}</div>` : ''}`;
}

// Campos de perfil obligatorios (registro y "Mi perfil"): nombre, apellidos, zona y teléfono
function profileFields(u) {
  // Cuentas antiguas solo tienen el nombre completo: se reparte entre los dos campos
  const [first = '', ...rest] = (u.first_name ? [] : (u.display_name || '').split(' '));
  const firstName = u.first_name || first;
  const lastName = u.last_name || rest.join(' ');
  return `
    <div class="row">
      <div class="field"><label>Nombre</label>
        <input name="first_name" required minlength="2" maxlength="40" autocomplete="given-name" value="${esc(firstName)}" placeholder="ej. Ash"></div>
      <div class="field"><label>Apellidos</label>
        <input name="last_name" required minlength="2" maxlength="60" autocomplete="family-name" value="${esc(lastName)}" placeholder="ej. Ketchum"></div>
    </div>
    <div class="row">
      <div class="field"><label>Ciudad / zona</label>
        <input name="location" required minlength="2" maxlength="80" value="${esc(u.location)}" placeholder="ej. Ciudad de México"></div>
      <div class="field"><label>Contacto</label>
        <input name="contact" type="tel" required maxlength="30" autocomplete="tel" inputmode="tel"
               pattern="\\+?[0-9\\s\\(\\)\\.\\-]{8,25}" title="Número de teléfono: 8 a 15 dígitos, puede empezar con +"
               value="${esc(u.contact)}" placeholder="Número de teléfono"></div>
    </div>`;
}

function viewRegister() {
  $app.innerHTML = `
    <div class="panel auth">
      <h1>Crear cuenta</h1>
      <p class="muted">Regístrate para publicar las cartas que vendes.</p>
      <form id="f">
        <div class="field"><label>Usuario</label><input name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_]+" autocomplete="username" placeholder="ej. ash_ketchum"></div>
        ${profileFields({})}
        <div class="field"><label>Correo electrónico</label><input name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label>Contraseña (mín. 8 caracteres)</label><input name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="error" id="err"></div>
        <button class="btn primary" style="width:100%">Crear cuenta</button>
      </form>
      <p class="muted">¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a></p>
    </div>`;
  bindAuthForm('/api/auth/register', '¡Cuenta creada! Bienvenido/a');
}

function viewLogin() {
  $app.innerHTML = `
    <div class="panel auth">
      <h1>Iniciar sesión</h1>
      <form id="f">
        <div class="field"><label>Usuario o correo</label><input name="login" required autocomplete="username"></div>
        <div class="field"><label>Contraseña</label><input name="password" type="password" required autocomplete="current-password"></div>
        <div class="error" id="err"></div>
        <button class="btn primary" style="width:100%">Entrar</button>
      </form>
      <p class="muted">¿No tienes cuenta? <a href="#/registro">Créala aquí</a></p>
    </div>`;
  bindAuthForm('/api/auth/login', 'Sesión iniciada');
}

function bindAuthForm(endpoint, okMsg) {
  const f = document.getElementById('f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const { user } = await api(endpoint, { method: 'POST', body: formData(f) });
      currentUser = user; renderNav(); toast(okMsg); go('#/mis-cartas');
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    } finally { btn.disabled = false; }
  });
}

async function viewMine(params = new URLSearchParams()) {
  if (!requireLogin()) return;
  const { listings: all } = await api('/api/listings/mine');
  // Filtro por estado de venta (pestañas con conteo)
  const show = ['available', 'sold'].includes(params.get('estado')) ? params.get('estado') : '';
  const listings = show ? all.filter(l => l.status === show) : all;
  const nAvail = all.filter(l => l.status !== 'sold').length, nSold = all.length - nAvail;
  const stTab = (v, t, n) => `<a class="tab ${show === v ? 'active' : ''}" href="#/mis-cartas${v ? '?estado=' + v : ''}">${t} <span class="tab-n">${n}</span></a>`;
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>Mis publicaciones</h1><p class="muted">Administra las cartas y accesorios que tienes a la venta.</p></div>
      <div class="t-actions"><a class="btn" href="#/vender-accesorio">+ Vender accesorio</a><a class="btn primary" href="#/vender">+ Vender carta</a></div>
    </div>
    ${all.length ? `<div class="tabs status-tabs">${stTab('', 'Todas', all.length)}${stTab('available', 'Disponibles', nAvail)}${stTab('sold', 'Vendidas', nSold)}</div>` : ''}
    ${listings.length ? `
      <div class="panel" style="overflow-x:auto">
        <table class="mine">
          <thead><tr><th></th><th>Publicación</th><th>Juego</th><th>Estado</th><th>Precio</th><th>Cant.</th><th>Venta</th><th></th></tr></thead>
          <tbody>${listings.map(l => `
            <tr>
              <td>${coverImg(l) ? `<img src="${esc(coverImg(l))}" alt="" loading="lazy">` : ''}</td>
              <td><a href="#/carta/${l.id}">${esc(l.card_name)}</a><div class="card-meta">${isAcc(l) ? `${ACC_CATEGORIES[l.category]?.icon || ''} ${esc(ACC_CATEGORIES[l.category]?.label || 'Accesorio')}${l.set_name ? ' · ' + esc(l.set_name) : ''}` : esc([l.set_name, l.card_code].filter(Boolean).join(' · '))}</div></td>
              <td><span class="badge ${l.game}">${GAME_LABEL[l.game] || ''}</span></td>
              <td>${esc(condLabel(l))}</td>
              <td class="price">${money(l.price)}</td>
              <td>${l.quantity}</td>
              <td>${l.status === 'sold' ? '<span class="badge sold">Vendida</span>' : '<span class="badge cond">Disponible</span>'}</td>
              <td class="actions">
                <a class="btn small" href="#/editar/${l.id}">Editar</a>
                <button class="btn small" data-toggle="${l.id}">${l.status === 'sold' ? 'Reactivar' : 'Marcar vendida'}</button>
                <button class="btn small danger" data-del="${l.id}">Borrar</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : all.length ? `<div class="empty small">No hay publicaciones en esta pestaña.</div>` : `<div class="empty">Aún no tienes publicaciones. <a href="#/vender">Vende una carta</a> o <a href="#/vender-accesorio">un accesorio</a>.</div>`}`;

  $app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('¿Borrar esta publicación? No se puede deshacer.')) return;
    await api(`/api/listings/${b.dataset.del}`, { method: 'DELETE' });
    toast('Publicación borrada'); viewMine(new URLSearchParams(location.hash.split('?')[1] || ''));
  }));
  $app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const l = listings.find(x => String(x.id) === b.dataset.toggle);
    await api(`/api/listings/${l.id}/status`, { method: 'PATCH', body: { status: l.status === 'sold' ? 'available' : 'sold' } });
    toast('Publicación actualizada'); viewMine(new URLSearchParams(location.hash.split('?')[1] || ''));
  }));
}

// Selector de fotos reales (formularios de cartas y de accesorios): pinta #photoGrid y usa #photoInput
function setupPhotos(initial = [], onChange = () => {}) {
  const keep = initial.map(p => ({ ...p }));
  const added = []; // data URLs comprimidas en el navegador
  const input = document.getElementById('photoInput');
  function render() {
    const total = keep.length + added.length;
    document.getElementById('photoGrid').innerHTML = `
      ${keep.map((p, i) => `<div class="photo"><img src="${esc(p.url)}" alt=""><button type="button" data-keep="${i}" title="Quitar">✕</button></div>`).join('')}
      ${added.map((p, i) => `<div class="photo"><img src="${p}" alt=""><button type="button" data-new="${i}" title="Quitar">✕</button></div>`).join('')}
      ${total < MAX_PHOTOS ? `<button type="button" class="photo add" id="addPhoto">＋<span>${total ? 'Añadir otra' : 'Subir fotos'}</span></button>` : ''}`;
    document.getElementById('addPhoto')?.addEventListener('click', () => input.click());
    document.querySelectorAll('[data-keep]').forEach(b => b.addEventListener('click', () => { keep.splice(b.dataset.keep, 1); render(); }));
    document.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => { added.splice(b.dataset.new, 1); render(); }));
    onChange();
  }
  input.addEventListener('change', async () => {
    const files = [...input.files].slice(0, MAX_PHOTOS - keep.length - added.length);
    input.value = '';
    for (const file of files) {
      try { added.push(await compressImage(file)); }
      catch { toast(`No se pudo leer ${file.name}`); }
    }
    render();
  });
  render();
  return { count: () => keep.length + added.length, added: () => added, keepIds: () => keep.map(p => p.id),
           first: () => keep[0]?.url || added[0] || '' };
}

// Formulario de accesorio: nombre, categoría, marca, para qué juego, estado, precio y fotos
function renderAccessoryForm(l, id, fxInfo) {
  const PHOTO_MIN_USD = fxInfo.photos?.min_usd ?? 2.5;
  const usdRate = fxInfo.fx?.rate || fxInfo.photos?.fallback_rate || 17;
  const game = l.game || 'any';
  $app.innerHTML = `
    <p><a href="#/accesorios">← Accesorios</a></p>
    <div class="panel form-wide">
      <h1>${id ? 'Editar accesorio' : 'Vender un accesorio'}</h1>
      <form id="f" novalidate>
        <h2 class="step">1. ¿Qué accesorio vendes?</h2>
        <div class="field"><label>Categoría</label>
          <div class="chips" id="catChips">
            ${Object.entries(ACC_CATEGORIES).map(([k, c]) => `<button type="button" class="chip ${l.category === k ? 'active' : ''}" data-cat="${k}">${c.icon} ${c.label}</button>`).join('')}
          </div>
          <input type="hidden" name="category" value="${esc(l.category || '')}">
        </div>
        <div class="field"><label>Nombre</label>
          <input name="card_name" required maxlength="120" value="${esc(l.card_name)}" placeholder="ej. Micas Dragon Shield Matte (100) negras"></div>
        <div class="row">
          <div class="field"><label>Marca</label><input name="set_name" maxlength="120" value="${esc(l.set_name)}" placeholder="ej. Ultra Pro, Dragon Shield"></div>
          <div class="field"><label>Para</label><select name="game">
            ${Object.entries(ACC_GAMES).map(([k, v]) => `<option value="${k}" ${game === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select></div>
        </div>

        <h2 class="step">2. Fotos reales <span class="req" id="photoReq"></span></h2>
        <p class="card-meta" style="margin-top:-.4rem">Sube hasta ${MAX_PHOTOS} fotos del accesorio (empaque, estado, medidas). <span id="photoRule"></span></p>
        <div class="photo-grid" id="photoGrid"></div>
        <input type="file" id="photoInput" accept="image/jpeg,image/png,image/webp" multiple hidden>

        <h2 class="step">3. Estado y precio</h2>
        <div class="row">
          <div class="field"><label>Estado</label><select name="condition">
            ${Object.entries(ACC_CONDITIONS).map(([k, v]) => `<option value="${k}" ${(l.condition || 'NEW') === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select></div>
          <div class="field"><label>Precio (MXN)</label><input name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(l.price)}"></div>
          <div class="field"><label>Cantidad</label><input name="quantity" type="number" inputmode="numeric" min="0" max="999" step="1" required value="${esc(l.quantity ?? 1)}"></div>
        </div>
        <div class="field"><label>Notas para el comprador</label><textarea name="notes" rows="3" maxlength="1000" placeholder="Medidas, color, cuántas piezas, envío…">${esc(l.notes)}</textarea></div>
        <div class="error" id="err"></div>
        <div class="actions">
          <button class="btn primary" id="submitBtn">${id ? 'Guardar cambios' : 'Publicar accesorio'}</button>
          <a class="btn" href="#/accesorios">Cancelar</a>
        </div>
      </form>
    </div>`;

  const f = document.getElementById('f');
  document.querySelectorAll('#catChips .chip').forEach(b => b.addEventListener('click', () => {
    f.category.value = b.dataset.cat;
    document.querySelectorAll('#catChips .chip').forEach(x => x.classList.toggle('active', x === b));
  }));
  const photos = setupPhotos(l.photos);
  const photosNeeded = () => (Number(f.price.value) || 0) / usdRate > PHOTO_MIN_USD;
  function updatePhotoRule() {
    const need = photosNeeded();
    const req = document.getElementById('photoReq');
    req.textContent = need ? 'obligatorio' : 'opcional';
    req.classList.toggle('optional', !need);
    document.getElementById('photoRule').textContent = need
      ? `Como vale más de US$${PHOTO_MIN_USD.toFixed(2)}, necesitas al menos una foto.`
      : `Opcionales en accesorios de hasta US$${PHOTO_MIN_USD.toFixed(2)} (unos ${money(Math.round(PHOTO_MIN_USD * usdRate))}).`;
  }
  f.price.addEventListener('input', updatePhotoRule);
  updatePhotoRule();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    const body = { ...formData(f), kind: 'accessory' };
    if (!body.category) { err.textContent = 'Elige la categoría del accesorio.'; return; }
    if (!body.card_name.trim()) { err.textContent = 'Escribe el nombre del accesorio.'; return; }
    if (body.price === '' || Number(body.price) < 0) { err.textContent = 'Indica un precio válido.'; return; }
    if (photos.count() < 1 && photosNeeded()) { err.textContent = `Vale más de US$${PHOTO_MIN_USD.toFixed(2)}: sube al menos una foto real.`; return; }
    body.price = Number(body.price); body.quantity = Number(body.quantity);
    body.new_photos = photos.added();
    if (id) body.keep_photos = photos.keepIds();
    const btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = 'Subiendo…'; err.textContent = '';
    try {
      const { listing } = await api(id ? `/api/listings/${id}` : '/api/listings', { method: id ? 'PUT' : 'POST', body });
      toast(id ? 'Cambios guardados' : '¡Accesorio publicado!'); go(`#/carta/${listing.id}`);
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false; btn.textContent = id ? 'Guardar cambios' : 'Publicar accesorio';
    }
  });
}

async function viewListingForm(id, kind = 'card') {
  if (!requireLogin()) return;
  const [l, fxInfo] = await Promise.all([
    id ? api(`/api/listings/${id}`).then(r => r.listing)
       : kind === 'accessory' ? { game: 'any', condition: 'NEW', quantity: 1, price: '' }
       : { game: 'pokemon', condition: 'NM', language: 'Español', quantity: 1, price: '' },
    api('/api/fx').catch(() => ({})),
  ]);
  const othersListing = id && String(l.user_id) !== String(currentUser.id);
  if (othersListing && !currentUser.is_admin) { $app.innerHTML = '<div class="empty">Esta publicación no es tuya.</div>'; return; }
  if ((id ? l.kind : kind) === 'accessory') renderAccessoryForm(l, id, fxInfo);
  else renderCardForm(l, id, fxInfo);
  // Un administrador editando la publicación de otra persona: aviso arriba del formulario
  if (othersListing) $app.querySelector('.sell-main, .form-wide')?.insertAdjacentHTML('afterbegin',
    `<div class="admin-note">🛡 Estás editando como administrador la publicación de <b>@${esc(l.username)}</b>. Los cambios se guardan a su nombre. <a href="#/admin?tab=listings">Volver al panel</a></div>`);
}

function renderCardForm(l, id, fxInfo) {
  // Fotos obligatorias solo si la carta vale más de US$2.50 (mercado o precio del vendedor; el servidor lo vuelve a revisar)
  const PHOTO_MIN_USD = fxInfo.photos?.min_usd ?? 2.5;
  const usdRate = fxInfo.fx?.rate || fxInfo.photos?.fallback_rate || 17;

  // Estado del formulario: carta de referencia elegida y fotos
  // ref.market_price está en MXN (convertido en el servidor); ref.usd es el valor original de TCGplayer
  let ref = l.ref_id ? { ref_id: l.ref_id, image: l.image_url, market_price: l.market_price_mxn, usd: l.market_price_usd,
                         market_source: l.market_source, fx: l.fx } : null;
  // Diseño: pasos en tarjetas a la izquierda y, a la derecha (fija al bajar), la vista previa con el botón de publicar
  $app.innerHTML = `
    <p><a href="#/mis-cartas">← Mis publicaciones</a></p>
    <div class="page-head"><div>
      <h1>${id ? 'Editar carta' : 'Vender una carta'}</h1>
      <p class="muted">Elige tu carta, sube fotos y pon tu precio. Te sugerimos el precio de mercado.</p>
    </div></div>
    <form id="f" class="sell-layout" novalidate>
      <div class="sell-main">
        <section class="panel step-card">
          <div class="step-title"><span class="step-num">1</span><div><h2>¿Qué carta vendes?</h2>
            <p class="card-meta">Busca y elige tu edición exacta: llenamos los datos, la imagen oficial y el precio de mercado.</p></div></div>
          <div class="tabs" id="gameTabs">
            ${['pokemon', 'yugioh'].map(g => `<button type="button" class="tab ${l.game === g ? 'active' : ''}" data-game="${g}">${GAME_LABEL[g]}</button>`).join('')}
          </div>
          <input type="hidden" name="game" value="${esc(l.game)}">
          <div class="search-row">
            <input name="card_name" required maxlength="120" value="${esc(l.card_name)}" placeholder="ej. Charizard ex 199 · Dark Magician · LOB-EN001" autocomplete="off" aria-label="Nombre de la carta">
            <button type="button" class="btn primary" id="lookup">Buscar</button>
          </div>
          <p class="card-meta hint">Tip: agrega el número ("Pikachu 25") o el código de edición de Yu-Gi-Oh! para encontrarla más rápido.</p>
          <div class="lookup-results" id="results"></div>
          <div id="refBox"></div>
          <details class="manual" id="manual" ${!l.ref_id && (l.set_name || l.card_code) ? 'open' : ''}>
            <summary>Datos de la carta <span class="card-meta">(se llenan solos al elegirla · edítalos si hace falta)</span></summary>
            <div class="row">
              <div class="field"><label>Expansión / set</label><input name="set_name" maxlength="120" value="${esc(l.set_name)}"></div>
              <div class="field"><label>Código / número</label><input name="card_code" maxlength="40" value="${esc(l.card_code)}" placeholder="ej. 199/165 · LOB-005"></div>
              <div class="field"><label>Rareza</label><input name="rarity" maxlength="60" value="${esc(l.rarity)}"></div>
            </div>
          </details>
        </section>

        <section class="panel step-card">
          <div class="step-title"><span class="step-num">2</span><div><h2>Fotos reales <span class="req" id="photoReq"></span></h2>
            <p class="card-meta">Hasta ${MAX_PHOTOS} fotos de <b>tu</b> carta (frente y reverso, con buena luz). <span id="photoRule"></span></p></div></div>
          <div class="photo-grid" id="photoGrid"></div>
          <input type="file" id="photoInput" accept="image/jpeg,image/png,image/webp" multiple hidden>
        </section>

        <section class="panel step-card">
          <div class="step-title"><span class="step-num">3</span><div><h2>Estado y precio</h2>
            <p class="card-meta">Sé honesto con el estado: evita malos entendidos con el comprador.</p></div></div>
          <div class="field"><label>Estado</label>
            <div class="cond-picker" id="condPicker">
              ${Object.entries(CONDITIONS).map(([k, v]) => `<label class="cond-opt"><input type="radio" name="condition" value="${k}" ${l.condition === k ? 'checked' : ''}><span><b>${k}</b><small>${v}</small></span></label>`).join('')}
            </div>
          </div>
          <div class="row">
            <div class="field"><label>Precio (MXN)</label>
              <div class="price-input"><span>$</span><input name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(l.price)}" placeholder="0"></div>
              <div class="card-meta" id="priceHint"></div></div>
            <div class="field"><label>Cantidad</label><input name="quantity" type="number" inputmode="numeric" min="0" max="999" step="1" required value="${esc(l.quantity)}"></div>
            <div class="field"><label>Idioma</label><select name="language">
              ${LANGUAGES.map(x => `<option ${l.language === x ? 'selected' : ''}>${x}</option>`).join('')}
            </select></div>
          </div>
          <div class="field"><label>Notas para el comprador <span class="card-meta">(opcional)</span></label><textarea name="notes" rows="3" maxlength="1000" placeholder="Detalles, envío, intercambios…">${esc(l.notes)}</textarea></div>
        </section>
      </div>

      <aside class="sell-side">
        <div class="panel preview-panel">
          <div class="card-meta preview-label">Así se verá tu publicación</div>
          <div id="preview"></div>
          <ul class="checklist" id="checklist"></ul>
          <div class="error" id="err"></div>
          <button class="btn primary big" id="submitBtn">${id ? 'Guardar cambios' : 'Publicar carta'}</button>
          <a class="btn" href="#/mis-cartas">Cancelar</a>
        </div>
      </aside>
    </form>`;

  const f = document.getElementById('f');
  const box = document.getElementById('results');
  let photos = null;

  // Vista previa en vivo (misma tarjeta del catálogo) y lista de lo que falta
  function renderPreview() {
    const price = Number(f.price.value) || 0;
    const fake = {
      id: 'preview', kind: 'card', game: f.game.value, card_name: f.card_name.value.trim() || 'Nombre de la carta',
      set_name: f.set_name.value, card_code: f.card_code.value, condition: f.condition.value || 'NM',
      price, quantity: Number(f.quantity.value) || 1, photo_count: photos?.count() || 0,
      image_url: photos?.first() ? '' : ref?.image || '', cover_photo: photos?.first() || '',
      market_price_mxn: ref?.market_price || null, username: currentUser.username, location: currentUser.location,
    };
    document.getElementById('preview').innerHTML = cardTile(fake).replace('<a ', '<div ').replace(/<\/a>\s*$/, '</div>');
    const items = [
      [!!ref, ref ? 'Carta elegida con su imagen oficial' : 'Elige tu carta en el buscador'],
      [!photosNeeded() || photos?.count() > 0, photos?.count() ? `${photos.count()} foto(s) real(es)` : photosNeeded() ? 'Falta al menos una foto' : 'Fotos opcionales'],
      [price > 0, price > 0 ? `Precio: ${money(price)}` : 'Pon tu precio'],
    ];
    document.getElementById('checklist').innerHTML = items.map(([ok, t]) => `<li class="${ok ? 'ok' : ''}">${ok ? '✔' : '○'} ${esc(t)}</li>`).join('');
  }
  f.addEventListener('input', () => renderPreview());
  f.addEventListener('change', () => renderPreview());

  // --- Carta de referencia y precio estimado ---
  function renderRef() {
    const el = document.getElementById('refBox');
    if (!ref) { el.innerHTML = ''; renderPriceHint(); renderPreview(); return; }
    el.innerHTML = `
      <div class="ref-box">
        ${safeImg(ref.image) ? `<img src="${esc(ref.image)}" alt="">` : ''}
        <div style="flex:1">
          <div class="card-meta">Carta seleccionada · imagen oficial</div>
          <div><b>${esc(f.card_name.value)}</b></div>
          <div class="card-meta">${esc([f.set_name.value, f.card_code.value, f.rarity.value].filter(Boolean).join(' · '))}</div>
          ${ref.market_price
            ? `<div class="est">Precio estimado de mercado: <b>${money(ref.market_price)}</b></div>
               <div class="card-meta">${esc(ref.market_source || 'TCGplayer')}: ${usd(ref.usd)} · ${fxNote(ref.fx)}</div>
               <button type="button" class="btn small" id="usePrice">Usar este precio</button>`
            : ref.usd
              ? `<div class="card-meta">Precio en ${esc(ref.market_source || 'TCGplayer')}: ${usd(ref.usd)} (no se pudo obtener el tipo de cambio ahora).</div>`
              : '<div class="card-meta">No hay precio de mercado disponible para esta edición.</div>'}
          <button type="button" class="btn small" id="clearRef">Quitar selección</button>
        </div>
      </div>`;
    document.getElementById('usePrice')?.addEventListener('click', () => { f.price.value = Math.round(ref.market_price); renderPriceHint(); });
    document.getElementById('clearRef').addEventListener('click', () => { ref = null; renderRef(); });
    renderPriceHint(); renderPreview();
  }
  function renderPriceHint() {
    const hint = document.getElementById('priceHint');
    const price = Number(f.price.value);
    hint.innerHTML = ref?.market_price
      ? `Mercado: ${money(ref.market_price)}${f.price.value ? ' · ' + marketCompare(price, ref.market_price) : ''}`
      : '';
    updatePhotoRule(); // el precio o la carta elegida cambian si las fotos son obligatorias
    renderPreview();
  }
  f.price.addEventListener('input', renderPriceHint);

  // Resultados acumulados de la búsqueda actual (se agregan páginas con "Ver más")
  let found = [], foundFx = null, foundSource = '';
  const resultBtn = (r, i) => `
    <button type="button" data-i="${i}">
      ${safeImg(r.image_small) ? `<img src="${esc(r.image_small)}" alt="" loading="lazy">` : '<span class="no-img">✦</span>'}
      <b>${esc(r.card_name)}</b><br>
      <span class="muted">${esc(r.set_name)} ${esc(r.card_code)}</span><br>
      <span class="muted">${esc(r.rarity)}</span>
      ${r.market_price_mxn ? `<div class="est-chip">${money(r.market_price_mxn)}</div>`
        : r.market_price ? `<div class="est-chip">${usd(r.market_price)}</div>` : ''}
    </button>`;

  async function search(page = 1) {
    const name = f.card_name.value.trim();
    if (name.length < 2) { box.innerHTML = ''; return; }
    const game = f.game.value;
    const more = document.getElementById('moreResults');
    if (page === 1) { found = []; foundSource = ''; box.innerHTML = '<span class="muted">Buscando…</span>'; }
    else if (more) { more.disabled = true; more.textContent = 'Cargando…'; }
    try {
      const qs = new URLSearchParams({ game, q: name, page, ...(page > 1 && foundSource ? { source: foundSource } : {}) });
      const { results, fx, has_more, source } = await api(`/api/lookup?${qs}`);
      if (f.game.value !== game || f.card_name.value.trim() !== name) return; // llegó una búsqueda más nueva
      if (page === 1) foundSource = source || '';
      // Sin duplicados al juntar páginas
      const seen = new Set(found.map(r => r.ref_id));
      found.push(...results.filter(r => !seen.has(r.ref_id)));
      foundFx = fx;
      if (!found.length) {
        box.innerHTML = `<span class="muted">Sin resultados. Prueba con el nombre en inglés, agrega el número (ej. "Pikachu 25")
          o el código de edición (ej. "LOB-EN001"), o rellena los datos a mano.</span>`;
        return;
      }
      box.innerHTML = `
        <div class="lookup-count muted">${found.length}${has_more ? '+' : ''} resultado(s) · elige tu edición exacta</div>
        ${found.map(resultBtn).join('')}
        ${has_more ? `<button type="button" class="btn small more" id="moreResults" data-page="${page + 1}">Ver más resultados</button>` : ''}`;
      box.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => {
        const r = found[b.dataset.i];
        for (const k of ['card_name', 'set_name', 'card_code', 'rarity']) f[k].value = r[k] || '';
        ref = { ref_id: r.ref_id, image: r.image_small || r.image_url, market_price: r.market_price_mxn, usd: r.market_price,
                market_source: r.market_source, fx: foundFx };
        box.innerHTML = ''; document.getElementById('manual').open = false; renderRef();
        if (!f.price.value && r.market_price_mxn) { f.price.value = Math.round(r.market_price_mxn); renderPriceHint(); }
      }));
      document.getElementById('moreResults')?.addEventListener('click', e => search(Number(e.currentTarget.dataset.page)));
    } catch (err) {
      if (page === 1) box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      else if (more) { more.disabled = false; more.textContent = 'Reintentar'; toast(err.message); }
    }
  }
  let t;
  f.card_name.addEventListener('input', () => {
    if (ref) { ref = null; renderRef(); } // cambió el nombre: la selección anterior ya no aplica
    clearTimeout(t); t = setTimeout(search, 450);
  });
  f.card_name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); search(); } });
  document.getElementById('lookup').addEventListener('click', () => { clearTimeout(t); search(); });

  document.querySelectorAll('#gameTabs .tab').forEach(b => b.addEventListener('click', () => {
    if (f.game.value === b.dataset.game) return;
    f.game.value = b.dataset.game;
    document.querySelectorAll('#gameTabs .tab').forEach(x => x.classList.toggle('active', x === b));
    ref = null; renderRef(); box.innerHTML = '';
    if (f.card_name.value.trim().length >= 2) search();
  }));

  // --- Fotos reales ---
  photos = setupPhotos(l.photos, () => renderPreview());

  // ¿Hacen falta fotos? Si la carta vale más de US$2.50 (precio de mercado o el precio que pones)
  function photosNeeded() {
    const sellerUsd = (Number(f.price.value) || 0) / usdRate;
    return Math.max(Number(ref?.usd) || 0, sellerUsd) > PHOTO_MIN_USD;
  }
  function updatePhotoRule() {
    const need = photosNeeded();
    const req = document.getElementById('photoReq');
    req.textContent = need ? 'obligatorio' : 'opcional';
    req.classList.toggle('optional', !need);
    document.getElementById('photoRule').textContent = need
      ? `Como la carta vale más de US$${PHOTO_MIN_USD.toFixed(2)}, necesitas al menos una foto.`
      : `Las fotos son opcionales en cartas de hasta US$${PHOTO_MIN_USD.toFixed(2)} (unos ${money(Math.round(PHOTO_MIN_USD * usdRate))}); si no subes, se muestra la imagen oficial.`;
  }
  renderRef();
  updatePhotoRule();
  renderPreview();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    const body = formData(f);
    if (!body.card_name.trim()) { err.textContent = 'Escribe el nombre de la carta.'; return; }
    if (photos.count() < 1 && photosNeeded()) {
      err.textContent = `Esta carta vale más de US$${PHOTO_MIN_USD.toFixed(2)}: sube al menos una foto real de tu carta.`; return;
    }
    if (body.price === '' || Number(body.price) < 0) { err.textContent = 'Indica un precio válido.'; return; }
    body.price = Number(body.price); body.quantity = Number(body.quantity);
    body.ref_id = ref?.ref_id || '';
    body.new_photos = photos.added();
    if (id) body.keep_photos = photos.keepIds();
    const btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = 'Subiendo…'; err.textContent = '';
    try {
      const { listing } = await api(id ? `/api/listings/${id}` : '/api/listings', { method: id ? 'PUT' : 'POST', body });
      toast(id ? 'Cambios guardados' : '¡Carta publicada!'); go(`#/carta/${listing.id}`);
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false; btn.textContent = id ? 'Guardar cambios' : 'Publicar carta';
    }
  });
}

function viewProfile() {
  if (!requireLogin()) return;
  const u = currentUser;
  $app.innerHTML = `
    <div class="panel auth">
      <h1>Mi perfil</h1>
      <p class="muted">Lo que pongas aquí lo verán los compradores. <a href="#/vendedor/${encodeURIComponent(u.username)}">Ver mi perfil público</a></p>
      <form id="f">
        ${profileFields(u)}
        <div class="error" id="err"></div>
        <button class="btn primary">Guardar</button>
      </form>
    </div>
    <div class="panel auth">
      <h2>⚔ Torneos</h2>
      <p class="muted">Tus IDs de jugador solo los ven quienes organizan los torneos en los que te inscribes. <a href="#/torneos">Ir a torneos</a></p>
      ${pokemonIdForm(u.pokemon_id || '')}
      <hr class="soft">
      ${konamiIdForm(u.konami_id || '')}
    </div>`;
  bindPokemonIdForm(viewProfile);
  bindKonamiIdForm(viewProfile);
  const f = document.getElementById('f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      ({ user: currentUser } = await api('/api/auth/me', { method: 'PUT', body: formData(f) }));
      renderNav(); toast('Perfil actualizado');
    } catch (err) { document.getElementById('err').textContent = err.message; }
  });
}

// ---------- Torneos ----------

const T_STATUS = { registration: 'Inscripciones abiertas', running: 'En curso', finished: 'Terminado' };
const RES_LABEL = { W: 'V', L: 'D', T: 'E' };
const fmtDate = (s) => new Date(s).toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const record = (r) => (r ? `${r.wins}-${r.losses}-${r.ties}` : '0-0-0');
const pills = (last = []) => `<span class="pills">${last.map(r => `<span class="pill ${r}">${RES_LABEL[r]}</span>`).join('')}</span>`;

function streakText(s) {
  if (!s?.current) return 'Sin partidas todavía';
  const n = s.current.count;
  return { W: `🔥 ${n} ${n === 1 ? 'victoria' : 'victorias seguidas'}`,
           L: `💀 ${n} ${n === 1 ? 'derrota' : 'derrotas seguidas'}`,
           T: `🤝 ${n} ${n === 1 ? 'empate' : 'empates seguidos'}` }[s.current.type];
}

// Tarjeta "contra quién vas" de la ronda en curso
function vsCard(m, tournament) {
  const head = `${tournament ? `<a href="#/torneo/${tournament.id}">${esc(tournament.name)}</a> · ` : ''}Ronda ${m.round}`;
  if (m.bye) return `
    <div class="vs-card">
      <div class="vs-head">${head}</div>
      <div class="vs-bye">Tienes <b>bye</b> esta ronda: cuenta como victoria. ¡Descansa, guerrero!</div>
    </div>`;
  const done = m.result ? `<div class="vs-result ${m.result}">${{ W: 'Ganaste', L: 'Perdiste', T: 'Empate' }[m.result]}</div>` : '';
  return `
    <div class="vs-card">
      <div class="vs-head">${head} · <b>Mesa ${m.table_no}</b></div>
      <div class="vs-body">
        <div class="vs-player me"><span class="muted">Tú</span><b>${esc(currentUser.display_name)}</b><span>${record(m.my_record)}</span></div>
        <div class="vs-sword">⚔</div>
        <div class="vs-player"><span class="muted">Rival</span>
          <b>${esc(m.opponent?.display_name || '—')}</b>
          <span>${m.opponent?.username ? `@${esc(m.opponent.username)} · ` : ''}${record(m.opponent?.record)}${m.opponent?.record ? ` · ${m.opponent.record.place}º` : ''}</span></div>
      </div>
      ${done}
    </div>`;
}

// Aviso fijo bajo la cabecera cuando tienes una partida en curso
async function refreshMatchBanner() {
  const $b = document.getElementById('matchBanner');
  if (!currentUser) { $b.hidden = true; return; }
  try {
    const { active } = await api('/api/tournaments/me');
    const pending = active.filter(m => !m.result);
    $b.hidden = !pending.length || location.hash.startsWith('#/torneo');
    $b.innerHTML = pending.map(m => `<a href="#/torneo/${m.tournament.id}">⚔ <b>${esc(m.tournament.name)}</b> · Ronda ${m.round}: ${
      m.bye ? 'tienes bye' : `mesa ${m.table_no} contra <b>${esc(m.opponent?.display_name)}</b> (${record(m.opponent?.record)})`}</a>`).join('');
  } catch { $b.hidden = true; }
}

function pokemonIdForm(id) {
  return `
    <form id="pidForm" class="pid-form">
      <label for="pid">ID de jugador Pokémon (Play! Pokémon)</label>
      <div class="pid-row">
        <input id="pid" name="pokemon_id" inputmode="numeric" pattern="[0-9]{4,10}" maxlength="10" placeholder="ej. 1234567" value="${esc(id)}">
        <button class="btn primary">${id ? 'Actualizar' : 'Vincular'}</button>
        ${id ? '<button type="button" class="btn" id="pidUnlink">Desvincular</button>' : ''}
      </div>
      <div class="card-meta">Es el número de tu Play! Pokémon ID (aparece en tu cuenta del Club de Entrenadores Pokémon). Lo necesitas para inscribirte en torneos.</div>
      <div class="error" id="pidErr"></div>
    </form>`;
}

function konamiIdForm(id) {
  return `
    <form id="kidForm" class="pid-form">
      <label for="kid">KONAMI CARD GAME ID (Yu-Gi-Oh!)</label>
      <div class="pid-row">
        <input id="kid" name="konami_id" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" placeholder="10 dígitos" value="${esc(id)}">
        <button class="btn primary">${id ? 'Actualizar' : 'Vincular'}</button>
        ${id ? '<button type="button" class="btn" id="kidUnlink">Desvincular</button>' : ''}
      </div>
      <div class="card-meta">Tu CARD GAME ID de 10 dígitos (antes COSSY ID; lo ves en la app NEURON vinculada a tu KONAMI ID). Lo necesitas para torneos de Yu-Gi-Oh!.</div>
      <div class="error" id="kidErr"></div>
    </form>`;
}
function bindKonamiIdForm(after) {
  const f = document.getElementById('kidForm');
  if (!f) return;
  const save = async (value) => {
    try {
      ({ user: currentUser } = await api('/api/auth/me/konami-id', { method: 'PUT', body: { konami_id: value } }));
      toast(value ? 'CARD GAME ID vinculado' : 'CARD GAME ID desvinculado'); after();
    } catch (err) { document.getElementById('kidErr').textContent = err.message; }
  };
  f.addEventListener('submit', e => { e.preventDefault(); save(f.konami_id.value.trim()); });
  document.getElementById('kidUnlink')?.addEventListener('click', () => save(''));
}

function bindPokemonIdForm(after) {
  const f = document.getElementById('pidForm');
  if (!f) return;
  const save = async (value) => {
    try {
      ({ user: currentUser } = await api('/api/auth/me/pokemon-id', { method: 'PUT', body: { pokemon_id: value } }));
      toast(value ? 'ID de jugador vinculado' : 'ID de jugador desvinculado'); after();
    } catch (err) { document.getElementById('pidErr').textContent = err.message; }
  };
  f.addEventListener('submit', e => { e.preventDefault(); save(f.pokemon_id.value.trim()); });
  document.getElementById('pidUnlink')?.addEventListener('click', () => save(''));
}

function tournamentTile(t) {
  return `
    <a class="t-tile" href="#/torneo/${t.id}">
      <span><span class="badge ${t.game === 'yugioh' ? 'yugioh' : 'pokemon'}">${t.game === 'yugioh' ? 'Yu-Gi-Oh!' : 'Pokémon'}</span>
        <span class="badge t-${t.status}">${T_STATUS[t.status]}${t.status === 'running' ? ` · ronda ${t.current_round}${t.phase === 'top' ? ' (top cut)' : ''}` : ''}</span>
        ${t.source === 'tdf' ? '<span class="badge t-tom" title="Importado del archivo oficial de TOM">TOM</span>' : ''}</span>
      <div class="card-name">${esc(t.name)}</div>
      <div class="card-meta">📅 ${fmtDate(t.starts_at)}</div>
      ${t.location ? `<div class="card-meta">📍 ${esc(t.location)}</div>` : ''}
      <div class="card-meta">👥 ${t.player_count} jugador(es)${t.rounds ? ` · ${t.rounds} rondas` : ''} · ${t.source === 'tdf' ? 'importado por' : 'organiza'} @${esc(t.organizer_username)}</div>
    </a>`;
}

async function viewTournaments() {
  const [{ tournaments }, me] = await Promise.all([
    api('/api/tournaments'), currentUser ? api('/api/tournaments/me') : Promise.resolve(null),
  ]);
  const group = (st) => tournaments.filter(t => t.status === st);
  const section = (title, list, empty) => `
    <h2>${title}</h2>
    ${list.length ? `<div class="t-grid">${list.map(tournamentTile).join('')}</div>` : `<p class="muted">${empty}</p>`}`;
  const o = me?.overall;

  $app.innerHTML = `
    ${compNav('locales')}
    <div class="t-hero">
      ${emblemSVG()}
      <div>
        <span class="kicker">⚔ Torneos locales · Pokémon y Yu-Gi-Oh! ⚔</span>
        <h1>La arena del reino</h1>
        <p class="muted">Vincula tus IDs de jugador, inscríbete en torneos de tu zona y entérate al instante de contra quién juegas cada ronda.</p>
      </div>
      ${currentUser ? `<div class="t-actions">
        <a class="btn" href="#/torneos/importar">⬆ Importar TDF de TOM</a>
        <a class="btn primary" href="#/torneos/nuevo">+ Organizar torneo</a></div>` : ''}
    </div>

    ${me ? `
      <div class="panel player-card">
        <div class="player-top">
          <div>
            <h2>Mi ficha de jugador</h2>
            <p class="muted id-line"><span>Pokémon: ${me.pokemon_id ? `<b>${esc(me.pokemon_id)}</b>` : '<i>sin vincular</i>'}</span>
              <span>KONAMI: ${currentUser.konami_id ? `<b>${esc(currentUser.konami_id)}</b>` : '<i>sin vincular</i>'}</span></p>
          </div>
          <div class="stat-row">
            <div class="tstat win"><b>${o.wins}</b><span>Victorias</span></div>
            <div class="tstat loss"><b>${o.losses}</b><span>Derrotas</span></div>
            <div class="tstat"><b>${o.ties}</b><span>Empates</span></div>
            <div class="tstat"><b>${o.best_win_streak}</b><span>Mejor racha</span></div>
          </div>
        </div>
        <p class="streak-line"><b>Racha actual:</b> ${streakText(o)} ${pills(o.last)}</p>
        <div class="id-forms">
          <div>${pokemonIdForm(me.pokemon_id)}</div>
          <div>${konamiIdForm(currentUser.konami_id || '')}</div>
        </div>
      </div>
      ${me.active.length ? `<h2>⚔ Tus partidas ahora</h2><div class="vs-list">${me.active.map(m => vsCard(m, m.tournament)).join('')}</div>` : ''}
      ${me.history.length ? `
        <h2>Mi historial</h2>
        <div class="panel" style="overflow-x:auto">
          <table class="mine"><thead><tr><th>Torneo</th><th>Fecha</th><th>Estado</th><th>Récord</th><th>Lugar</th><th>Últimas</th></tr></thead>
          <tbody>${me.history.map(h => `<tr>
            <td><a href="#/torneo/${h.id}">${esc(h.name)}</a>${h.source === 'tdf' ? ' <span class="badge t-tom">TOM</span>' : ''}</td><td>${fmtDate(h.starts_at)}</td>
            <td><span class="badge t-${h.status}">${T_STATUS[h.status]}</span></td>
            <td><b>${record(h)}</b></td><td>${h.place && h.status !== 'registration' ? `${h.place}º de ${h.player_count}` : '—'}</td>
            <td>${pills(h.last)}</td></tr>`).join('')}</tbody></table>
        </div>` : ''}`
    : `<div class="empty"><a href="#/login">Inicia sesión</a> o <a href="#/registro">crea una cuenta</a> para vincular tu ID de jugador y entrar a torneos.</div>`}

    ${section('En curso', group('running'), 'No hay torneos en curso.')}
    ${section('Próximos', [...group('registration')].reverse(), 'No hay torneos con inscripciones abiertas.')}
    ${section('Terminados', group('finished'), 'Aún no hay torneos terminados.')}`;

  bindPokemonIdForm(viewTournaments);
  bindKonamiIdForm(viewTournaments);
}

// Campos de configuración (crear y editar)
function tournamentFields(t = {}) {
  const c = t.config || {};
  const game = t.game || 'pokemon';
  const top = c.top_cut ?? 'auto';
  return `
    <div class="field"><label>Juego</label>
      <div class="segmented" id="tGame">${[['pokemon', 'Pokémon'], ['yugioh', 'Yu-Gi-Oh!']].map(([k, n]) => `<button type="button" data-game="${k}" class="${game === k ? 'active' : ''}">${n}</button>`).join('')}</div>
      <input type="hidden" name="game" value="${esc(game)}">
      <p class="card-meta" id="rulesHint">${game === 'yugioh' ? 'Reglas KONAMI (como KTS): V 3 / D 0, sin empates (tiempo = doble derrota), desempate AABBBCCCDDD.' : 'Reglas Play! Pokémon (como TOM): V 3 / E 1 / D 0, desempates % de rivales (mín. 25 %) y % de rivales de rivales.'}</p></div>
    <div class="field"><label>Nombre</label><input name="name" required minlength="3" maxlength="80" value="${esc(t.name || '')}" placeholder="ej. Liga de la Tienda · Noviembre"></div>
    <div class="field"><label>Lugar</label><input name="location" maxlength="80" value="${esc(t.location || '')}" placeholder="ej. Tienda Dragón, Col. Roma"></div>
    <div class="row">
      <div class="field"><label>Fecha y hora</label><input name="starts_at" type="datetime-local" required value="${esc(t.starts_at || '')}"></div>
      <div class="field"><label>Rondas de suizo</label><select name="rounds">
        <option value="0" ${!t.rounds ? 'selected' : ''}>Automático (según jugadores)</option>
        ${[...Array(15).keys()].map(i => `<option value="${i + 1}" ${t.rounds === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Top cut</label><select name="top_cut">
        ${[['auto', 'Automático (tabla oficial)'], ['0', 'Sin top cut'], ['2', 'Top 2'], ['4', 'Top 4'], ['8', 'Top 8'], ['16', 'Top 16'], ['32', 'Top 32']]
          .map(([v, n]) => `<option value="${v}" ${String(top) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label>Formato de partida</label><select name="best_of">
        <option value="3" ${c.best_of !== 1 ? 'selected' : ''}>Mejor de 3</option><option value="1" ${c.best_of === 1 ? 'selected' : ''}>A 1 juego</option></select></div>
      <div class="field"><label>Minutos por ronda</label><input name="round_minutes" type="number" min="10" max="120" value="${esc(c.round_minutes || 50)}"></div>
    </div>
    <label class="switch"><input type="checkbox" name="open_registration" ${c.open_registration !== false ? 'checked' : ''}><span class="switch-ui"></span>
      <span><b>Inscripción abierta</b><small>Los jugadores se inscriben solos. Si la apagas, solo tú agregas jugadores registrados.</small></span></label>
    <label class="switch"><input type="checkbox" name="require_id" ${c.require_id !== false ? 'checked' : ''}><span class="switch-ui"></span>
      <span><b>Pedir ID oficial</b><small>Play! Pokémon ID o KONAMI CARD GAME ID vinculado en el perfil (recomendado para torneos oficiales).</small></span></label>`;
}
function tournamentBody(f) {
  const d = formData(f);
  return { name: d.name, location: d.location, starts_at: d.starts_at, game: d.game, rounds: Number(d.rounds) || 0,
    config: { top_cut: d.top_cut, best_of: Number(d.best_of), round_minutes: Number(d.round_minutes),
              open_registration: !!f.open_registration.checked, require_id: !!f.require_id.checked } };
}
function bindTournamentFields(f) {
  f.querySelector('#tGame').addEventListener('click', e => {
    const b = e.target.closest('[data-game]'); if (!b) return;
    f.game.value = b.dataset.game;
    f.querySelectorAll('#tGame button').forEach(x => x.classList.toggle('active', x === b));
    f.querySelector('#rulesHint').textContent = b.dataset.game === 'yugioh'
      ? 'Reglas KONAMI (como KTS): V 3 / D 0, sin empates (tiempo = doble derrota), desempate AABBBCCCDDD.'
      : 'Reglas Play! Pokémon (como TOM): V 3 / E 1 / D 0, desempates % de rivales (mín. 25 %) y % de rivales de rivales.';
  });
}

function viewTournamentForm() {
  if (!requireLogin()) return;
  $app.innerHTML = `
    ${compNav('locales')}
    <p><a href="#/torneos">← Torneos</a></p>
    <div class="panel form-wide">
      <h1>Organizar torneo</h1>
      <p class="muted">Suizo con las reglas oficiales de cada juego. Las rondas y el top cut se calculan solos según los jugadores (puedes cambiarlos).</p>
      <form id="f" class="t-form">
        ${tournamentFields()}
        <div class="error" id="err"></div>
        <button class="btn primary">Crear torneo</button>
      </form>
    </div>`;
  const f = document.getElementById('f');
  bindTournamentFields(f);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { tournament } = await api('/api/tournaments', { method: 'POST', body: tournamentBody(f) });
      toast('¡Torneo creado!'); go(`#/torneo/${tournament.id}`);
    } catch (err) { document.getElementById('err').textContent = err.message; }
  });
}

async function viewTournament(id) {
  const d = await api(`/api/tournaments/${id}`);
  const t = d.tournament, me = d.me;
  const isTdf = t.source === 'tdf';
  // En torneos de TOM los jugadores se identifican por su ID de jugador Pokémon
  const myKey = isTdf ? me.key : currentUser?.id;
  const isMe = (p) => p && myKey != null && String(p.user_id) === String(myKey);
  const multiCat = isTdf && (t.categories || []).length > 1;
  const nameOf = (p) => (p ? `${p.username ? `<a href="#/vendedor/${encodeURIComponent(p.username)}">${esc(p.display_name)}</a> <span class="muted">@${esc(p.username)}</span>`
                                           : esc(p.display_name)}` : '—');
  // Ronda en curso de cada categoría (en un TDF cada categoría numera sus rondas)
  const lastRound = {};
  for (const r of d.rounds) lastRound[r.category || ''] = Math.max(lastRound[r.category || ''] || 0, r.round);
  const r_isTop = (round) => d.rounds.some(r => r.round === round && r.topcut);
  const editRounds = viewTournament.editing?.id === id ? viewTournament.editing.rounds : new Set();
  const resultCell = (m, round) => {
    if (m.bye) return '<span class="badge cond">Bye</span>';
    if (!isTdf && d.can_manage && t.status !== 'registration' && (editRounds.has(round) || (round === t.current_round && t.status === 'running'))) {
      const opts = [['', 'Pendiente'], ['p1', `Gana ${m.player1.display_name}`], ['p2', `Gana ${m.player2.display_name}`],
        ...(r_isTop(round) ? [] : [...(d.rules?.ties ? [['tie', 'Empate']] : []), ['dl', 'Doble derrota']])];
      return `<select data-res="${round}/${m.table_no}" class="${m.result ? 'done' : ''}">
        ${opts.map(([v, txt]) => `<option value="${v}" ${(m.result || '') === v ? 'selected' : ''}>${esc(txt)}</option>`).join('')}
      </select>`;
    }
    if (!m.result) return '<span class="muted">En juego</span>';
    return m.result === 'tie' ? 'Empate' : m.result === 'dl' ? 'Doble derrota' : `Gana ${esc((m.result === 'p1' ? m.player1 : m.player2)?.display_name)}`;
  };

  const standingsHTML = t.status === 'registration' ? '' : `
      <h2>${t.status === 'finished' ? '🏆 Clasificación final' : 'Clasificación'}</h2>
      <div class="panel" style="overflow-x:auto">
        ${isTdf ? '<p class="card-meta">Lugar oficial calculado por TOM. Récord con top cut incluido; puntos y % de rivales solo del suizo.</p>' : ''}
        ${!isTdf ? `<p class="card-meta">${d.rules.game === 'yugioh' ? 'Desempate KTS: puntos · % de victorias de rivales (OMW) · % de los rivales de rivales (OOMW) · suma de cuadrados de rondas perdidas. Número KTS = AABBBCCCDDD.' : 'Desempates Play! Pokémon: puntos · % de victorias de rivales (mín. 25 %) · % de rivales de rivales · enfrentamiento directo.'}${d.tournament.phase === 'top' || d.rounds.some(r => r.topcut) ? ' Los primeros lugares salen del top cut.' : ''}</p>` : ''}
        <table class="mine"><thead><tr><th>#</th><th>Jugador</th>${multiCat ? '<th>Categoría</th>' : ''}<th>Récord</th><th>Puntos</th><th>${d.rules?.game === 'yugioh' ? 'OMW' : '% rivales'}</th>${!isTdf ? `<th>${d.rules?.game === 'yugioh' ? 'OOMW' : '% riv. de riv.'}</th>` : ''}${d.rules?.game === 'yugioh' ? '<th>KTS</th>' : ''}</tr></thead>
        <tbody>${d.standings.map(s => `<tr class="${isMe(s) ? 'mine-row' : ''}${s.dropped ? ' dropped' : ''}">
          <td>${s.place}${s.place === 1 && t.status === 'finished' ? ' 👑' : ''}</td><td>${nameOf(s)}${s.dropped ? ` <span class="badge cond">Retirado R${s.dropped}</span>` : ''}</td>${multiCat ? `<td>${esc(s.category)}</td>` : ''}
          <td>${record(s)}</td><td><b>${s.points}</b></td><td>${s.opp_win_pct}%</td>${!isTdf ? `<td>${s.oopp_win_pct ?? '—'}%</td>` : ''}${d.rules?.game === 'yugioh' ? `<td class="mono">${esc(s.kts || '')}</td>` : ''}</tr>`).join('')}</tbody></table>
      </div>`;

  $app.innerHTML = `
    ${compNav('locales')}
    <p><a href="#/torneos">← Torneos</a></p>
    <div class="t-hero">
      ${emblemSVG()}
      <div>
        ${!isTdf ? `<span class="badge ${d.rules?.game || 'pokemon'}">${d.rules?.game === 'yugioh' ? 'Yu-Gi-Oh!' : 'Pokémon'}</span>` : ''}
        <span class="badge t-${t.status}">${T_STATUS[t.status]}${t.status !== 'registration' && !isTdf ? (t.phase === 'top' ? ' · top cut' : ` · ronda ${t.current_round}${t.rounds ? ` de ${t.rounds}` : ''}`) : ''}</span>
        ${isTdf ? `<span class="badge t-tom">Importado de TOM</span> ${(t.categories || []).map(c => `<span class="badge cond">${esc(c)}</span>`).join(' ')}` : ''}
        <h1>${esc(t.name)}</h1>
        <p class="muted">📅 ${fmtDate(t.starts_at)}${t.location ? ` · 📍 ${esc(t.location)}` : ''} · 👥 ${t.player_count} jugador(es) ·
          ${isTdf ? `organiza ${esc(t.organizer_tom || '—')} · importado por @${esc(t.organizer_username)}` : `organiza @${esc(t.organizer_username)}`}</p>
      </div>
      <div class="t-actions">
        ${t.status === 'registration' && currentUser
          ? (me.joined ? '<button class="btn" id="leave">Salir del torneo</button>' : d.tournament.config?.open_registration === false ? '<span class="badge cond">El organizador agrega a los jugadores</span>' : '<button class="btn primary" id="join">Inscribirme</button>')
          : ''}
        ${!currentUser && t.status === 'registration' ? '<a class="btn primary" href="#/login">Inicia sesión para inscribirte</a>' : ''}
      </div>
    </div>
    <div class="error" id="err"></div>

    ${!isTdf && t.status === 'running' && d.timer ? timerPanel(d, id) : ''}

    ${currentUser && !isTdf && t.status === 'registration' && !me.joined && d.tournament.config?.require_id !== false
      && !(d.rules?.game === 'yugioh' ? currentUser.konami_id : currentUser.pokemon_id)
      ? `<div class="panel">${d.rules?.game === 'yugioh' ? konamiIdForm('') : pokemonIdForm('')}</div>` : ''}

    ${me.joined ? `
      ${me.match ? vsCard(me.match) : ''}
      <div class="panel player-card">
        <div class="player-top">
          <div><h2>Tu torneo</h2><p class="streak-line"><b>Racha:</b> ${streakText(me)} ${pills(me.last)}</p></div>
          <div class="stat-row">
            <div class="tstat win"><b>${me.wins}</b><span>Victorias</span></div>
            <div class="tstat loss"><b>${me.losses}</b><span>Derrotas</span></div>
            <div class="tstat"><b>${me.ties}</b><span>Empates</span></div>
          </div>
        </div>
        ${!isTdf ? `<form class="my-deck-form" id="myDeckForm">
          <label>🃏 Mi deck en este torneo <span class="card-meta">(alimenta el metajuego de la página)</span></label>
          <div class="search-row"><select name="deck_id" id="myDeckSel"><option value="">Cargando tus decks…</option></select>
            <button class="btn small" type="submit">Guardar</button></div>
          <p class="card-meta" id="myDeckHint">${me.deck ? `Registrado: <b>${esc(me.deck)}</b>` : 'Elige uno de tus decks guardados.'}</p>
        </form>` : ''}
      </div>` : ''}

    ${d.can_manage && isTdf ? `
      <div class="panel organizer">
        <h2>Torneo importado de TOM</h2>
        <p class="muted">${t.status === 'running'
          ? 'Para que los jugadores vean su siguiente rival, sube el TDF actualizado cada vez que emparejes una ronda en TOM.'
          : 'Si corregiste algo en TOM, sube el TDF de nuevo y se reemplazan las rondas y resultados.'}</p>
        <div class="t-actions">
          <label class="btn primary" for="tdfUpdate">⬆ Actualizar con TDF nuevo</label>
          <input type="file" id="tdfUpdate" accept=".tdf,.xml" hidden>
          <button class="btn danger" id="del">Quitar torneo</button>
        </div>
      </div>` : ''}

    ${d.can_manage && !isTdf ? organizerPanel(d) : ''}

    ${t.status === 'finished' ? standingsHTML : ''}

    ${d.rounds.length ? [...d.rounds].reverse().map(r => `
      <div class="round-head"><h2>${esc(r.label || `Ronda ${r.round}`)}${multiCat ? ` · ${esc(r.category)}` : ''}${r.round === lastRound[r.category || ''] && t.status === 'running' ? ' <span class="badge t-running">en curso</span>' : ''}</h2>
        ${!isTdf && d.can_manage && !(r.round === t.current_round && t.status === 'running')
          ? `<button type="button" class="btn small ${editRounds.has(r.round) ? 'primary' : ''}" data-edit-round="${r.round}">${editRounds.has(r.round) ? '✔ Listo' : '✏️ Corregir resultados'}</button>` : ''}</div>
      <div class="panel" style="overflow-x:auto">
        <table class="mine pairings"><thead><tr><th>Mesa</th><th>Jugador 1</th><th></th><th>Jugador 2</th><th>Resultado</th></tr></thead>
        <tbody>${r.matches.map(m => `<tr class="${[m.player1, m.player2].some(isMe) ? 'mine-row' : ''}">
          <td>${m.table_no}</td><td>${nameOf(m.player1)}</td><td class="muted">vs</td>
          <td>${m.bye ? '<span class="muted">— bye —</span>' : nameOf(m.player2)}</td><td>${resultCell(m, r.round)}</td></tr>`).join('')}</tbody></table>
      </div>`).join('') : ''}

    ${t.status !== 'finished' ? standingsHTML : ''}

    <h2>${isTdf ? 'Jugadores' : 'Jugadores inscritos'} (${d.players.length})</h2>
    ${isTdf ? '<p class="muted">Los jugadores con cuenta en la app aparecen con su usuario; los demás, con nombre e inicial del apellido.</p>' : ''}
    ${d.players.length ? `<div class="panel" style="overflow-x:auto">
      <table class="mine"><thead><tr><th>Jugador</th>${isTdf ? '<th>Categoría</th>' : '<th>Zona</th><th>Deck</th>'}${d.can_manage ? `<th>${d.rules?.game === 'yugioh' ? 'CARD GAME ID' : 'ID Pokémon'}</th>` : ''}${d.can_manage && !isTdf ? '<th></th>' : ''}</tr></thead>
      <tbody>${d.players.map(p => `<tr class="${isMe(p) ? 'mine-row' : ''}${p.dropped ? ' dropped' : ''}"><td>${nameOf(p)}${p.dropped ? ` <span class="badge cond">Retirado R${p.dropped}</span>` : ''}</td><td>${esc((isTdf ? p.category : p.location) || '—')}</td>${isTdf ? '' : `<td>${esc(p.deck || '—')}</td>`}${d.can_manage ? `<td class="mono">${esc((d.rules?.game === 'yugioh' ? p.konami_id : p.pokemon_id) || '—')}</td>` : ''}${d.can_manage && !isTdf ? `<td class="actions">${t.status === 'registration' ? `<button class="btn small" data-rm="${esc(p.user_id)}">Quitar</button>` : p.dropped ? `<button class="btn small" data-undrop="${esc(p.user_id)}">Reactivar</button>` : t.status === 'running' ? `<button class="btn small" data-drop="${esc(p.user_id)}">Dar de baja</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>
    </div>` : '<p class="muted">Todavía no hay jugadores inscritos.</p>'}`;

  const reload = () => viewTournament(id);
  const act = (elId, fn) => document.getElementById(elId)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await fn(); } catch (err) { document.getElementById('err').textContent = err.message; e.currentTarget.disabled = false; }
  });
  // Mi deck en este torneo (sugerencias: metajuego y mis decks guardados)
  const deckForm = document.getElementById('myDeckForm');
  if (deckForm) {
    const game = d.rules?.game || 'pokemon';
    api('/api/decks').then(({ decks }) => {
      const mine = decks.filter(x => x.game === game);
      const sel = document.getElementById('myDeckSel');
      if (!mine.length) {
        sel.innerHTML = '<option value="">No tienes decks de este juego</option>'; sel.disabled = true;
        document.getElementById('myDeckHint').innerHTML = `${me.deck ? `Registrado: <b>${esc(me.deck)}</b> · ` : ''}<a href="#/decks/nuevo">Arma y guarda tu deck</a> para poder registrarlo.`;
        deckForm.querySelector('button').disabled = true;
        return;
      }
      sel.innerHTML = `<option value="">— Elige tu deck —</option>${mine.map(x => `<option value="${esc(x.id)}" ${x.name === me.deck ? 'selected' : ''}>${esc(x.name)} · ${x.summary.total} cartas${x.summary.valid ? ' ✔' : ''}</option>`).join('')}`;
    }).catch(() => { document.getElementById('myDeckSel').innerHTML = '<option value="">No se pudieron cargar tus decks</option>'; });
    deckForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api(`/api/tournaments/${id}/deck`, { method: 'PUT', body: { deck_id: deckForm.deck_id.value } }); toast('Deck registrado'); reload(); }
      catch (err) { document.getElementById('err').textContent = err.message; }
    });
  }
  act('join', async () => { await api(`/api/tournaments/${id}/join`, { method: 'POST' }); toast('¡Inscrito! Suerte en la arena'); reload(); });
  act('leave', async () => { await api(`/api/tournaments/${id}/leave`, { method: 'POST' }); toast('Saliste del torneo'); reload(); });
  act('nextRound', async () => { const { round } = await api(`/api/tournaments/${id}/rounds`, { method: 'POST' }); toast(`Ronda ${round} emparejada`); reload(); });
  act('finish', async () => {
    if (!confirm('¿Finalizar el torneo? Ya no se podrán generar más rondas.')) { document.getElementById('finish').disabled = false; return; }
    await api(`/api/tournaments/${id}/finish`, { method: 'POST' }); toast('Torneo finalizado'); reload();
  });
  act('del', async () => {
    const msg = isTdf ? '¿Quitar este torneo importado? Podrás volver a importarlo con el TDF.' : '¿Borrar este torneo con todas sus rondas y resultados? No se puede deshacer.';
    if (!confirm(msg)) { document.getElementById('del').disabled = false; return; }
    await api(`/api/tournaments/${id}`, { method: 'DELETE' }); toast(isTdf ? 'Torneo quitado' : 'Torneo borrado'); go('#/torneos');
  });
  document.getElementById('tdfUpdate')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await uploadTdf(file);
      toast('Torneo actualizado con el TDF nuevo'); reload();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  });
  $app.querySelectorAll('[data-res]').forEach(s => s.addEventListener('change', async () => {
    try {
      await api(`/api/tournaments/${id}/matches/${s.dataset.res}`, { method: 'PUT', body: { result: s.value } });
      toast('Resultado guardado'); reload();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  }));
  $app.querySelectorAll('[data-edit-round]').forEach(b => b.addEventListener('click', () => {
    if (viewTournament.editing?.id !== id) viewTournament.editing = { id, rounds: new Set() };
    const r = Number(b.dataset.editRound);
    viewTournament.editing.rounds.has(r) ? viewTournament.editing.rounds.delete(r) : viewTournament.editing.rounds.add(r);
    reload();
  }));
  bindPokemonIdForm(reload);
  bindKonamiIdForm(reload);
  if (d.can_manage && !isTdf) bindOrganizer(d, id, reload);
  if (!isTdf && t.status === 'running' && d.timer) bindTimer(d, id, reload);
}

// ---------- Reloj de la ronda ----------
function timerControls(d) {
  if (!d.can_manage) return '';
  const min = d.tournament.config?.round_minutes || 50;
  return `<div class="timer-controls">
    <button type="button" class="btn small primary only-idle" data-tact="start">▶ Iniciar ${min} min</button>
    <button type="button" class="btn small only-running" data-tact="pause">⏸ Pausar</button>
    <button type="button" class="btn small primary only-paused" data-tact="resume">▶ Reanudar</button>
    <button type="button" class="btn small not-idle not-ended" data-tact="add" data-min="-1">−1 min</button>
    <button type="button" class="btn small not-idle" data-tact="add" data-min="1">+1 min</button>
    <button type="button" class="btn small not-idle" data-tact="add" data-min="5">+5 min</button>
    <button type="button" class="btn small not-idle" data-tact="start" data-confirm="1">↺ Reiniciar</button>
  </div>`;
}
const alertsLabel = () => alertsEnabled() ? '🔔 Avisos activados' : '🔕 Activar avisos';

function timerPanel(d, id) {
  const t = d.tournament;
  return `<div class="panel timer-panel" data-timer-host data-state="${d.timer.status}">
    <div class="tp-head">
      <div><h2>⏱ ${t.phase === 'top' ? 'Top cut · ' : ''}Ronda ${t.current_round}</h2>
        <p class="card-meta">${d.timer.status === 'idle' ? 'El reloj arranca al generar la ronda.' : 'Al llegar a cero suena una alarma en los teléfonos con los avisos activados.'}</p></div>
      <div class="tp-links">
        <button type="button" class="btn small" data-alerts>${alertsLabel()}</button>
        <a class="btn small" href="#/torneo/${id}/reloj">🖥 Pantalla grande</a>
      </div>
    </div>
    ${clockHTML()}
    ${timerControls(d)}
  </div>`;
}

function bindTimer(d, id, reload) {
  const t = d.tournament;
  startRoundTimer({ id, timer: d.timer, serverNow: d.server_now, game: d.rules?.game || 'pokemon', name: t.name,
                    round: t.current_round, onRoundChange: reload });
  $app.querySelectorAll('[data-alerts]').forEach(b => b.addEventListener('click', async () => {
    if (alertsEnabled()) { disableAlerts(); toast('Avisos desactivados'); }
    else {
      await enableAlerts();
      toast('Notification' in window && Notification.permission === 'denied'
        ? 'Sonará la alarma, pero el navegador bloqueó las notificaciones' : 'Te avisaremos a los 5 minutos y al terminar la ronda');
    }
    $app.querySelectorAll('[data-alerts]').forEach(x => { x.textContent = alertsLabel(); });
  }));
  $app.querySelectorAll('[data-tact]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.confirm && !confirm('¿Reiniciar el reloj de la ronda desde el tiempo completo?')) return;
    b.disabled = true;
    try {
      const r = await api(`/api/tournaments/${id}/timer`, { method: 'POST', body: { action: b.dataset.tact, minutes: Number(b.dataset.min) || undefined } });
      applyTimer(r);
    } catch (err) { toast(err.message); }
    b.disabled = false;
  }));
}

// Reloj a pantalla completa para proyectarlo en la tienda
async function viewTournamentClock(id) {
  const d = await api(`/api/tournaments/${id}`);
  const t = d.tournament;
  if (t.source === 'tdf' || t.status !== 'running' || !d.timer) {
    $app.innerHTML = `<div class="empty">El reloj aparece cuando el torneo tiene una ronda en curso. <br><a href="#/torneo/${id}">Volver al torneo</a></div>`;
    return;
  }
  document.body.classList.add('clock-mode');
  window.addEventListener('hashchange', () => document.body.classList.remove('clock-mode'), { once: true });
  $app.innerHTML = `<div class="big-clock" data-timer-host data-state="${d.timer.status}">
    <div class="bc-top"><a href="#/torneo/${id}">← ${esc(t.name)}</a>
      <div class="tp-links"><button type="button" class="btn small" data-alerts>${alertsLabel()}</button>
        <button type="button" class="btn small" id="fullscreen">⛶ Pantalla completa</button></div></div>
    <h1>${t.phase === 'top' ? 'Top cut · ' : ''}Ronda ${t.current_round}${t.rounds && t.phase !== 'top' ? ` <span>de ${t.rounds}</span>` : ''}</h1>
    ${clockHTML({ big: true })}
    ${timerControls(d)}
  </div>`;
  document.getElementById('fullscreen').addEventListener('click', () => {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {});
  });
  bindTimer(d, id, () => viewTournamentClock(id));
}

// ---------- Panel de organizador (torneos de la app) ----------
function organizerPanel(d) {
  const t = d.tournament, R = d.rules;
  const swissDone = t.rounds && t.current_round >= t.rounds && t.phase !== 'top';
  const curPlayers = t.current_round ? (d.rounds.find(r => r.round === t.current_round)?.matches || [])
    .flatMap(m => [m.player1, m.player2]).filter(Boolean) : [];
  const topRound = d.rounds.filter(r => r.topcut).slice(-1)[0];
  const topDone = topRound && topRound.matches.length === 1 && topRound.matches[0].result;
  return `
    <div class="panel organizer">
      <div class="panel-title"><h2>🛠️ Panel de organizador</h2><span class="badge ${R.game}">${esc(R.label)}</span></div>
      <div class="org-stats">
        <div><span>Jugadores activos</span><b>${d.players.filter(p => !p.dropped).length}</b></div>
        <div><span>Rondas de suizo</span><b>${t.current_round && t.phase !== 'top' ? `${t.current_round} / ` : ''}${R.rounds || '—'}</b><small>${t.rounds ? 'fijadas' : `automático: ${R.recommended.rounds || '—'}`}</small></div>
        <div><span>Top cut</span><b>${R.top_cut ? `Top ${R.top_cut}` : 'Ninguno'}</b><small>${t.config?.top_cut === 'auto' || t.config?.top_cut === undefined ? 'según la tabla oficial' : 'elegido'}</small></div>
        <div><span>Partidas</span><b>${t.config?.best_of === 1 ? 'A 1 juego' : 'Mejor de 3'}</b><small>${t.config?.round_minutes || 50} min por ronda</small></div>
      </div>
      <p class="muted">${t.status === 'registration' ? 'Agrega o espera a los jugadores. Al generar la ronda 1 se cierran las inscripciones y se emparejan al azar.'
        : t.phase === 'top' ? 'Top cut en curso: captura al ganador de cada partida y genera la siguiente ronda hasta la final.'
        : t.status === 'running' ? (swissDone ? `Terminó el suizo. ${R.top_cut ? `Inicia el top ${R.top_cut} o finaliza el torneo.` : 'Ya puedes finalizar el torneo.'}`
          : 'Captura los resultados; cuando estén completos genera la siguiente ronda (suizo por puntos, sin revanchas).')
        : 'Torneo terminado. Puedes reabrirlo para corregir algo.'}</p>
      <div class="t-actions">
        ${t.status !== 'finished' && !swissDone && !(t.phase === 'top' && topDone)
          ? `<button class="btn primary" id="nextRound" ${t.status === 'running' && !d.round_complete ? 'disabled' : ''}>${t.status === 'registration' ? 'Empezar · generar ronda 1' : t.phase === 'top' ? 'Siguiente ronda del top cut' : `Generar ronda ${t.current_round + 1}`}</button>` : ''}
        ${t.status === 'running' && swissDone && R.top_cut ? `<button class="btn primary" id="startTop" ${d.round_complete ? '' : 'disabled'}>Iniciar top ${R.top_cut}</button>` : ''}
        ${t.status === 'running' ? `<button class="btn" id="finish" ${d.round_complete ? '' : 'disabled'}>Finalizar torneo</button>` : ''}
        ${t.status === 'finished' ? '<button class="btn" id="reopen">Reabrir torneo</button>' : ''}
      </div>
      ${t.current_round ? `
      <details class="manual org-tools"><summary>🔧 Corregir la ronda ${t.current_round}</summary>
        <div class="t-actions">
          ${t.phase !== 'top' ? '<button class="btn small" id="repair">Rehacer emparejamientos</button>' : ''}
          <button class="btn small danger" id="undoRound">Deshacer ronda ${t.current_round}</button>
        </div>
        <p class="card-meta">Rehacer vuelve a emparejar la ronda actual (borra sus resultados). Deshacer la quita por completo y regresa a la ronda anterior.</p>
        ${curPlayers.length > 2 ? `<div class="swap-row"><label>Intercambiar de lugar a</label>
          <select id="swapA">${curPlayers.map(p => `<option value="${esc(p.user_id)}">${esc(p.display_name)}</option>`).join('')}</select>
          <span>con</span><select id="swapB">${curPlayers.map((p, i) => `<option value="${esc(p.user_id)}" ${i === 1 ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select>
          <button class="btn small" id="swap">Intercambiar</button></div>` : ''}
        <p class="card-meta">Para cambiar el resultado de una ronda pasada, usa el botón <b>✏️ Corregir resultados</b> junto a esa ronda; la clasificación se recalcula sola.</p>
      </details>` : ''}
      ${t.status !== 'finished' ? `
      <div class="add-player">
        <label>➕ Agregar jugador registrado${t.status === 'running' ? ' (entra desde la siguiente ronda)' : ''}</label>
        <div class="search-row"><input id="playerSearch" type="search" placeholder="Busca por usuario o nombre…" autocomplete="off"></div>
        <div id="playerResults" class="player-results"></div>
      </div>` : ''}
      <details class="manual org-tools"><summary>⚙️ Configuración del torneo</summary>
        <form id="tEdit" class="t-form">${tournamentFields({ ...t, starts_at: String(t.starts_at).slice(0, 16) })}
          <div class="t-actions"><button class="btn primary small">Guardar cambios</button><button type="button" class="btn small danger" id="del">Borrar torneo</button></div>
        </form>
      </details>
    </div>`;
}

function bindOrganizer(d, id, reload) {
  const call = async (path, opts, msg) => {
    try { await api(`/api/tournaments/${id}${path}`, opts); toast(msg); reload(); }
    catch (err) { document.getElementById('err').textContent = err.message; toast(err.message); }
  };
  const on = (elId, fn) => document.getElementById(elId)?.addEventListener('click', fn);
  on('startTop', () => call('/topcut', { method: 'POST', body: {} }, `Top ${d.rules.top_cut} emparejado`));
  on('reopen', () => call('/reopen', { method: 'POST' }, 'Torneo reabierto'));
  on('repair', () => confirm('¿Rehacer los emparejamientos de la ronda actual? Se borran sus resultados.') && call('/rounds/current/repair', { method: 'POST' }, 'Ronda emparejada de nuevo'));
  on('undoRound', () => confirm(`¿Deshacer la ronda ${d.tournament.current_round}? Se borran sus emparejamientos y resultados.`) && call('/rounds/current', { method: 'DELETE' }, 'Ronda deshecha'));
  on('swap', () => call('/rounds/current/swap', { method: 'POST', body: { a: document.getElementById('swapA').value, b: document.getElementById('swapB').value } }, 'Jugadores intercambiados'));
  $app.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => confirm('¿Quitar a este jugador del torneo?') && call(`/players/${b.dataset.rm}`, { method: 'DELETE' }, 'Jugador quitado')));
  $app.querySelectorAll('[data-drop]').forEach(b => b.addEventListener('click', () => confirm('¿Dar de baja a este jugador? Ya no se le empareja; su récord se conserva.') && call(`/players/${b.dataset.drop}`, { method: 'DELETE' }, 'Jugador dado de baja')));
  $app.querySelectorAll('[data-undrop]').forEach(b => b.addEventListener('click', () => call(`/players/${b.dataset.undrop}?undo=1`, { method: 'DELETE' }, 'Jugador reactivado')));

  // Buscar y agregar jugadores registrados
  const input = document.getElementById('playerSearch'), out = document.getElementById('playerResults');
  let timer;
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { out.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const { users } = await api(`/api/users-search?q=${encodeURIComponent(q)}`);
      const inT = new Set(d.players.map(p => String(p.user_id)));
      const needId = d.tournament.config?.require_id !== false;
      out.innerHTML = users.map(u => {
        const has = d.rules.game === 'yugioh' ? u.has_konami_id : u.has_pokemon_id;
        return `<div class="pr-row"><span><b>${esc(u.display_name)}</b> <span class="muted">@${esc(u.username)}${u.location ? ' · ' + esc(u.location) : ''}</span>
          ${has ? '<span class="badge legal">ID vinculado</span>' : '<span class="badge cond">Sin ID</span>'}</span>
          ${inT.has(String(u.id)) ? '<span class="card-meta">Ya inscrito</span>' : `<button class="btn small" data-add="${esc(u.id)}" ${needId && !has ? 'title="Necesita vincular su ID"' : ''}>Agregar</button>`}</div>`;
      }).join('') || '<p class="card-meta">Sin coincidencias. El jugador debe tener cuenta en Macai TCG.</p>';
      out.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => call('/players', { method: 'POST', body: { user_id: b.dataset.add } }, 'Jugador agregado')));
    }, 250);
  });

  // Configuración
  const f = document.getElementById('tEdit');
  if (f) {
    bindTournamentFields(f);
    f.addEventListener('submit', e => { e.preventDefault(); call('', { method: 'PUT', body: tournamentBody(f) }, 'Configuración guardada'); });
  }
}

// Lee el archivo TDF en el navegador y lo manda al servidor (que lo valida y lo interpreta)
async function uploadTdf(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error('El archivo es demasiado grande para ser un TDF.');
  const tdf = await file.text();
  if (!/<tournament\b/.test(tdf)) throw new Error('Ese archivo no parece un TDF de TOM.');
  return api('/api/tournaments/import-tdf', { method: 'POST', body: { tdf } });
}

function viewTdfImport() {
  if (!requireLogin()) return;
  const pid = currentUser.pokemon_id;
  $app.innerHTML = `
    <p><a href="#/torneos">← Torneos</a></p>
    <div class="panel form-wide">
      <h1>Importar torneo de TOM</h1>
      <p class="muted">Sube el archivo <b>.tdf</b> que genera TOM (Tournament Operations Manager), el mismo que se sube a Play! Tools.
        El torneo queda con todas sus rondas, resultados y la clasificación oficial, y aparece en el historial de cada jugador
        que tenga su ID de jugador vinculado en la app.</p>
      <ul class="card-meta tdf-notes">
        <li>Lo puede subir el organizador o cualquier jugador que aparezca en el archivo (tu ID debe estar en el TDF).</li>
        <li>Si el torneo ya existe, se actualiza: súbelo después de emparejar cada ronda para que los jugadores vean su siguiente rival.</li>
        <li>No se guardan las fechas de nacimiento del archivo. Quien no tenga cuenta aparece con nombre e inicial del apellido.</li>
      </ul>
      ${pid ? `
        <label class="drop" id="drop" for="tdfFile">
          <span class="drop-icon">⬆</span>
          <b>Elige o arrastra aquí el archivo .tdf</b>
          <span class="card-meta">Tu ID de jugador vinculado: ${esc(pid)}</span>
        </label>
        <input type="file" id="tdfFile" accept=".tdf,.xml" hidden>`
      : `<p><b>Primero vincula tu ID de jugador Pokémon:</b></p>${pokemonIdForm('')}`}
      <div class="error" id="err"></div>
    </div>`;
  bindPokemonIdForm(viewTdfImport);
  const input = document.getElementById('tdfFile');
  if (!input) return;
  const send = async (file) => {
    const err = document.getElementById('err');
    const drop = document.getElementById('drop');
    err.textContent = ''; drop.classList.add('busy');
    try {
      const { tournament, updated } = await uploadTdf(file);
      toast(updated ? 'Torneo actualizado' : '¡Torneo importado!'); go(`#/torneo/${tournament.id}`);
    } catch (e) { err.textContent = e.message; drop.classList.remove('busy'); }
  };
  input.addEventListener('change', () => { if (input.files[0]) send(input.files[0]); input.value = ''; });
  const drop = document.getElementById('drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]); });
}

// ---------- Decks ----------

const deckValue = (s) => (s.value_mxn ? money(s.value_mxn) : s.value_usd ? usd(s.value_usd) : '');
const deckStatus = (s, game) => (s.valid
  ? '<span class="badge legal">✔ Completo</span>'
  : `<span class="badge cond">${s.total} / ${game === 'pokemon' ? 60 : '40-60'}</span>`);

function deckTile(d) {
  const s = d.summary;
  return `
    <a class="deck-tile" href="#/decks/${d.id}">
      <div class="deck-cover">${safeImg(s.cover) ? `<img src="${esc(s.cover)}" alt="" loading="lazy">` : '<span class="placeholder">🃏</span>'}</div>
      <div class="deck-info">
        <div><span class="badge ${d.game}">${GAME_LABEL[d.game]}</span> ${deckStatus(s, d.game)}
          ${d.is_public ? '<span class="badge cond" title="Cualquiera con el enlace puede verlo">🌐 Público</span>' : ''}</div>
        <div class="card-name">${esc(d.name)}</div>
        <div class="card-meta">${s.total} cartas${deckValue(s) ? ` · ≈ ${deckValue(s)}` : ''} · ${fmtDay(d.updated_at)}</div>
      </div>
    </a>`;
}

async function viewDecks() {
  if (!requireLogin()) return;
  const { decks } = await api('/api/decks');
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>🃏 Mis decks</h1><p class="muted">Arma tus decks de Pokémon y Yu-Gi-Oh!, guárdalos y compártelos si quieres.</p></div>
      <div class="t-actions"><a class="btn primary" href="#/decks/nuevo">+ Nuevo deck</a></div>
    </div>
    ${decks.length ? `<div class="deck-grid">${decks.map(deckTile).join('')}</div>`
      : `<div class="empty">Aún no tienes decks. <a href="#/decks/nuevo">Arma el primero</a>: busca cartas y agrégalas,
         o pega una lista exportada de Pokémon TCG Live.</div>`}`;
}

// Fila de una carta dentro de un deck (constructor y vista)
const deckThumb = (c) => (safeImg(c.image)
  ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : `<span class="no-img">${c.category === 'energy' ? '⚡' : '✦'}</span>`);

// Grupos para mostrar: Pokémon por tipo de carta; Yu-Gi-Oh! por sección (y dentro, por tipo)
function deckGroups(game, cards) {
  const order = ['pokemon', 'trainer', 'energy', 'monster', 'spell', 'trap', 'extra', ''];
  const byCat = (list) => [...list].sort((a, b) => order.indexOf(a.category || '') - order.indexOf(b.category || '') || a.name.localeCompare(b.name));
  if (game === 'pokemon') {
    return order.filter(k => ['pokemon', 'trainer', 'energy', ''].includes(k))
      .map(k => ({ key: k, label: CATEGORY_LABEL[k], cards: byCat(cards.filter(c => (c.category || '') === k)) }))
      .filter(g => g.cards.length);
  }
  return SECTIONS.yugioh.map(s => ({ key: s, label: SECTION_LABEL[s], cards: byCat(cards.filter(c => (c.section || 'main') === s)) }))
    .filter(g => g.cards.length);
}

function summaryBox(game, s, fx) {
  const counts = game === 'pokemon' ? `<b>${s.total}</b> / 60 cartas`
    : `Principal <b>${s.counts.main}</b> · Extra <b>${s.counts.extra}</b> · Side <b>${s.counts.side}</b>`;
  return `
    <div class="deck-summary ${s.valid ? 'ok' : ''}">
      <div class="deck-count">${counts} ${s.valid ? '<span class="badge legal">✔ Deck completo</span>' : ''}</div>
      <div class="meter"><span style="width:${Math.min(100, Math.round(((game === 'pokemon' ? s.total : s.counts.main) / (game === 'pokemon' ? 60 : 40)) * 100))}%"></span></div>
      ${s.issues.length ? `<ul class="deck-issues">${s.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${s.value_usd ? `<div class="card-meta">Valor estimado: <b>${s.value_mxn ? money(s.value_mxn) : usd(s.value_usd)}</b>
        (${usd(s.value_usd)} en TCGplayer${fx ? `, ${fxNote(fx)}` : ''})${s.unpriced_cards ? ` · ${s.unpriced_cards} carta(s) sin precio` : ''}</div>` : ''}
    </div>`;
}

async function viewDeck(id) {
  const { deck: d, can_edit } = await api(`/api/decks/${id}`);
  const s = d.summary;
  const groups = deckGroups(d.game, d.cards);
  const flat = groups.flatMap(g => g.cards);
  $app.innerHTML = `
    <p>${can_edit ? '<a href="#/decks">← Mis decks</a>' : `<a href="#/vendedor/${encodeURIComponent(d.username)}">← Perfil de @${esc(d.username)}</a>`}</p>
    <div class="page-head">
      <div>
        <div><span class="badge ${d.game}">${GAME_LABEL[d.game]}</span> ${d.is_public ? '<span class="badge cond">🌐 Público</span>' : '<span class="badge cond">🔒 Privado</span>'}</div>
        <h1>${esc(d.name)}</h1>
        <p class="muted">De <a href="#/vendedor/${encodeURIComponent(d.username)}">@${esc(d.username)}</a> · actualizado ${fmtDay(d.updated_at)}</p>
        ${d.description ? `<p>${esc(d.description).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
      <div class="t-actions">
        ${can_edit ? `<a class="btn primary" href="#/decks/${d.id}/editar">Editar</a>` : ''}
        <button class="btn" id="copyList">📋 Copiar lista</button>
        ${d.is_public ? '<button class="btn" id="shareDeck">🔗 Compartir</button>' : ''}
        ${can_edit || currentUser?.is_admin ? '<button class="btn danger" id="delDeck">Borrar</button>' : ''}
      </div>
    </div>
    <div class="panel">${summaryBox(d.game, s, s.fx)}
      ${groups.map(g => `
        <h2 class="deck-group">${esc(g.label)} <span class="muted">(${g.cards.reduce((n, c) => n + c.qty, 0)})</span></h2>
        <div class="deck-view-grid">${g.cards.map(c => `
          <button type="button" class="deck-card" data-i="${flat.indexOf(c)}" title="${esc(c.name)}">
            ${deckThumb(c)}<span class="qty">×${c.qty}</span>
            ${safeImg(c.image) ? '' : `<span class="deck-card-name">${esc(c.name)}</span>`}
          </button>`).join('')}</div>`).join('') || '<div class="empty">Este deck aún no tiene cartas.</div>'}
    </div>`;

  // Tocar una carta la abre en grande (solo las que tienen imagen)
  const withImg = flat.filter(c => safeImg(c.image));
  const items = withImg.map(c => ({ url: safeImg(c.image_large) || c.image, label: `${c.qty}× ${c.name}${c.card_code ? ` · ${c.card_code}` : ''}` }));
  $app.querySelectorAll('.deck-card').forEach(b => b.addEventListener('click', () => {
    const at = withImg.indexOf(flat[b.dataset.i]);
    if (at >= 0) openLightbox(items, at);
  }));
  document.getElementById('copyList').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(deckToText(d.game, d.cards)); toast('Lista copiada'); }
    catch { prompt('Copia la lista:', deckToText(d.game, d.cards)); }
  });
  document.getElementById('shareDeck')?.addEventListener('click', async () => {
    const url = location.href;
    if (navigator.share) { navigator.share({ title: d.name, url }).catch(() => {}); return; }
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } catch { prompt('Copia el enlace:', url); }
  });
  document.getElementById('delDeck')?.addEventListener('click', async () => {
    if (!confirm(`¿Borrar el deck "${d.name}"? No se puede deshacer.`)) return;
    await api(`/api/decks/${d.id}`, { method: 'DELETE' });
    toast('Deck borrado'); go(can_edit ? '#/decks' : '#/');
  });
}

async function viewDeckEditor(id) {
  if (!requireLogin()) return;
  const deck = id ? (await api(`/api/decks/${id}`)).deck : { name: '', game: 'pokemon', description: '', is_public: false, cards: [] };
  if (id && String(deck.user_id) !== String(currentUser.id)) { $app.innerHTML = '<div class="empty">Este deck no es tuyo.</div>'; return; }
  let cards = deck.cards.map(c => ({ ...c }));
  let game = deck.game;
  let dirty = false;
  let fx = deck.summary?.fx || null;

  // Diseño: datos del deck arriba; buscador a la izquierda; el deck a la derecha (fijo al bajar).
  // En celular el deck se abre como panel desde la barra inferior "Ver mi deck".
  const target = game === 'pokemon' ? 60 : 40;
  $app.innerHTML = `
    <p><a href="${id ? `#/decks/${id}` : '#/decks'}">← ${id ? 'Volver al deck' : 'Mis decks'}</a></p>
    <div class="page-head">
      <div><h1>${id ? 'Editar deck' : 'Nuevo deck'}</h1><p class="muted">Busca cartas y tócalas para agregarlas. Se guarda aunque esté incompleto.</p></div>
      <div class="t-actions only-desktop-flex">
        <a class="btn" href="${id ? `#/decks/${id}` : '#/decks'}" data-cancel>Cancelar</a>
        <button class="btn primary" data-save>${id ? 'Guardar cambios' : 'Guardar deck'}</button>
      </div>
    </div>
    <div class="panel deck-meta">
      <div class="deck-meta-row">
        <div class="field grow"><label>Nombre del deck</label><input id="dName" maxlength="60" value="${esc(deck.name)}" placeholder="ej. Charizard ex · Dragapult"></div>
        <div class="field"><label>Juego</label>
          <div class="segmented" id="dGame">${['pokemon', 'yugioh'].map(g => `<button type="button" class="${game === g ? 'active' : ''}" data-game="${g}">${GAME_LABEL[g]}</button>`).join('')}</div></div>
        <label class="switch"><input type="checkbox" id="dPublic" ${deck.is_public ? 'checked' : ''}><span class="switch-ui"></span>
          <span><b>Público</b><small>Visible con el enlace y en tu perfil</small></span></label>
      </div>
      <details class="manual"><summary>Notas del deck <span class="card-meta">(opcional)</span></summary>
        <textarea id="dDesc" maxlength="1000" rows="2" placeholder="Estrategia, cambios pendientes, para qué torneo…">${esc(deck.description)}</textarea></details>
    </div>

    <div class="builder">
      <section class="panel builder-search">
        <form id="dSearch" class="search-row">
          <input id="dq" type="search" placeholder="Buscar: Charizard ex, Ultra Ball, Dark Magician…" autocomplete="off" aria-label="Buscar cartas">
          <button class="btn primary" type="submit">Buscar</button>
        </form>
        <div class="chips result-filter" id="dFilter"></div>
        <p class="card-meta" id="dHint">Toca una carta para agregar una copia.${game === 'yugioh' ? ' Las de fusión, sincronía, XYZ y link van solas al Extra Deck.' : ''}</p>
        <div class="lookup-results deck-results" id="dResults"></div>
        <details class="manual deck-import">
          <summary>📋 Importar una lista en texto</summary>
          <p class="card-meta">Pega la lista exportada de Pokémon TCG Live (o líneas como "4 Pikachu ex SVI 57" / "3 Dark Magician").
            Las cartas importadas no traen imagen ni precio; puedes reemplazarlas buscándolas.</p>
          <textarea id="dImport" rows="6" placeholder="Pokémon: 12&#10;4 Charmander PAF 7&#10;…"></textarea>
          <button type="button" class="btn small" id="dImportBtn">Agregar al deck</button>
        </details>
      </section>
      <aside class="panel builder-deck" id="deckPanel">
        <div class="deck-panel-head">
          <h2>Tu deck</h2>
          <button type="button" class="btn small only-mobile" id="closeDeck">Cerrar</button>
        </div>
        <div id="dSummary"></div>
        <div id="dList"></div>
        <p class="error" id="dErr"></p>
      </aside>
    </div>

    <div class="deck-dock">
      <button type="button" class="dock-count" id="openDeck"><span id="dockCount">0/${target}</span><small>Ver mi deck</small></button>
      <button type="button" class="btn primary" data-save>${id ? 'Guardar' : 'Guardar deck'}</button>
    </div>`;

  const $list = document.getElementById('dList'), $sum = document.getElementById('dSummary'), $res = document.getElementById('dResults');
  const touch = () => { dirty = true; paint(); };
  const $panel = document.getElementById('deckPanel');
  document.getElementById('openDeck').addEventListener('click', () => { $panel.classList.add('open'); document.body.classList.add('lb-open'); });
  document.getElementById('closeDeck').addEventListener('click', () => { $panel.classList.remove('open'); document.body.classList.remove('lb-open'); });
  window.addEventListener('hashchange', () => document.body.classList.remove('lb-open'), { once: true });

  function paint() {
    const s = deckSummary(game, cards);
    if (fx && s.value_usd) s.value_mxn = Math.round(s.value_usd * fx.rate * 100) / 100;
    $sum.innerHTML = summaryBox(game, s, fx);
    const goal = game === 'pokemon' ? 60 : 40;
    document.getElementById('dockCount').textContent = `${game === 'pokemon' ? s.total : s.counts.main}/${goal}${s.valid ? ' ✔' : ''}`;
    refreshResultBadges();
    const groups = deckGroups(game, cards);
    $list.innerHTML = groups.map(g => `
      <h3 class="deck-group">${esc(g.label)} <span class="muted">(${g.cards.reduce((n, c) => n + c.qty, 0)})</span></h3>
      ${g.cards.map(c => {
        const i = cards.indexOf(c);
        return `
        <div class="deck-row">
          <div class="deck-row-img">${deckThumb(c)}</div>
          <div class="deck-row-name"><b>${esc(c.name)}</b>
            <div class="card-meta">${esc([c.set_name || c.set_code_short, c.card_code].filter(Boolean).join(' · ') || (c.ref_id ? '' : 'importada'))}</div>
            ${game === 'yugioh' ? `<select data-sec="${i}" aria-label="Sección">${SECTIONS.yugioh.map(sec => `<option value="${sec}" ${c.section === sec ? 'selected' : ''}>${SECTION_LABEL[sec]}</option>`).join('')}</select>` : ''}
          </div>
          <div class="qty-ctrl">
            <button type="button" class="btn small" data-dec="${i}" aria-label="Quitar una">−</button>
            <b>${c.qty}</b>
            <button type="button" class="btn small" data-inc="${i}" aria-label="Agregar una">+</button>
            <button type="button" class="btn small danger" data-rm="${i}" aria-label="Quitar del deck">✕</button>
          </div>
        </div>`;
      }).join('')}`).join('') || '<div class="empty small">Tu deck está vacío. Busca cartas a la izquierda o importa una lista.</div>';
  }

  $list.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.inc) { const c = cards[b.dataset.inc]; c.qty = Math.min(MAX_QTY, c.qty + 1); }
    else if (b.dataset.dec) { const c = cards[b.dataset.dec]; c.qty -= 1; if (c.qty < 1) cards.splice(b.dataset.dec, 1); }
    else if (b.dataset.rm) cards.splice(b.dataset.rm, 1);
    else return;
    touch();
  });
  $list.addEventListener('change', (e) => {
    if (e.target.dataset.sec === undefined) return;
    cards[e.target.dataset.sec].section = e.target.value;
    cards = mergeCards(cards); touch();
  });

  // Cambiar de juego vacía el deck (las cartas de un juego no sirven en el otro)
  document.getElementById('dGame').addEventListener('click', (e) => {
    const b = e.target.closest('[data-game]'); if (!b || b.dataset.game === game) return;
    if (cards.length && !confirm('Cambiar de juego vacía el deck. ¿Continuar?')) return;
    game = b.dataset.game; cards = []; found = []; catFilter = ''; $res.innerHTML = ''; renderFilter();
    document.querySelectorAll('#dGame button').forEach(t => t.classList.toggle('active', t === b));
    document.getElementById('dHint').textContent = 'Toca una carta para agregar una copia.' +
      (game === 'yugioh' ? ' Las de fusión, sincronía, XYZ y link van solas al Extra Deck.' : '');
    touch();
  });

  // Búsqueda (mismo buscador que al vender: páginas con "Ver más"), con filtro por tipo de carta
  let found = [], query = '', source = '', hasMore = false, lastPage = 1, catFilter = '';
  const FILTERS = { pokemon: ['pokemon', 'trainer', 'energy'], yugioh: ['monster', 'spell', 'trap', 'extra'] };
  const inDeck = (refId) => cards.filter(c => c.ref_id && c.ref_id === refId).reduce((n, c) => n + c.qty, 0);

  function renderFilter() {
    const cats = FILTERS[game].filter(k => found.some(r => r.category === k));
    document.getElementById('dFilter').innerHTML = cats.length > 1
      ? [['', 'Todas'], ...cats.map(k => [k, CATEGORY_LABEL[k]])].map(([k, t]) =>
          `<button type="button" class="chip ${catFilter === k ? 'active' : ''}" data-cat="${k}">${t}</button>`).join('')
      : '';
  }
  function renderResults() {
    const list = found.map((c, i) => [c, i]).filter(([c]) => !catFilter || c.category === catFilter);
    $res.innerHTML = found.length ? `
      <div class="lookup-count muted">${list.length}${hasMore && !catFilter ? '+' : ''} resultado(s)</div>
      ${list.map(([c, i]) => `
        <div class="result-card" data-ref="${esc(c.ref_id)}">
          <button type="button" class="rc-add" data-add="${i}" title="Agregar ${esc(c.card_name)}">
            ${safeImg(c.image_small || c.image_url) ? `<img src="${esc(c.image_small || c.image_url)}" alt="" loading="lazy">` : '<span class="no-img">✦</span>'}
            <span class="rc-qty" hidden></span>
            <span class="rc-plus">＋</span>
          </button>
          <div class="rc-info"><b class="one-line">${esc(c.card_name)}</b>
            <div class="muted one-line">${esc([c.set_name, c.card_code].filter(Boolean).join(' · '))}</div></div>
          <button type="button" class="rc-minus" data-sub="${i}" aria-label="Quitar una" hidden>−</button>
        </div>`).join('')}
      ${hasMore ? `<button type="button" class="btn small more" data-more="${lastPage + 1}">Ver más resultados</button>` : ''}`
      : '<div class="lookup-count muted">Sin resultados. Prueba con el nombre en inglés o con el número de la carta.</div>';
    refreshResultBadges();
  }
  // Cuántas copias de cada resultado ya están en el deck (insignia y botón "−")
  function refreshResultBadges() {
    $res.querySelectorAll('.result-card').forEach(el => {
      const n = inDeck(el.dataset.ref);
      const q = el.querySelector('.rc-qty');
      q.hidden = !n; q.textContent = `×${n}`;
      el.querySelector('.rc-minus').hidden = !n;
      el.classList.toggle('in-deck', n > 0);
    });
  }
  async function search(page) {
    if (page === 1) { found = []; catFilter = ''; $res.innerHTML = '<div class="lookup-count muted">Buscando…</div>'; renderFilter(); }
    try {
      const qs = new URLSearchParams({ game, q: query, page, ...(page > 1 && source ? { source } : {}) });
      const r = await api(`/api/lookup?${qs}`);
      if (page === 1) source = r.source || '';
      if (r.fx) fx = r.fx;
      const seen = new Set(found.map(x => x.ref_id));
      found.push(...r.results.filter(x => !seen.has(x.ref_id)));
      hasMore = r.has_more; lastPage = page;
      renderFilter(); renderResults();
    } catch (err) { $res.innerHTML = `<div class="lookup-count error">${esc(err.message)}</div>`; }
  }
  document.getElementById('dSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    query = document.getElementById('dq').value.trim();
    if (query.length < 2) { toast('Escribe al menos 2 letras'); return; }
    search(1);
  });
  document.getElementById('dFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    catFilter = b.dataset.cat; renderFilter(); renderResults();
  });
  $res.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { more.disabled = true; more.textContent = 'Cargando…'; search(Number(more.dataset.more)); return; }
    const sub = e.target.closest('[data-sub]');
    if (sub) {
      const r = found[sub.dataset.sub];
      const c = [...cards].reverse().find(x => x.ref_id === r.ref_id);
      if (c) { c.qty -= 1; if (c.qty < 1) cards.splice(cards.indexOf(c), 1); touch(); }
      return;
    }
    const b = e.target.closest('[data-add]'); if (!b) return;
    const r = found[b.dataset.add];
    const section = game === 'yugioh' && r.category === 'extra' ? 'extra' : 'main';
    const existing = cards.find(c => c.ref_id && c.ref_id === r.ref_id && c.section === section);
    if (existing) existing.qty = Math.min(MAX_QTY, existing.qty + 1);
    else cards.push({
      ref_id: r.ref_id, name: r.card_name, set_name: r.set_name, card_code: r.card_code, set_code_short: '',
      image: r.image_small || r.image_url, image_large: r.image_url, category: r.category || '', basic_energy: !!r.basic_energy,
      section, qty: 1, price_usd: r.market_price || 0,
    });
    const card = b.closest('.result-card');
    card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
    touch();
  });

  document.getElementById('dImportBtn').addEventListener('click', () => {
    const parsed = parseDeckText(game, document.getElementById('dImport').value);
    if (!parsed.length) { toast('No se reconoció ninguna línea ("4 Nombre de la carta")'); return; }
    cards = mergeCards([...cards, ...parsed]);
    document.getElementById('dImport').value = '';
    toast(`${parsed.reduce((n, c) => n + c.qty, 0)} cartas importadas`); touch();
  });

  ['dName', 'dDesc'].forEach(k => document.getElementById(k).addEventListener('input', () => { dirty = true; }));
  document.getElementById('dPublic').addEventListener('change', () => { dirty = true; });
  document.querySelectorAll('[data-cancel]').forEach(a => a.addEventListener('click', (e) => {
    if (dirty && !confirm('Tienes cambios sin guardar. ¿Salir sin guardar?')) e.preventDefault();
  }));
  document.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', async () => {
    const err = document.getElementById('dErr');
    const btns = document.querySelectorAll('[data-save]');
    btns.forEach(b => (b.disabled = true)); err.textContent = '';
    try {
      const body = { name: document.getElementById('dName').value, game, description: document.getElementById('dDesc').value,
                     is_public: document.getElementById('dPublic').checked, cards };
      const { deck: saved } = await api(id ? `/api/decks/${id}` : '/api/decks', { method: id ? 'PUT' : 'POST', body });
      dirty = false; document.body.classList.remove('lb-open');
      toast(id ? 'Deck guardado' : '¡Deck creado!'); go(`#/decks/${saved.id}`);
    } catch (e2) {
      err.textContent = e2.message; toast(e2.message);
      btns.forEach(b => (b.disabled = false));
      if (!document.getElementById('dName').value.trim()) document.getElementById('dName').focus();
    }
  }));

  paint();
}

// ---------- Competitivo: metajuego, torneos y registro de partidas ----------

// Paleta categórica validada (orden fijo; ver guía de gráficas) para series sobre fondo claro
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
let metaCache = null, metaCacheAt = 0;
async function loadMeta() {
  if (metaCache && Date.now() - metaCacheAt < 5 * 60e3) return metaCache;
  metaCache = await api('/api/meta'); metaCacheAt = Date.now();
  return metaCache;
}

function compNav(active, game) {
  game = game || localStorage.getItem('compGame') || 'pokemon';
  localStorage.setItem('compGame', game);
  const tabs = game === 'yugioh'
    ? [['meta', '#/competitivo/yugioh', '📊 Metajuego'], ['torneos', '#/competitivo/yugioh/torneos', '🏟️ Torneos'],
       ['cartas', '#/competitivo/cartas?juego=yugioh', '🃏 Cartas más usadas']]
    : [['meta', '#/competitivo', '📊 Metajuego'], ['oficiales', '#/competitivo/oficiales', '🏟️ Oficiales'],
       ['online', '#/competitivo/online', '🌐 Online'], ['cartas', '#/competitivo/cartas?juego=pokemon', '🃏 Cartas más usadas']];
  tabs.push(['locales', '#/torneos', '⚔️ Torneos locales'], ['partidas', '#/partidas', '📝 Mis partidas']);
  return `<div class="comp-top">
    <div class="game-switch" role="tablist" aria-label="Juego">
      <a role="tab" class="${game === 'pokemon' ? 'active pk' : ''}" href="#/competitivo">Pokémon</a>
      <a role="tab" class="${game === 'yugioh' ? 'active yg' : ''}" href="#/competitivo/yugioh">Yu-Gi-Oh!</a>
    </div>
    <nav class="comp-nav" aria-label="Competitivo">${tabs.map(([k, h, t]) => `<a class="${active === k ? 'active' : ''}" href="${h}">${t}</a>`).join('')}</nav>
  </div>`;
}

// Íconos de Pokémon de un deck (sprites de PokeAPI resueltos en el servidor)
function deckIcons(deck, sprites = {}) {
  const icons = (deck.icons || []).slice(0, 2);
  if (!icons.length) return `<span class="deck-ico fallback">${esc((deck.name || '?')[0])}</span>`;
  return `<span class="deck-icons">${icons.map(i => sprites[i] ? `<img src="${esc(sprites[i])}" alt="${esc(i)}" loading="lazy">`
    : `<span class="deck-ico fallback" title="${esc(i)}">${esc(i[0].toUpperCase())}</span>`).join('')}</span>`;
}
const pct = (n, d = 1) => (n == null ? '—' : `${Number(n).toFixed(d)}%`);
function trendBadge(t) {
  if (t == null) return '<span class="trend flat">—</span>';
  if (Math.abs(t) < 0.5) return `<span class="trend flat" title="Sin cambio relevante">→ ${t > 0 ? '+' : ''}${t.toFixed(1)}</span>`;
  return t > 0 ? `<span class="trend up" title="Sube en las últimas 2 semanas">▲ +${t.toFixed(1)}</span>`
               : `<span class="trend down" title="Baja en las últimas 2 semanas">▼ ${t.toFixed(1)}</span>`;
}
const fmtShort = (d) => new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });

// Gráfica de líneas en SVG con leyenda, etiquetas al final de cada línea y tooltip con cruz al pasar el cursor
function lineChart(id, { labels, series, yFmt = v => `${v}%`, height = 260, yMax = null }) {
  const W = 760, H = height, L = 40, R = 150, T = 14, B = 30;
  const max = Math.max(5, ...series.flatMap(s => s.values.filter(v => v != null)));
  const top = yMax || Math.ceil(max / 5) * 5;
  const x = i => L + (labels.length < 2 ? 0 : i * (W - L - R) / (labels.length - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  const ticks = [0, top / 2, top];
  const path = vals => vals.map((v, i) => v == null ? '' : `${i && vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  // Etiquetas finales sin encimarse (separación mínima 13 px)
  const ends = series.map((s, k) => ({ k, v: s.values[s.values.length - 1] ?? 0 })).sort((a, b) => y(a.v) - y(b.v));
  let lastY = -99; ends.forEach(e => { e.y = Math.max(y(e.v), lastY + 13); lastY = e.y; });
  const svg = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Uso semanal de los decks principales">
      ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${yFmt(t)}</text>`).join('')}
      ${labels.map((lb, i) => (i % Math.ceil(labels.length / 7) === 0 || i === labels.length - 1)
        ? `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(lb)}</text>` : '').join('')}
      ${series.map((s, k) => `<path d="${path(s.values)}" fill="none" stroke="${SERIES[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
      ${ends.map(e => `<text x="${W - R + 8}" y="${e.y + 4}" class="end-label"><tspan fill="${SERIES[e.k]}">●</tspan> ${esc(series[e.k].name.length > 19 ? series[e.k].name.slice(0, 18) + '…' : series[e.k].name)}</text>`).join('')}
      <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      ${series.map((s, k) => `<circle class="dot" data-k="${k}" r="4.5" fill="${SERIES[k]}" stroke="#fffaf2" stroke-width="2" visibility="hidden"/>`).join('')}
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
    </svg>
    <div class="chart-tip" hidden></div>`;
  requestAnimationFrame(() => {
    const host = document.getElementById(id); if (!host) return;
    const el = host.querySelector('svg'), tip = host.querySelector('.chart-tip');
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      const px = (ev.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(labels.length - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, labels.length - 1)))));
      el.querySelector('.cross').setAttribute('x1', x(i)); el.querySelector('.cross').setAttribute('x2', x(i));
      el.querySelector('.cross').setAttribute('visibility', 'visible');
      el.querySelectorAll('.dot').forEach(d => {
        const v = series[d.dataset.k].values[i];
        d.setAttribute('visibility', v == null ? 'hidden' : 'visible');
        if (v != null) { d.setAttribute('cx', x(i)); d.setAttribute('cy', y(v)); }
      });
      const rows = series.map((s, k) => [s.name, s.values[i], k]).filter(r => r[1] != null).sort((a, b) => b[1] - a[1]);
      tip.innerHTML = `<b>${esc(labels[i])}</b>${rows.map(([n, v, k]) => `<div><span style="color:${SERIES[k]}">●</span> ${esc(n)} <b>${yFmt(v)}</b></div>`).join('')}`;
      tip.hidden = false;
      const left = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(r.width - 190, Math.max(0, left + 12))}px`;
    };
    el.querySelector('.hit').addEventListener('pointermove', move);
    el.querySelector('.hit').addEventListener('pointerleave', () => {
      tip.hidden = true; el.querySelector('.cross').setAttribute('visibility', 'hidden');
      el.querySelectorAll('.dot').forEach(d => d.setAttribute('visibility', 'hidden'));
    });
  });
  return `<div class="chart" id="${id}">${svg}</div>
    <div class="chart-legend">${series.map((s, k) => `<span><i style="background:${SERIES[k]}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

async function viewMeta(params) {
  const src = ['oficial', 'online', 'macai'].includes(params.get('fuente')) ? params.get('fuente') : 'oficial';
  const m = await loadMeta();
  const data = src === 'oficial' ? m.official : src === 'online' ? m.online : m.macai;
  const sprites = m.sprites || {};
  const decks = data.decks || [];
  const risers = decks.filter(d => d.trend != null && d.players >= 10).sort((a, b) => b.trend - a.trend).slice(0, 4);
  const fallers = decks.filter(d => d.trend != null && d.players >= 10).sort((a, b) => a.trend - b.trend).slice(0, 4);
  const top6 = decks.slice(0, 6);
  const weeks = (data.weeks || []).slice(-10);
  const srcLabel = { oficial: 'Torneos oficiales', online: 'Torneos online (Limitless)', macai: 'Torneos de Macai TCG' }[src];

  $app.innerHTML = `
    ${compNav('meta', 'pokemon')}
    <div class="page-head">
      <div><h1>📊 Metajuego de Pokémon TCG</h1>
        <p class="muted">Formato Estándar · actualizado ${new Date(m.updated_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}
          ${m.partial || m.stale ? ' · <span class="warn-text">algunos datos no se pudieron actualizar</span>' : ''}</p></div>
      <div class="segmented dark" id="srcSel">
        ${[['oficial', 'Oficiales'], ['online', 'Online'], ['macai', 'Macai']].map(([k, t]) => `<button type="button" class="${src === k ? 'active' : ''}" data-src="${k}">${t}</button>`).join('')}
      </div>
    </div>

    <div class="stat-tiles">
      <div class="stat-tile"><span>Torneos analizados</span><b>${data.events || 0}</b><small>${esc(srcLabel)}</small></div>
      <div class="stat-tile"><span>Jugadores con deck conocido</span><b>${(data.total || 0).toLocaleString('es-MX')}</b><small>${src === 'oficial' ? 'Regionales, Internacionales y Special Events' : src === 'online' ? `últimas 4 semanas, torneos de ${24}+ jugadores` : 'decks registrados al inscribirse'}</small></div>
      <div class="stat-tile"><span>Deck más jugado</span><b class="tile-deck">${decks[0] ? `${deckIcons(decks[0], sprites)} ${esc(decks[0].name)}` : '—'}</b><small>${decks[0] ? `${pct(decks[0].share)} de los jugadores` : ''}</small></div>
      <div class="stat-tile"><span>El que más sube</span><b class="tile-deck">${risers[0] && risers[0].trend > 0 ? `${deckIcons(risers[0], sprites)} ${esc(risers[0].name)}` : '—'}</b><small>${risers[0] && risers[0].trend > 0 ? `+${risers[0].trend.toFixed(1)} puntos en 2 semanas` : 'sin datos suficientes'}</small></div>
    </div>

    ${src !== 'macai' ? `
    <section class="panel">
      <div class="panel-title"><h2>🔮 Predicción para los próximos torneos</h2>
        <span class="card-meta">Combina oficiales (peso doble) y online, con más peso a lo reciente</span></div>
      <div class="pred-grid">${(m.predictions || []).slice(0, 8).map((p, i) => `
        <div class="pred-card ${p.outlook}">
          <span class="pred-rank">${i + 1}</span>
          ${deckIcons(p, sprites)}
          <div class="pred-info"><b class="one-line">${esc(p.name)}</b>
            <span class="card-meta">Uso esperado <b>${pct(p.predicted)}</b> · ahora ${pct(p.share)}</span>
            <span class="pred-tags">
              ${p.outlook === 'up' ? '<span class="trend up">▲ Al alza</span>' : p.outlook === 'down' ? '<span class="trend down">▼ A la baja</span>' : '<span class="trend flat">→ Estable</span>'}
              ${p.strength >= 1.15 ? '<span class="tag-strong" title="Llega al top cut más de lo que su uso haría esperar">💪 Convierte bien</span>' : p.strength <= 0.85 ? '<span class="tag-weak" title="Llega al top cut menos de lo esperado">Convierte poco</span>' : ''}
            </span></div>
        </div>`).join('')}</div>
      <details class="manual method"><summary>¿Cómo se calcula?</summary>
        <p class="card-meta">Para cada familia de deck: <b>1)</b> su uso en los torneos recientes, donde cada torneo pesa menos mientras más viejo es (la mitad cada 10 días) y los oficiales cuentan el doble;
        <b>2)</b> la tendencia de las últimas semanas (si sube o baja de forma constante); <b>3)</b> su fuerza: qué tanto llega al top cut (12.5 % mejor) comparado con lo que su uso haría esperar.
        Es una estimación estadística para prepararte, no una certeza: un deck nuevo o un cambio de cartas puede moverlo todo.</p></details>
    </section>` : ''}

    ${src !== 'macai' && risers.length ? `
    <div class="two-cols">
      <section class="panel"><h2 class="panel-h">▲ En ascenso</h2>${moverList(risers, sprites)}</section>
      <section class="panel"><h2 class="panel-h">▼ En caída</h2>${moverList(fallers, sprites)}</section>
    </div>` : ''}

    ${weeks.length >= 2 && top6.length ? `
    <section class="panel">
      <div class="panel-title"><h2>Uso semanal de los 6 decks principales</h2><span class="card-meta">% de jugadores por semana · ${esc(srcLabel)}</span></div>
      ${lineChart('metaChart', { labels: weeks.map(fmtShort), series: top6.map(d => ({ name: d.name, values: weeks.map(w => d.weekly.find(p => p.week === w)?.share ?? null) })) })}
    </section>` : ''}

    ${src !== 'macai' && m.online?.matchups?.decks?.length ? matchupMatrix({ decks: m.online.matchups.decks, cells: m.online.matchups.cells,
      keyOf: d => d.key, iconOf: d => deckIcons(d, sprites), note: 'Partidas de torneos online de Limitless (sin espejos) · pasa el cursor para ver el detalle' }) : ''}

    <section class="panel">
      <div class="panel-title"><h2>Ranking de decks</h2>
        <input type="search" id="deckFilter" class="mini-search" placeholder="Filtrar deck…" aria-label="Filtrar deck"></div>
      ${decks.length ? `<div class="table-wrap"><table class="meta-table">
        <thead><tr><th>#</th><th>Deck</th><th>Uso</th><th title="Cambio de uso: últimas 2 semanas contra las 2 anteriores">Tendencia</th>
          ${src === 'oficial' ? '<th title="% de sus jugadores que llegaron al top cut (12.5 % mejor)">Conversión</th><th>Top 8</th><th>🏆</th>'
            : '<th title="Victorias ÷ partidas (empate = 1/3)">Win rate</th><th>Top 8</th><th>🏆</th>'}</tr></thead>
        <tbody>${decks.slice(0, 40).map((d, i) => `
          <tr data-name="${esc(d.name.toLowerCase())}">
            <td class="rank">${i + 1}</td>
            <td><div class="deck-cell">${deckIcons(d, sprites)}<b>${esc(d.name)}</b></div></td>
            <td class="share-cell"><span class="share-bar"><i style="width:${Math.min(100, d.share * (100 / Math.max(1, decks[0].share)))}%"></i></span>${pct(d.share)}<small> · ${d.players}</small></td>
            <td>${trendBadge(d.trend)}</td>
            <td>${src === 'oficial' ? pct(d.conversion) : d.winrate != null ? pct(d.winrate) : '—'}</td>
            <td>${d.top8 || 0}</td><td>${d.wins1st || 0}</td>
          </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty small">${src === 'macai' ? 'Aún no hay torneos de la página con decks registrados. Cuando te inscribas a un torneo, registra con qué deck juegas.' : 'Sin datos por ahora.'}</div>`}
      <p class="card-meta source-note">Fuente: ${src === 'macai' ? 'torneos organizados en Macai TCG.' : `<a href="https://limitlesstcg.com" target="_blank" rel="noopener">Limitless TCG</a> (${src === 'oficial' ? 'resultados de eventos oficiales Play! Pokémon' : 'torneos online en play.limitlesstcg.com'}).`}</p>
    </section>`;

  document.getElementById('srcSel').addEventListener('click', e => {
    const b = e.target.closest('[data-src]'); if (b) go(`#/competitivo?fuente=${b.dataset.src}`);
  });
  document.getElementById('deckFilter')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $app.querySelectorAll('.meta-table tbody tr').forEach(tr => { tr.hidden = q && !tr.dataset.name.includes(q); });
  });
}

// % de victorias de cada deck (fila) contra cada rival (columna). Verde = favorable, rojo = desfavorable.
// Con pocas partidas el número se atenúa (menos confiable).
function matchupMatrix({ decks, cells, keyOf, iconOf, minGames = 10, note }) {
  if (!decks?.length) return '';
  const cell = (a, b) => {
    if (keyOf(a) === keyOf(b)) return '<td class="mu mirror" title="Espejo">—</td>';
    const c = cells?.[keyOf(a)]?.[keyOf(b)];
    if (!c) return '<td class="mu none">·</td>';
    const diff = c.wr - 50;
    const tone = Math.abs(diff) < 3 ? 'even' : diff > 0 ? (diff >= 10 ? 'good2' : 'good') : (diff <= -10 ? 'bad2' : 'bad');
    return `<td class="mu ${tone}${c.games < minGames ? ' low' : ''}" title="${esc(a.name)} contra ${esc(b.name)}: ${c.wr}% en ${c.games} partidas${c.first != null ? ` · yendo 1.º ${c.first}% / 2.º ${c.second}%` : ''}">
      <b>${Math.round(c.wr)}%</b><small>${c.games}</small></td>`;
  };
  return `
    <section class="panel">
      <div class="panel-title"><h2>⚔️ Enfrentamientos: % de victorias</h2><span class="card-meta">${note}</span></div>
      <div class="table-wrap"><table class="mu-table">
        <thead><tr><th class="mu-corner">Deck ＼ Rival</th>${decks.map(b => `<th title="${esc(b.name)}"><div class="mu-head">${iconOf(b)}<span>${esc(b.name)}</span></div></th>`).join('')}</tr></thead>
        <tbody>${decks.map(a => `<tr><th class="mu-row"><div class="deck-cell">${iconOf(a)}<b>${esc(a.name)}</b></div></th>${decks.map(b => cell(a, b)).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p class="card-meta mu-legend"><span class="mu-chip good2"></span> muy favorable (60 %+) <span class="mu-chip good"></span> favorable <span class="mu-chip even"></span> parejo <span class="mu-chip bad"></span> desfavorable <span class="mu-chip bad2"></span> muy desfavorable (40 % o menos) · número pequeño = partidas · atenuado = menos de ${minGames} partidas</p>
    </section>`;
}

const moverList = (list, sprites) => `<ul class="movers">${list.map(d => `
  <li>${deckIcons(d, sprites)}<span class="one-line">${esc(d.name)}</span>${trendBadge(d.trend)}<small>${pct(d.recent_share ?? d.share)}</small></li>`).join('')}</ul>`;

async function viewCompEvents(kind) {
  const m = await loadMeta();
  const data = kind === 'oficiales' ? m.official : m.online;
  const sprites = m.sprites || {};
  $app.innerHTML = `
    ${compNav(kind, 'pokemon')}
    <div class="page-head"><div>
      <h1>${kind === 'oficiales' ? '🏟️ Torneos oficiales recientes' : '🌐 Torneos online recientes'}</h1>
      <p class="muted">${kind === 'oficiales' ? 'Regionales, Internacionales y Special Events de Play! Pokémon (formato Estándar).' : 'Torneos de 24 jugadores o más en Limitless (últimas 4 semanas).'}</p></div></div>
    <div class="event-list">${(data.list || []).map(ev => `
      <article class="panel event-card">
        <div class="event-head">
          <div><h2>${ev.country ? `<span class="flag-chip">${esc(ev.country)}</span> ` : ''}${esc(ev.name)}</h2>
            <span class="card-meta">📅 ${fmtShort(ev.date)} · 👥 ${Number(ev.players).toLocaleString('es-MX')} jugadores</span></div>
        </div>
        <ol class="top8">${ev.top.map(s => `
          <li class="${s.placing === 1 ? 'champ' : ''}"><span class="place">${s.placing === 1 ? '🏆' : s.placing}</span>${deckIcons(s.deck, sprites)}
            <span class="one-line"><b>${esc(s.deck.name)}</b><small>${esc(s.name)}${s.record ? ` · ${s.record.wins}-${s.record.losses}-${s.record.ties}` : ''}</small></span></li>`).join('')}</ol>
        ${ev.url ? `<a class="event-link" href="${esc(ev.url)}" target="_blank" rel="noopener">Ver resultados en Limitless <b>↗</b></a>` : ''}
      </article>`).join('') || '<div class="empty">Sin torneos por ahora.</div>'}</div>
    <p class="card-meta source-note">Fuente: <a href="https://limitlesstcg.com" target="_blank" rel="noopener">Limitless TCG</a>.</p>`;
}

// ---------- Competitivo: Yu-Gi-Oh! y cartas más usadas ----------

let ygoCache = null, ygoCacheAt = 0;
async function loadYgo() {
  if (ygoCache && Date.now() - ygoCacheAt < 5 * 60e3) return ygoCache;
  ygoCache = await api('/api/meta/yugioh'); ygoCacheAt = Date.now();
  return ygoCache;
}
const cardsCache = {};
async function loadCards(game) {
  const c = cardsCache[game];
  if (c && Date.now() - c.at < 5 * 60e3) return c.data;
  const data = await api(`/api/meta/cards?game=${game}`);
  cardsCache[game] = { data, at: Date.now() };
  return data;
}

// Imagen de una carta de Yu-Gi-Oh! (guardada en nuestro almacenamiento) o una inicial si aún no está
const ygoFace = (id, images, name = '?') => (id && images?.[id]
  ? `<img class="ygo-face" src="${esc(images[id])}" alt="" loading="lazy">`
  : `<span class="deck-ico fallback">${esc(String(name)[0] || '?')}</span>`);
const tierBadge = t => (t ? `<span class="tier t${t}">Tier ${t}</span>` : '<span class="tier">—</span>');

async function viewYgoMeta(params) {
  const src = params.get('fuente') === 'torneos' ? 'torneos' : 'ladder';
  const m = await loadYgo();
  const img = m.images || {};
  const L = m.omega_ladder || { decks: [] }, D = m.omega_daily || { decks: [], list: [] }, T = m.tournaments || { decks: [], list: [] };
  const srcLabel = { ladder: 'Ladder TCG de YGO Omega', torneos: 'Torneos oficiales (YGOPRODeck)' }[src];

  let body = '';
  if (src === 'ladder') {
    const decks = L.decks || [];
    const tiers = [1, 2, 3].map(t => ({ t, list: decks.filter(d => d.tier === t) })).filter(g => g.list.length);
    const bestWr = decks.filter(d => d.games >= 2000).sort((a, b) => (b.winrate ?? 0) - (a.winrate ?? 0))[0];
    body = `
      <div class="stat-tiles">
        <div class="stat-tile"><span>Arquetipos analizados</span><b>${decks.length}</b><small>ladder TCG · rating Oro o más</small></div>
        <div class="stat-tile"><span>Más jugado</span><b class="tile-deck">${decks[0] ? `${ygoFace(decks[0].face, img, decks[0].name)} ${esc(decks[0].name)}` : '—'}</b><small>${decks[0] ? `${pct(decks[0].share)} de las partidas` : ''}</small></div>
        <div class="stat-tile"><span>Mejor win rate</span><b class="tile-deck">${bestWr ? `${ygoFace(bestWr.face, img, bestWr.name)} ${esc(bestWr.name)}` : '—'}</b><small>${bestWr ? `${pct(bestWr.winrate)} esperado` : ''}</small></div>
        <div class="stat-tile"><span>Ventaja de ir primero</span><b>${decks[0]?.first_wr != null ? `+${(decks[0].first_wr - decks[0].second_wr).toFixed(0)} pts` : '—'}</b><small>${decks[0] ? `${esc(decks[0].name)}: ${pct(decks[0].first_wr, 0)} vs ${pct(decks[0].second_wr, 0)} (juego 1)` : ''}</small></div>
      </div>
      ${tiers.length ? `<section class="panel"><div class="panel-title"><h2>🏅 Tier list</h2><span class="card-meta">Según la fuerza estadística en la ladder (win rate ajustado por el nivel de los rivales)</span></div>
        ${tiers.map(g => `<div class="tier-row"><div class="tier-label t${g.t}">T${g.t}</div><div class="tier-decks">${g.list.map(d => `
          <div class="tier-deck" title="${esc(d.name)}">${ygoFace(d.face, img, d.name)}<b class="one-line">${esc(d.name)}</b><small>${pct(d.share)} · WR ${pct(d.winrate)}</small></div>`).join('')}</div></div>`).join('')}
      </section>` : ''}
      ${L.matchups?.decks?.length ? matchupMatrix({ decks: L.matchups.decks, cells: L.matchups.cells, keyOf: d => d.name,
        iconOf: d => ygoFace(d.face, img, d.name), minGames: 30, note: 'Partidas de la ladder TCG de YGO Omega (8 arquetipos principales) · incluye % yendo primero y segundo' }) : ''}
      <section class="panel"><div class="panel-title"><h2>Ranking de arquetipos</h2><input type="search" id="deckFilter" class="mini-search" placeholder="Filtrar…" aria-label="Filtrar arquetipo"></div>
        <div class="table-wrap"><table class="meta-table"><thead><tr><th>#</th><th>Arquetipo</th><th>Uso</th><th>Tier</th>
          <th title="Win rate esperado (intervalo 95 %)">Win rate</th><th title="Juego 1 yendo primero / segundo">1.º / 2.º</th><th>Partidas</th></tr></thead>
        <tbody>${decks.map((d, i) => `<tr data-name="${esc(d.name.toLowerCase())}"><td class="rank">${i + 1}</td>
          <td><div class="deck-cell">${ygoFace(d.face, img, d.name)}<b>${esc(d.name)}</b></div></td>
          <td class="share-cell"><span class="share-bar"><i style="width:${Math.min(100, d.share * 100 / Math.max(1, decks[0].share))}%"></i></span>${pct(d.share)}</td>
          <td>${tierBadge(d.tier)}</td>
          <td>${pct(d.winrate)}<small class="muted"> ${d.wr_lo != null ? `(${d.wr_lo}–${d.wr_hi})` : ''}</small></td>
          <td>${pct(d.first_wr, 0)} / ${pct(d.second_wr, 0)}</td>
          <td>${Number(d.games || 0).toLocaleString('es-MX')}</td></tr>`).join('')}</tbody></table></div>
        <p class="card-meta source-note">Fuente: <a href="https://omega.duelistsunite.org/statistics?ladder=tcg" target="_blank" rel="noopener">estadísticas de YGO Omega</a>${L.built_at ? ` (calculadas el ${new Date(L.built_at).toLocaleDateString('es-MX')})` : ''}.</p>
      </section>`;
  } else {
    const decks = (src === 'diarios' ? D.decks : T.decks) || [];
    body = `
      <div class="stat-tiles">
        <div class="stat-tile"><span>${src === 'diarios' ? 'Torneos diarios' : 'Listas de torneo'}</span><b>${src === 'diarios' ? D.events : T.lists}</b><small>${src === 'diarios' ? `${D.total} jugadores` : 'WCQ Regionales, YCS y más (top de cada evento)'}</small></div>
        <div class="stat-tile"><span>Más jugado</span><b class="tile-deck">${decks[0] ? `${ygoFace(decks[0].face || decks[0].cover, img, decks[0].name)} ${esc(decks[0].name)}` : '—'}</b><small>${decks[0] ? pct(decks[0].share) : ''}</small></div>
        <div class="stat-tile"><span>Más campeonatos</span><b class="tile-deck">${(() => { const w = [...decks].sort((a, b) => b.wins1st - a.wins1st || b.wins - a.wins)[0]; return w ? `${ygoFace(w.face || w.cover, img, w.name)} ${esc(w.name)}` : '—'; })()}</b><small>&nbsp;</small></div>
        <div class="stat-tile"><span>${src === 'torneos' ? 'El que más sube' : 'Arquetipos distintos'}</span><b class="tile-deck">${src === 'torneos'
          ? (() => { const r = decks.filter(d => d.lists >= 3).sort((a, b) => b.trend - a.trend)[0]; return r ? `${ygoFace(r.cover, img, r.name)} ${esc(r.name)}` : '—'; })() : decks.length}</b><small>&nbsp;</small></div>
      </div>
      <section class="panel"><div class="panel-title"><h2>Uso por arquetipo</h2><input type="search" id="deckFilter" class="mini-search" placeholder="Filtrar…" aria-label="Filtrar arquetipo"></div>
        <div class="table-wrap"><table class="meta-table"><thead><tr><th>#</th><th>Arquetipo</th><th>Uso</th>
          ${src === 'diarios' ? '<th>Win rate</th><th>Top 4</th><th>🏆</th>' : '<th title="Listas recientes contra las anteriores">Tendencia</th><th>Top 4</th><th>🏆</th>'}</tr></thead>
        <tbody>${decks.slice(0, 40).map((d, i) => `<tr data-name="${esc(d.name.toLowerCase())}"><td class="rank">${i + 1}</td>
          <td><div class="deck-cell">${ygoFace(d.face || d.cover, img, d.name)}<b>${esc(d.name)}</b></div></td>
          <td class="share-cell"><span class="share-bar"><i style="width:${Math.min(100, d.share * 100 / Math.max(1, decks[0].share))}%"></i></span>${pct(d.share)}<small> · ${d.players ?? d.lists}</small></td>
          ${src === 'diarios' ? `<td>${d.winrate != null ? pct(d.winrate) : '—'}</td>` : `<td>${trendBadge(d.trend)}</td>`}
          <td>${d.top4 || 0}</td><td>${d.wins1st ?? d.wins ?? 0}</td></tr>`).join('')}</tbody></table></div>
        <p class="card-meta source-note">Fuente: ${src === 'diarios' ? '<a href="https://omega.duelistsunite.org/tournaments" target="_blank" rel="noopener">torneos de YGO Omega</a>' : '<a href="https://ygoprodeck.com/category/format/tournament%20meta%20decks" target="_blank" rel="noopener">Tournament Meta Decks de YGOPRODeck</a>'}.</p>
      </section>`;
  }

  $app.innerHTML = `
    ${compNav('meta', 'yugioh')}
    <div class="page-head">
      <div><h1>⚡ Metajuego de Yu-Gi-Oh!</h1>
        <p class="muted">Formato TCG · actualizado ${new Date(m.updated_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}${m.partial || m.stale ? ' · <span class="warn-text">algunos datos no se pudieron actualizar</span>' : ''}</p></div>
      <div class="segmented dark" id="srcSel">${[['ladder', 'Omega ladder'], ['torneos', 'Torneos oficiales']].map(([k, t]) => `<button type="button" class="${src === k ? 'active' : ''}" data-src="${k}">${t}</button>`).join('')}</div>
    </div>
    ${body}`;
  document.getElementById('srcSel').addEventListener('click', e => { const b = e.target.closest('[data-src]'); if (b) go(`#/competitivo/yugioh?fuente=${b.dataset.src}`); });
  document.getElementById('deckFilter')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $app.querySelectorAll('.meta-table tbody tr').forEach(tr => { tr.hidden = q && !tr.dataset.name.includes(q); });
  });
}

async function viewYgoEvents() {
  const m = await loadYgo();
  const img = m.images || {};
  const T = m.tournaments || { list: [] };
  $app.innerHTML = `
    ${compNav('torneos', 'yugioh')}
    <div class="page-head"><div><h1>🏟️ Torneos de Yu-Gi-Oh!</h1><p class="muted">Tops de torneos oficiales (WCQ Regionales, YCS) con la lista de cada jugador.</p></div></div>
    
    <div class="event-list">${(T.list || []).map(ev => `
      <article class="panel event-card">
        <div class="event-head"><div><h2>${esc(ev.name)}</h2><span class="card-meta">${ev.players ? `👥 ${ev.players} jugadores` : ''}</span></div></div>
        <ol class="top8">${ev.top.map(s => `<li class="${s.place_n === 1 ? 'champ' : ''}"><span class="place">${s.place_n === 1 ? '🏆' : /runner/i.test(s.placing) ? '2' : esc(String(s.placing).replace('Top ', 'T'))}</span>${ygoFace(s.cover, img, s.archetype)}
          <span class="one-line"><b>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.archetype)}</a>` : esc(s.archetype)}</b><small>${esc(s.name || '')}</small></span></li>`).join('')}</ol>
      </article>`).join('') || '<div class="empty small">Sin listas por ahora.</div>'}</div>
    <p class="card-meta source-note">Fuente: <a href="https://ygoprodeck.com" target="_blank" rel="noopener">YGOPRODeck</a> (Tournament Meta Decks).</p>`;
}

// Cartas más usadas: staples, side deck y techs, en general o por arquetipo
const ROLE_LABEL = { core: 'Núcleo', flex: 'Flexible', tech: 'Tech' };
async function viewCardUsage(params) {
  const game = params.get('juego') === 'yugioh' ? 'yugioh' : 'pokemon';
  const data = await loadCards(game);
  const arch = params.get('deck') || '';
  const archetypes = data.archetypes || [];
  const A = archetypes.find(a => (a.key || a.name) === arch) || null;
  const sections = game === 'pokemon'
    ? [['', 'Todas'], ['pokemon', 'Pokémon'], ['trainer', 'Entrenadores'], ['energy', 'Energía']]
    : [['main', 'Main deck'], ['extra', 'Extra deck'], ['side', 'Side deck']];
  const sec = sections.some(([k]) => k === params.get('sec')) ? params.get('sec') : sections[0][0];
  let list;
  if (game === 'pokemon') list = (A ? A.cards : data.overall).filter(c => !sec || c.category === sec);
  else list = (A ? A[sec] : data[sec]) || [];
  const image = c => (game === 'pokemon' ? data.images?.[`${c.set}-${c.number}`] : data.images?.[c.id]) || '';
  const total = A ? A.lists : data.lists;

  $app.innerHTML = `
    ${compNav('cartas', game)}
    <div class="page-head">
      <div><h1>🃏 Cartas más usadas · ${game === 'pokemon' ? 'Pokémon' : 'Yu-Gi-Oh!'}</h1>
        <p class="muted">${A ? `En ${A.lists} listas de <b>${esc(A.name)}</b>` : `En ${total} listas de torneo`} · ${game === 'pokemon' ? 'torneos online de Limitless con listas registradas' : 'Tournament Meta Decks de YGOPRODeck'}</p></div>
    </div>
    <div class="panel usage-filters">
      <div class="field"><label>Deck / arquetipo</label>
        <select id="archSel"><option value="">Todos los decks (staples generales)</option>
          ${archetypes.map(a => `<option value="${esc(a.key || a.name)}" ${(a.key || a.name) === arch ? 'selected' : ''}>${esc(a.name)} (${a.lists} listas)</option>`).join('')}</select></div>
      <div class="field"><label>Sección</label><div class="chips" id="secSel">${sections.map(([k, t]) => `<button type="button" class="chip ${sec === k ? 'active' : ''}" data-sec="${k}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Buscar</label><input type="search" id="cardFilter" placeholder="Nombre de la carta…"></div>
    </div>
    <div class="usage-legend card-meta">
      ${A ? '<span><i class="role core"></i> <b>Núcleo</b>: en 85 % o más de las listas</span><span><i class="role flex"></i> <b>Flexible</b>: 30-85 %</span><span><i class="role tech"></i> <b>Tech</b>: menos de 30 % (opciones para el meta o el side)</span>'
        : game === 'pokemon' ? '<span><b>% de listas</b> que la usan · <b>×</b> copias promedio · <b>Top</b>: % de las listas del top cut que la usan</span>'
        : '<span><b>% de listas</b> que la usan · <b>×</b> copias promedio · <span class="badge staple">Staple</span> la usan muchos arquetipos distintos</span>'}
    </div>
    <div class="usage-grid">${list.map((c, i) => `
      <div class="usage-card" data-name="${esc(c.name.toLowerCase())}">
        <button type="button" class="uc-img" ${image(c) && game === 'pokemon' ? `data-zoom="${esc(image(c).replace('/low.webp', '/high.webp'))}" data-label="${esc(c.name)}"` : ''}>
          ${image(c) ? `<img src="${esc(image(c))}" alt="${esc(c.name)}" loading="lazy">` : `<span class="no-img">${esc(c.name)}</span>`}
          <span class="uc-rank">${i + 1}</span>
          ${c.role ? `<span class="uc-role ${c.role}">${ROLE_LABEL[c.role]}</span>` : c.staple ? '<span class="uc-role staple">Staple</span>' : ''}
        </button>
        <b class="one-line" title="${esc(c.name)}">${esc(c.name)}</b>
        <div class="uc-bar"><i style="width:${Math.min(100, c.pct)}%"></i></div>
        <div class="uc-stats"><span><b>${pct(c.pct, 0)}</b> listas</span><span>×${c.avg}</span>${c.top_pct != null ? `<span title="% de las listas del top cut">Top ${pct(c.top_pct, 0)}</span>` : ''}</div>
      </div>`).join('') || '<div class="empty small">Sin cartas para este filtro.</div>'}</div>
    <p class="card-meta source-note">Fuente: ${game === 'pokemon' ? '<a href="https://play.limitlesstcg.com" target="_blank" rel="noopener">Limitless TCG</a> (listas de torneos online) · imágenes de TCGdex' : '<a href="https://ygoprodeck.com" target="_blank" rel="noopener">YGOPRODeck</a>'}.</p>`;

  const nav = patch => {
    const q = new URLSearchParams({ juego: game, ...(arch ? { deck: arch } : {}), ...(sec ? { sec } : {}), ...patch });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    go(`#/competitivo/cartas?${q}`);
  };
  document.getElementById('archSel').addEventListener('change', e => nav({ deck: e.target.value }));
  document.getElementById('secSel').addEventListener('click', e => { const b = e.target.closest('[data-sec]'); if (b) nav({ sec: b.dataset.sec }); });
  document.getElementById('cardFilter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $app.querySelectorAll('.usage-card').forEach(c => { c.hidden = q && !c.dataset.name.includes(q); });
  });
  const zoomable = [...$app.querySelectorAll('[data-zoom]')];
  zoomable.forEach((b, i) => b.addEventListener('click', () => openLightbox(zoomable.map(x => ({ url: x.dataset.zoom, label: x.dataset.label })), i)));
}

// ---------- Mis partidas ----------

const RES_TXT = { W: 'Victoria', L: 'Derrota', T: 'Empate' };
const winPct = (w, n) => (n ? Math.round(w / n * 100) : null);

function matchStats(list) {
  const n = list.length, w = list.filter(m => m.result === 'W').length, l = list.filter(m => m.result === 'L').length;
  const t = n - w - l;
  const first = list.filter(m => m.went_first === true), second = list.filter(m => m.went_first === false);
  const by = (key) => {
    const map = new Map();
    for (const m of list) { const k = m[key] || 'Sin registrar'; if (!map.has(k)) map.set(k, { k, n: 0, w: 0, l: 0, t: 0 }); const r = map.get(k); r.n++; r[m.result === 'W' ? 'w' : m.result === 'L' ? 'l' : 't']++; }
    return [...map.values()].sort((a, b) => b.n - a.n);
  };
  return {
    n, w, l, t, pct: winPct(w, n),
    first: { n: first.length, pct: winPct(first.filter(m => m.result === 'W').length, first.length) },
    second: { n: second.length, pct: winPct(second.filter(m => m.result === 'W').length, second.length) },
    byMine: by('my_deck'), byOpp: by('opp_deck'),
    mull: list.filter(m => m.source === 'online').reduce((a, m) => a + (m.mulligans_me || 0), 0),
    online: list.filter(m => m.source === 'online').length,
    avgTurns: (() => { const o = list.filter(m => m.turns); return o.length ? Math.round(o.reduce((a, m) => a + m.turns, 0) / o.length) : null; })(),
  };
}
const wlt = r => `${r.w}-${r.l}${r.t ? '-' + r.t : ''}`;
const pctCell = (p, n) => (p == null ? '—' : `<span class="wr ${p >= 55 ? 'good' : p <= 45 ? 'bad' : ''}">${p}%</span>${n != null ? `<small> (${n})</small>` : ''}`);

async function viewMatches(params) {
  if (!requireLogin()) return;
  const { matches: all } = await api('/api/my-matches');
  const src = ['online', 'physical'].includes(params.get('tipo')) ? params.get('tipo') : '';
  const myDeck = params.get('deck') || '';
  const list = all.filter(m => (!src || m.source === src) && (!myDeck || m.my_deck === myDeck));
  const s = matchStats(list);
  const myDecks = [...new Set(all.map(m => m.my_deck).filter(Boolean))];
  // Matriz de enfrentamientos: mis decks × decks rivales (los 6 rivales más frecuentes)
  const opps = s.byOpp.slice(0, 6).map(r => r.k);
  const mine = s.byMine.slice(0, 5).map(r => r.k);
  const cell = (a, b) => { const g = list.filter(m => (m.my_deck || 'Sin registrar') === a && (m.opp_deck || 'Sin registrar') === b);
    const w = g.filter(m => m.result === 'W').length; return g.length ? pctCell(winPct(w, g.length), g.length) : '<span class="muted">·</span>'; };

  $app.innerHTML = `
    ${compNav('partidas')}
    <div class="page-head">
      <div><h1>📝 Mis partidas</h1><p class="muted">Registra tus partidas físicas y las de Pokémon TCG Live para ver tus estadísticas y mejorar.</p></div>
      <div class="t-actions"><a class="btn" href="#/partidas/nueva?tipo=fisica">＋ Partida física</a><a class="btn primary" href="#/partidas/nueva?tipo=online">📋 Importar log online</a></div>
    </div>
    ${all.length ? `
    <form class="filters mini" id="mFilters">
      <select name="tipo"><option value="">Todas las partidas</option><option value="online" ${src === 'online' ? 'selected' : ''}>Online (TCG Live)</option><option value="physical" ${src === 'physical' ? 'selected' : ''}>Físicas</option></select>
      <select name="deck"><option value="">Todos mis decks</option>${myDecks.map(d => `<option ${d === myDeck ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
    </form>
    <div class="stat-tiles">
      <div class="stat-tile"><span>Récord</span><b>${s.w}-${s.l}-${s.t}</b><small>${s.n} partida(s)</small></div>
      <div class="stat-tile"><span>Win rate</span><b>${s.pct ?? '—'}${s.pct != null ? '%' : ''}</b><small>${recentForm(list)}</small></div>
      <div class="stat-tile"><span>Yendo primero</span><b>${s.first.pct ?? '—'}${s.first.pct != null ? '%' : ''}</b><small>${s.first.n} partida(s)</small></div>
      <div class="stat-tile"><span>Yendo segundo</span><b>${s.second.pct ?? '—'}${s.second.pct != null ? '%' : ''}</b><small>${s.second.n} partida(s)</small></div>
    </div>
    ${coachTips(s)}
    <div class="two-cols">
      <section class="panel"><h2 class="panel-h">Por mi deck</h2>
        <table class="mini-table"><thead><tr><th>Deck</th><th>Récord</th><th>Win rate</th></tr></thead>
        <tbody>${s.byMine.map(r => `<tr><td>${esc(r.k)}</td><td>${wlt(r)}</td><td>${pctCell(winPct(r.w, r.n))}</td></tr>`).join('')}</tbody></table></section>
      <section class="panel"><h2 class="panel-h">Contra cada deck rival</h2>
        <table class="mini-table"><thead><tr><th>Rival</th><th>Récord</th><th>Win rate</th></tr></thead>
        <tbody>${s.byOpp.slice(0, 10).map(r => `<tr><td>${esc(r.k)}</td><td>${wlt(r)}</td><td>${pctCell(winPct(r.w, r.n))}</td></tr>`).join('')}</tbody></table></section>
    </div>
    ${mine.length && opps.length > 1 ? `
    <section class="panel"><div class="panel-title"><h2>Matriz de enfrentamientos</h2><span class="card-meta">Tu win rate (partidas) · verde ≥ 55 %, rojo ≤ 45 %</span></div>
      <div class="table-wrap"><table class="matrix"><thead><tr><th>Mi deck ＼ Rival</th>${opps.map(o => `<th>${esc(o)}</th>`).join('')}</tr></thead>
      <tbody>${mine.map(a => `<tr><th>${esc(a)}</th>${opps.map(b => `<td>${cell(a, b)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>` : ''}
    <section class="panel">
      <h2 class="panel-h">Historial</h2>
      <div class="match-list">${list.map(m => `
        <a class="match-row" href="#/partidas/${m.id}">
          <span class="res ${m.result}">${m.result === 'W' ? 'V' : m.result === 'L' ? 'D' : 'E'}</span>
          <span class="mr-main"><b>${esc(m.my_deck || 'Mi deck')}</b> <span class="muted">vs</span> <b>${esc(m.opp_deck || 'Deck rival')}</b>
            <small>${m.opp_name ? esc(m.opp_name) + ' · ' : ''}${m.event ? esc(m.event) + ' · ' : ''}${fmtShort(m.played_at)}</small></span>
          <span class="mr-tags">${m.source === 'online' ? '<span class="badge cond">🌐 Online</span>' : '<span class="badge cond">🃏 Física</span>'}
            ${m.went_first === true ? '<span class="badge cond">1.º</span>' : m.went_first === false ? '<span class="badge cond">2.º</span>' : ''}
            ${m.format === 'bo3' ? `<span class="badge cond">Bo3 ${m.games.filter(g => g.result === 'W').length}-${m.games.filter(g => g.result === 'L').length}</span>` : ''}</span>
        </a>`).join('') || '<div class="empty small">Sin partidas con este filtro.</div>'}</div>
    </section>` : `
    <div class="empty">Aún no registras partidas.<br>
      <a href="#/partidas/nueva?tipo=online">Importa el log de una partida de Pokémon TCG Live</a> o <a href="#/partidas/nueva?tipo=fisica">registra una partida física</a>.</div>`}`;

  document.getElementById('mFilters')?.addEventListener('change', e => {
    const f = formData(e.currentTarget);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    go(`#/partidas${qs.toString() ? '?' + qs : ''}`);
  });
}

function recentForm(list) {
  const last = list.slice(0, 10);
  return last.length ? `<span class="form-pills">${last.map(m => `<i class="${m.result}" title="${RES_TXT[m.result]}"></i>`).join('')}</span> últimas ${last.length}` : '';
}

// Consejos a partir de tus números
function coachTips(s) {
  const tips = [];
  if (s.first.n >= 3 && s.second.n >= 3 && Math.abs((s.first.pct ?? 0) - (s.second.pct ?? 0)) >= 15) {
    const better = s.first.pct > s.second.pct ? 'primero' : 'segundo';
    tips.push(`Ganas bastante más yendo <b>${better}</b> (${s.first.pct}% vs ${s.second.pct}%). Si ganas la moneda, considera elegir ir ${better}.`);
  }
  const worst = s.byOpp.filter(r => r.n >= 3 && r.k !== 'Sin registrar').sort((a, b) => a.w / a.n - b.w / b.n)[0];
  if (worst && worst.w / worst.n < 0.45) tips.push(`Tu peor enfrentamiento es contra <b>${esc(worst.k)}</b> (${wlt(worst)}). Prueba cambios en tu lista o practica ese duelo.`);
  const best = s.byOpp.filter(r => r.n >= 3 && r.k !== 'Sin registrar').sort((a, b) => b.w / b.n - a.w / a.n)[0];
  if (best && best.w / best.n >= 0.6) tips.push(`Te va muy bien contra <b>${esc(best.k)}</b> (${wlt(best)}).`);
  if (s.online >= 5 && s.mull / s.online >= 0.35) tips.push(`Haces mulligan en ${Math.round(s.mull / s.online * 100)}% de tus partidas online: revisa cuántos Pokémon básicos llevas.`);
  if (!tips.length) return '';
  return `<section class="panel coach"><h2 class="panel-h">💡 Lo que dicen tus números</h2><ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul></section>`;
}

// Nombres de decks conocidos (metajuego) + mis decks, para sugerir al escribir
async function deckSuggestions() {
  const names = new Set();
  try { const m = await loadMeta(); [...(m.official.decks || []), ...(m.online.decks || [])].slice(0, 120).forEach(d => names.add(d.name)); } catch { /* sin metajuego */ }
  try { const { decks } = await api('/api/decks'); decks.forEach(d => names.add(d.name)); } catch { /* sin sesión */ }
  return [...names];
}

async function viewMatchForm(params, id) {
  if (!requireLogin()) return;
  const existing = id ? (await api(`/api/my-matches/${id}`)).match : null;
  const type = existing ? (existing.source === 'online' ? 'online' : 'fisica') : params.get('tipo') === 'online' ? 'online' : 'fisica';
  const [names, meta] = await Promise.all([deckSuggestions(), loadMeta().catch(() => null)]);
  const archetypes = meta ? [...meta.official.decks, ...meta.online.decks] : [];
  const m = existing || { played_at: new Date().toISOString().slice(0, 10), format: 'bo1', games: [{}] };
  const back = id ? `#/partidas/${id}` : '#/partidas';

  $app.innerHTML = `
    ${compNav('partidas')}
    <p><a href="${back}">← ${id ? 'Volver a la partida' : 'Mis partidas'}</a></p>
    <div class="page-head"><div><h1>${id ? 'Editar partida' : type === 'online' ? '📋 Importar partida online' : '🃏 Registrar partida física'}</h1>
      <p class="muted">${type === 'online' ? 'En Pokémon TCG Live, al terminar la partida abre el historial, copia todo el texto y pégalo aquí.' : 'Anota el resultado; con el tiempo verás tus enfrentamientos fuertes y débiles.'}</p></div></div>
    <datalist id="deckNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <form id="mf" class="sell-layout" novalidate>
      <div class="sell-main">
        ${type === 'online' ? `
        <section class="panel step-card">
          <div class="step-title"><span class="step-num">1</span><div><h2>Pega el log</h2><p class="card-meta">Lo leemos en tu navegador para mostrarte la vista previa.</p></div></div>
          <textarea name="log" id="logText" rows="9" class="mono" placeholder="Setup&#10;TuNombre chose heads for the opening coin flip.&#10;…">${esc(existing?.log || '')}</textarea>
          <div id="logPreview"></div>
        </section>` : ''}
        <section class="panel step-card">
          <div class="step-title"><span class="step-num">${type === 'online' ? 2 : 1}</span><div><h2>Decks</h2><p class="card-meta">${type === 'online' ? 'Los adivinamos por los Pokémon que se jugaron; corrígelos si hace falta.' : 'Escribe o elige de la lista.'}</p></div></div>
          <div class="row">
            <div class="field"><label>Mi deck</label><input name="my_deck" list="deckNames" maxlength="60" value="${esc(m.my_deck || '')}" placeholder="ej. Dragapult Dusknoir"></div>
            <div class="field"><label>Deck rival</label><input name="opp_deck" list="deckNames" maxlength="60" value="${esc(m.opp_deck || '')}" placeholder="ej. N's Zoroark"></div>
            <div class="field"><label>Rival <span class="card-meta">(opcional)</span></label><input name="opp_name" maxlength="40" value="${esc(m.opp_name || '')}"></div>
          </div>
        </section>
        ${type === 'fisica' ? `
        <section class="panel step-card">
          <div class="step-title"><span class="step-num">2</span><div><h2>Resultado</h2></div></div>
          <div class="field"><label>Formato</label>
            <div class="segmented" id="fmtSel">${[['bo1', 'Bo1 (1 juego)'], ['bo3', 'Bo3 (mejor de 3)']].map(([k, t]) => `<button type="button" data-fmt="${k}" class="${m.format === k ? 'active' : ''}">${t}</button>`).join('')}</div>
            <input type="hidden" name="format" value="${esc(m.format)}"></div>
          <div id="gamesBox"></div>
        </section>` : ''}
        <section class="panel step-card">
          <div class="step-title"><span class="step-num">3</span><div><h2>Detalles</h2></div></div>
          <div class="row">
            <div class="field"><label>Fecha</label><input name="played_at" type="date" value="${esc(m.played_at)}"></div>
            <div class="field"><label>Evento <span class="card-meta">(opcional)</span></label><input name="event" maxlength="80" value="${esc(m.event || '')}" placeholder="ej. Liga local, Ladder, Regional"></div>
          </div>
          <div class="field"><label>Notas <span class="card-meta">(qué aprendiste, qué cambiarías)</span></label><textarea name="notes" rows="3" maxlength="2000">${esc(m.notes || '')}</textarea></div>
        </section>
      </div>
      <aside class="sell-side"><div class="panel preview-panel">
        <div class="card-meta preview-label">Resumen</div>
        <div id="mSummary" class="m-summary"></div>
        <div class="error" id="mErr"></div>
        <button class="btn primary big" type="submit">${id ? 'Guardar cambios' : 'Guardar partida'}</button>
        <a class="btn" href="${back}">Cancelar</a>
      </div></aside>
    </form>`;

  const f = document.getElementById('mf');
  let parsed = null, meName = existing?.me_name || '';
  let games = (m.games && m.games.length ? m.games : [{}]).map(g => ({ ...g }));

  function renderGames() {
    const box = document.getElementById('gamesBox'); if (!box) return;
    const n = f.format.value === 'bo3' ? 3 : 1;
    while (games.length < n) games.push({});
    box.innerHTML = games.slice(0, n).map((g, i) => `
      <div class="game-row">
        <b>${n > 1 ? `Juego ${i + 1}` : 'Resultado'}</b>
        <div class="segmented res-sel" data-g="${i}">${['W', 'L', 'T'].map(r => `<button type="button" data-res="${r}" class="${g.result === r ? 'active r' + r : ''}">${RES_TXT[r]}</button>`).join('')}</div>
        <div class="segmented first-sel" data-g="${i}">${[[true, 'Fui 1.º'], [false, 'Fui 2.º']].map(([v, t]) => `<button type="button" data-first="${v}" class="${g.first === v ? 'active' : ''}">${t}</button>`).join('')}</div>
        <label class="prize-in">Premios que tomé <input type="number" min="0" max="6" data-pz="${i}" value="${g.prizes_me ?? ''}"></label>
      </div>`).join('') + (n > 1 ? '<p class="card-meta">Deja en blanco el juego 3 si no se jugó.</p>' : '');
    renderSummary();
  }
  document.getElementById('gamesBox')?.addEventListener('click', e => {
    const r = e.target.closest('[data-res]'), fs = e.target.closest('[data-first]');
    if (r) { const i = r.parentElement.dataset.g; games[i].result = games[i].result === r.dataset.res ? null : r.dataset.res; renderGames(); }
    if (fs) { const i = fs.parentElement.dataset.g; games[i].first = fs.dataset.first === 'true'; renderGames(); }
  });
  document.getElementById('gamesBox')?.addEventListener('input', e => { if (e.target.dataset.pz !== undefined) games[e.target.dataset.pz].prizes_me = e.target.value; });
  document.getElementById('fmtSel')?.addEventListener('click', e => {
    const b = e.target.closest('[data-fmt]'); if (!b) return;
    f.format.value = b.dataset.fmt; document.querySelectorAll('#fmtSel button').forEach(x => x.classList.toggle('active', x === b)); renderGames();
  });

  // Vista previa del log (online)
  let guessed = { me: false, opp: false };
  function readLog() {
    const txt = f.log?.value || '';
    const box = document.getElementById('logPreview');
    if (!txt.trim()) { parsed = null; box.innerHTML = ''; renderSummary(); return; }
    parsed = parseLog(txt);
    if (parsed.players.length < 2 || !parsed.turns.length) { box.innerHTML = '<p class="error">No reconocemos este texto como un log de Pokémon TCG Live.</p>'; parsed = null; renderSummary(); return; }
    if (!parsed.players.includes(meName)) meName = parsed.me;
    const opp = parsed.players.find(p => p !== meName);
    // Decks adivinados (solo si el usuario no escribió uno)
    if (!f.my_deck.value || guessed.me) { f.my_deck.value = guessDeck(parsed.pokemon[meName] || [], archetypes); guessed.me = true; }
    if (!f.opp_deck.value || guessed.opp) { f.opp_deck.value = guessDeck(parsed.pokemon[opp] || [], archetypes); guessed.opp = true; }
    if (!f.opp_name.value || f.opp_name.value === parsed.players.find(p => p !== opp)) f.opp_name.value = opp;
    box.innerHTML = `
      <div class="log-ok">✔ Log leído: ${parsed.turns.length} turnos · ${esc(parsed.players.join(' vs '))}</div>
      <div class="field"><label>¿Cuál eres tú?</label>
        <div class="segmented" id="meSel">${parsed.players.map(p => `<button type="button" data-me="${esc(p)}" class="${p === meName ? 'active' : ''}">${esc(p)}</button>`).join('')}</div></div>`;
    document.getElementById('meSel').addEventListener('click', e => {
      const b = e.target.closest('[data-me]'); if (!b || b.dataset.me === meName) return;
      meName = b.dataset.me; guessed = { me: true, opp: true }; f.opp_name.value = ''; readLog();
    });
    renderSummary();
  }
  f.log?.addEventListener('input', () => { clearTimeout(readLog.t); readLog.t = setTimeout(readLog, 250); });
  ['my_deck', 'opp_deck'].forEach(k => f[k].addEventListener('input', () => { guessed[k === 'my_deck' ? 'me' : 'opp'] = false; renderSummary(); }));

  function renderSummary() {
    const el = document.getElementById('mSummary');
    if (type === 'online') {
      if (!parsed) { el.innerHTML = '<p class="card-meta">Pega el log para ver el resumen.</p>'; return; }
      const opp = parsed.players.find(p => p !== meName);
      const res = parsed.winner ? (parsed.winner === meName ? 'W' : 'L') : 'T';
      el.innerHTML = `<div class="big-res ${res}">${RES_TXT[res]}</div>
        <ul class="checklist">
          <li>${parsed.first === meName ? 'Fuiste primero' : 'Fuiste segundo'}${parsed.coin.winner ? ` · ${parsed.coin.winner === meName ? 'ganaste' : 'perdiste'} la moneda` : ''}</li>
          <li>Premios: ${parsed.prizes[meName] || 0} – ${parsed.prizes[opp] || 0}</li>
          <li>Mulligans: tú ${parsed.mulligans[meName] || 0} · rival ${parsed.mulligans[opp] || 0}</li>
          <li>${esc(f.my_deck.value || '¿tu deck?')} vs ${esc(f.opp_deck.value || '¿deck rival?')}</li></ul>`;
    } else {
      const done = games.filter(g => g.result);
      const w = done.filter(g => g.result === 'W').length, l = done.filter(g => g.result === 'L').length;
      const res = !done.length ? null : f.format.value === 'bo1' ? done[0].result : w > l ? 'W' : l > w ? 'L' : 'T';
      el.innerHTML = res ? `<div class="big-res ${res}">${RES_TXT[res]}${f.format.value === 'bo3' ? ` ${w}-${l}` : ''}</div>` : '<p class="card-meta">Marca el resultado.</p>';
    }
  }

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('mErr'); err.textContent = '';
    const body = { ...formData(f), source: type === 'online' ? 'online' : 'physical', me_name: meName };
    if (type === 'online') { if (!parsed) { err.textContent = 'Pega un log válido.'; return; } body.games = []; body.format = 'bo1'; }
    else {
      body.games = games.slice(0, f.format.value === 'bo3' ? 3 : 1).filter(g => g.result);
      if (!body.games.length) { err.textContent = 'Marca el resultado.'; return; }
    }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const { match } = await api(id ? `/api/my-matches/${id}` : '/api/my-matches', { method: id ? 'PUT' : 'POST', body });
      toast(id ? 'Partida actualizada' : 'Partida guardada'); go(`#/partidas/${match.id}`);
    } catch (e2) { err.textContent = e2.message; btn.disabled = false; }
  });

  if (type === 'online') readLog(); else renderGames();
  renderSummary();
}

async function viewMatch(id) {
  if (!requireLogin()) return;
  const { match: m } = await api(`/api/my-matches/${id}`);
  const st = m.log ? parseLog(m.log) : null;
  if (st && m.me_name && st.players.includes(m.me_name)) { st.me = m.me_name; st.opp = st.players.find(p => p !== m.me_name); }
  const an = st ? analyze(st) : null;
  const meName = st?.me, oppName = st?.opp;
  const res = m.result;

  $app.innerHTML = `
    ${compNav('partidas')}
    <p><a href="#/partidas">← Mis partidas</a></p>
    <div class="match-hero panel">
      <div class="big-res ${res}">${RES_TXT[res]}${m.format === 'bo3' ? ` ${m.games.filter(g => g.result === 'W').length}-${m.games.filter(g => g.result === 'L').length}` : ''}</div>
      <div class="mh-main">
        <h1>${esc(m.my_deck || 'Mi deck')} <span class="muted">vs</span> ${esc(m.opp_deck || 'Deck rival')}</h1>
        <p class="card-meta">${m.opp_name ? `Contra ${esc(m.opp_name)} · ` : ''}${m.event ? esc(m.event) + ' · ' : ''}${fmtShort(m.played_at)} · ${m.source === 'online' ? '🌐 Pokémon TCG Live' : '🃏 Partida física'}</p>
      </div>
      <div class="t-actions"><a class="btn small" href="#/partidas/${m.id}/editar">Editar</a><button class="btn small danger" id="delMatch">Borrar</button></div>
    </div>
    ${an ? `
    <div class="stat-tiles">
      <div class="stat-tile"><span>Turno</span><b>${an.wentFirst ? 'Fuiste 1.º' : 'Fuiste 2.º'}</b><small>${st.coin.winner ? (st.coin.winner === meName ? 'Ganaste la moneda' : 'Perdiste la moneda') + (st.coin.choice ? ` · se eligió ir ${st.coin.choice === 'first' ? 'primero' : 'segundo'}` : '') : ''}</small></div>
      <div class="stat-tile"><span>Premios</span><b>${st.prizes[meName] || 0} – ${st.prizes[oppName] || 0}</b><small>${st.turns.length} turnos en total</small></div>
      <div class="stat-tile"><span>Daño hecho / recibido</span><b>${an.damage.me} / ${an.damage.opp}</b><small>suma de ataques</small></div>
      <div class="stat-tile"><span>Mulligans</span><b>${st.mulligans[meName] || 0} / ${st.mulligans[oppName] || 0}</b><small>tú / rival</small></div>
    </div>
    <section class="panel"><div class="panel-title"><h2>Carrera de premios</h2><span class="card-meta">Premios tomados después de cada turno</span></div>
      ${lineChart('prizeChart', { labels: an.race.map(r => `T${r.turn}`), height: 220, yMax: 6, yFmt: v => String(Math.round(v)),
        series: [{ name: meName, values: an.race.map(r => r.me) }, { name: oppName, values: an.race.map(r => r.opp) }] })}
    </section>
    <section class="panel coach"><h2 class="panel-h">🧠 Puntos a revisar</h2>
      ${an.tips.length ? `<ul class="tips">${an.tips.map(t => `<li class="tip ${t.level}">
        <span class="tip-ico">${t.level === 'warn' ? '⚠️' : t.level === 'good' ? '✅' : '💡'}</span>
        <div><b>${esc(t.title)}</b><p>${esc(t.text)}</p>${t.turn ? `<a href="#t${t.turn}" class="card-meta" data-jump="${t.turn}">Ver turno ${t.turn} ↓</a>` : ''}</div></li>`).join('')}</ul>`
        : '<p class="card-meta">No encontramos nada llamativo. ¡Buena partida!</p>'}
      <p class="card-meta">Son pistas automáticas a partir del log; tú decides si fueron errores o la mejor jugada posible.</p>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Turno por turno</h2>
        <label class="switch small-switch"><input type="checkbox" id="onlyMine"><span class="switch-ui"></span><span><b>Solo mis turnos</b></span></label></div>
      ${st.openingHand.length ? `<div class="opening"><b>Tu mano inicial:</b> ${st.openingHand.map(esc).join(', ')}</div>` : ''}
      <ol class="timeline">${st.turns.map(t => turnCard(t, meName)).join('')}</ol>
    </section>
    <details class="panel raw-log"><summary>Ver log original</summary><pre>${esc(m.log)}</pre></details>` : `
    <section class="panel"><h2 class="panel-h">Juegos</h2>
      <table class="mini-table"><thead><tr><th>Juego</th><th>Resultado</th><th>Turno</th><th>Premios tomados</th></tr></thead>
      <tbody>${m.games.map((g, i) => `<tr><td>${i + 1}</td><td><span class="res ${g.result}">${g.result === 'W' ? 'V' : g.result === 'L' ? 'D' : 'E'}</span> ${RES_TXT[g.result]}</td>
        <td>${g.first === true ? 'Fui 1.º' : g.first === false ? 'Fui 2.º' : '—'}</td><td>${g.prizes_me ?? '—'}</td></tr>`).join('')}</tbody></table></section>`}
    ${m.notes ? `<section class="panel"><h2 class="panel-h">Notas</h2><p>${esc(m.notes).replace(/\n/g, '<br>')}</p></section>` : ''}`;

  document.getElementById('delMatch').addEventListener('click', async () => {
    if (!confirm('¿Borrar esta partida? No se puede deshacer.')) return;
    await api(`/api/my-matches/${m.id}`, { method: 'DELETE' }); toast('Partida borrada'); go('#/partidas');
  });
  document.getElementById('onlyMine')?.addEventListener('change', e => {
    $app.querySelectorAll('.turn').forEach(li => { li.hidden = e.target.checked && !li.classList.contains('mine'); });
  });
  $app.querySelectorAll('[data-jump]').forEach(a => a.addEventListener('click', ev => {
    ev.preventDefault(); const el = document.getElementById(`t${a.dataset.jump}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1400);
  }));
}

function turnCard(t, me) {
  const mine = t.player === me;
  const lines = turnSummary(t);
  return `<li class="turn ${mine ? 'mine' : 'theirs'}" id="t${t.n}">
    <div class="turn-head"><span class="turn-n">T${t.n}</span><b>${mine ? 'Tu turno' : 'Rival'} ${t.number}</b>
      <span class="card-meta">${t.draws} carta(s) obtenidas${t.supporters.length ? '' : ' · sin Partidario'}</span>
      ${t.prizesTaken ? `<span class="prize-chip">+${t.prizesTaken} premio${t.prizesTaken > 1 ? 's' : ''}</span>` : ''}</div>
    ${lines.length ? `<ul class="turn-lines">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${t.attacks.map(a => `<div class="atk">⚔️ <b>${esc(a.attacker)}</b> usó <b>${esc(a.attack)}</b> contra ${esc(a.target)} · <b>${a.damage}</b> de daño</div>`).join('')}
    ${t.kos.map(k => `<div class="ko">💥 ${k.owner === me ? 'Tu' : 'El'} ${esc(k.pokemon)}${k.owner === me ? '' : ' rival'} quedó fuera de combate${k.selfInflicted ? ' (por su propio efecto)' : ''}</div>`).join('')}
  </li>`;
}

// ---------- Administración ----------

async function viewAdmin(params) {
  if (!requireLogin()) return;
  if (!currentUser.is_admin) { $app.innerHTML = '<div class="empty">Solo los administradores pueden ver esta página.</div>'; return; }
  const tab = ['users', 'listings'].includes(params.get('tab')) ? params.get('tab') : 'summary';
  const { summary: s, users, listings } = await api('/api/admin/overview');
  const tabLink = (k, label) => `<a class="tab ${tab === k ? 'active' : ''}" href="#/admin${k === 'summary' ? '' : `?tab=${k}`}">${label}</a>`;
  const stat = (n, label) => `<div class="panel admin-stat"><b>${n}</b><span class="muted">${label}</span></div>`;
  const userStatus = u => [u.is_admin ? '<span class="badge admin">Admin</span>' : '',
    u.blocked ? '<span class="badge sold">Suspendida</span>' : '<span class="badge cond">Activa</span>'].join(' ');

  $app.innerHTML = `
    <div class="page-head"><div><h1>🛡 Administración</h1>
      <p class="muted">Gestiona cuentas y todas las publicaciones de Macai TCG.</p></div></div>
    <div class="panel">
      <div class="tabs">${tabLink('summary', 'Resumen')}${tabLink('users', `Usuarios (${s.users})`)}${tabLink('listings', `Publicaciones (${listings.length})`)}</div>
      <div id="admBody"></div>
    </div>
    <dialog id="userDlg" class="panel admin-dlg"></dialog>`;
  const $body = document.getElementById('admBody');

  if (tab === 'summary') {
    $body.innerHTML = `
      <div class="admin-stats">
        ${stat(s.users, 'cuentas')}${stat(s.admins, 'administradores')}${stat(s.blocked, 'suspendidas')}
        ${stat(s.listings_available, 'publicaciones disponibles')}${stat(s.listings_sold, 'vendidas')}
        ${stat(s.accessories, 'accesorios')}${stat(s.tournaments, 'torneos')}
      </div>
      <p class="card-meta">Como administrador puedes editar, marcar como vendida o borrar cualquier publicación, gestionar cualquier torneo,
        editar datos de las cuentas, nombrar administradores y suspender o borrar cuentas.</p>`;
  }

  if (tab === 'users') {
    $body.innerHTML = `
      <div class="field"><input id="uq" placeholder="Buscar por nombre, usuario, correo, teléfono o zona" autocomplete="off"></div>
      <div style="overflow-x:auto"><table class="mine">
        <thead><tr><th>Cuenta</th><th>Contacto</th><th>Publicaciones</th><th>Estado</th><th></th></tr></thead>
        <tbody id="uRows"></tbody></table></div>`;
    const paint = () => {
      const q = document.getElementById('uq').value.trim().toLowerCase();
      const rows = users.filter(u => !q || [u.display_name, u.username, u.email, u.contact, u.location].some(v => (v || '').toLowerCase().includes(q)));
      document.getElementById('uRows').innerHTML = rows.map(u => `
        <tr>
          <td><b>${esc(u.display_name)}</b> <a href="#/vendedor/${encodeURIComponent(u.username)}">@${esc(u.username)}</a>
            <div class="card-meta">Desde ${fmtDay(u.created_at)}${u.pokemon_id ? ` · ID Pokémon ${esc(u.pokemon_id)}` : ''}</div></td>
          <td>${esc(u.email)}<div class="card-meta">${esc(u.contact || '—')} · ${esc(u.location || '—')}</div></td>
          <td>${u.listings.available} disponibles<div class="card-meta">${u.listings.sold} vendidas</div></td>
          <td>${userStatus(u)}</td>
          <td class="actions">
            <button class="btn small" data-edit="${esc(u.id)}">Editar</button>
            ${String(u.id) === String(currentUser.id) ? '<span class="card-meta">(tú)</span>' : `
              <button class="btn small" data-admin="${esc(u.id)}">${u.is_admin ? 'Quitar admin' : 'Hacer admin'}</button>
              <button class="btn small" data-block="${esc(u.id)}">${u.blocked ? 'Reactivar' : 'Suspender'}</button>
              <button class="btn small danger" data-deluser="${esc(u.id)}">Borrar</button>`}
          </td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">Sin resultados.</td></tr>';
      labelTables($body);
    };
    document.getElementById('uq').addEventListener('input', paint);
    paint();

    const find = id => users.find(u => String(u.id) === String(id));
    const save = async (u, body, msg) => { await api(`/api/admin/users/${u.id}`, { method: 'PUT', body }); toast(msg); viewAdmin(params); };
    $body.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.admin) {
          const u = find(b.dataset.admin);
          if (!confirm(u.is_admin ? `¿Quitar el rol de administrador a @${u.username}?` : `¿Hacer administrador a @${u.username}? Podrá gestionar todo el sitio.`)) return;
          await save(u, { is_admin: !u.is_admin }, u.is_admin ? 'Ya no es administrador' : 'Ahora es administrador');
        } else if (b.dataset.block) {
          const u = find(b.dataset.block);
          if (!u.blocked && !confirm(`¿Suspender a @${u.username}? No podrá entrar y sus publicaciones dejarán de verse en el catálogo.`)) return;
          await save(u, { blocked: !u.blocked }, u.blocked ? 'Cuenta reactivada' : 'Cuenta suspendida');
        } else if (b.dataset.deluser) {
          const u = find(b.dataset.deluser);
          if (!confirm(`¿Borrar la cuenta de @${u.username} y sus ${u.listings.available + u.listings.sold} publicaciones con fotos? No se puede deshacer.`)) return;
          await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          toast('Cuenta borrada'); viewAdmin(params);
        } else if (b.dataset.edit) {
          openUserDialog(find(b.dataset.edit));
        }
      } catch (err) { toast(err.message); }
    });

    function openUserDialog(u) {
      const dlg = document.getElementById('userDlg');
      dlg.innerHTML = `
        <h2>Editar @${esc(u.username)}</h2>
        <form id="uf" method="dialog">
          ${profileFields(u)}
          <p class="card-meta">Correo: ${esc(u.email)} (no editable)</p>
          <p class="error" id="ufErr"></p>
          <div class="t-actions"><button class="btn primary" type="submit">Guardar</button><button class="btn" type="button" id="ufCancel">Cancelar</button></div>
        </form>`;
      dlg.showModal();
      document.getElementById('ufCancel').onclick = () => dlg.close();
      document.getElementById('uf').addEventListener('submit', async e => {
        e.preventDefault();
        try {
          await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: formData(e.target) });
          dlg.close(); toast('Datos guardados'); viewAdmin(params);
        } catch (err) { document.getElementById('ufErr').textContent = err.message; }
      });
    }
  }

  if (tab === 'listings') {
    $body.innerHTML = `
      <div class="row">
        <div class="field"><input id="lq" placeholder="Buscar por carta, expansión, código o vendedor" autocomplete="off"></div>
        <div class="field"><select id="ls">
          <option value="">Todas</option><option value="available">Disponibles</option><option value="sold">Vendidas</option>
          <option value="blocked">De cuentas suspendidas</option></select></div>
      </div>
      <div style="overflow-x:auto"><table class="mine">
        <thead><tr><th></th><th>Publicación</th><th>Vendedor</th><th>Precio</th><th>Cant.</th><th>Estado</th><th></th></tr></thead>
        <tbody id="lRows"></tbody></table></div>
      ${listings.length >= 200 ? '<p class="card-meta">Se muestran las 200 publicaciones más recientes.</p>' : ''}`;
    const paint = () => {
      const q = document.getElementById('lq').value.trim().toLowerCase();
      const st = document.getElementById('ls').value;
      const rows = listings.filter(l => (!q || [l.card_name, l.set_name, l.card_code, l.username, l.display_name].some(v => (v || '').toLowerCase().includes(q)))
        && (!st || (st === 'blocked' ? l.seller_blocked : l.status === st)));
      document.getElementById('lRows').innerHTML = rows.map(l => `
        <tr>
          <td>${coverImg(l) ? `<img src="${esc(coverImg(l))}" alt="" loading="lazy">` : ''}</td>
          <td><a href="#/carta/${l.id}">${esc(l.card_name)}</a>
            <div class="card-meta">${isAcc(l) ? esc(ACC_CATEGORIES[l.category]?.label || 'Accesorio') : `<span class="badge ${l.game}">${GAME_LABEL[l.game] || ''}</span> ${esc([l.set_name, l.card_code].filter(Boolean).join(' · '))}`}</div></td>
          <td><a href="#/vendedor/${encodeURIComponent(l.username || '')}">@${esc(l.username)}</a>${l.seller_blocked ? ' <span class="badge sold">Suspendida</span>' : ''}</td>
          <td class="price">${money(l.price)}</td>
          <td>${l.quantity}</td>
          <td>${l.status === 'sold' ? '<span class="badge sold">Vendida</span>' : '<span class="badge cond">Disponible</span>'}</td>
          <td class="actions">
            <a class="btn small" href="#/editar/${l.id}">Editar</a>
            <button class="btn small" data-toggle="${l.id}">${l.status === 'sold' ? 'Reactivar' : 'Marcar vendida'}</button>
            <button class="btn small danger" data-del="${l.id}">Borrar</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">Sin resultados.</td></tr>';
      labelTables($body);
    };
    document.getElementById('lq').addEventListener('input', paint);
    document.getElementById('ls').addEventListener('change', paint);
    paint();
    $body.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      const l = listings.find(x => String(x.id) === (b.dataset.toggle || b.dataset.del));
      if (!l) return;
      try {
        if (b.dataset.del) {
          if (!confirm(`¿Borrar "${l.card_name}" de @${l.username}? No se puede deshacer.`)) return;
          await api(`/api/listings/${l.id}`, { method: 'DELETE' });
          toast('Publicación borrada');
        } else {
          await api(`/api/listings/${l.id}/status`, { method: 'PATCH', body: { status: l.status === 'sold' ? 'available' : 'sold' } });
          toast('Publicación actualizada');
        }
        viewAdmin(params);
      } catch (err) { toast(err.message); }
    });
  }
}

function requireLogin() {
  if (currentUser) return true;
  toast('Inicia sesión para continuar'); go('#/login'); return false;
}

// ---------- Router ----------

let lastPath = null;
async function router() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  // Si solo cambian los filtros (misma página), se conserva la posición; si es otra página, se sube al inicio
  const samePage = lastPath === (path || '/');
  const keepY = samePage ? window.scrollY : 0;
  lastPath = path || '/';
  if (!samePage) { window.scrollTo(0, 0); showLoading(); }
  markActiveNav();
  refreshMatchBanner();
  try {
    await route(parts, params);
    if (samePage) requestAnimationFrame(() => window.scrollTo(0, keepY));
  } catch (err) {
    $app.innerHTML = `<div class="empty">${esc(err.message)} <br><a href="#/">Ir al catálogo</a></div>`;
  }
}

// Mientras carga una página nueva: esqueleto animado (si tarda más de un instante)
let loadingTimer;
function showLoading() {
  clearTimeout(loadingTimer);
  const before = $app.innerHTML;
  loadingTimer = setTimeout(() => {
    if ($app.innerHTML !== before) return;    // ya se pintó la página nueva
    $app.innerHTML = `<div class="skeleton-page" aria-label="Cargando">
      <div class="sk sk-title"></div><div class="sk sk-line"></div>
      <div class="sk-grid">${'<div class="sk sk-card"></div>'.repeat(8)}</div></div>`;
  }, 180);
}

async function route(parts, params) {
  {
    switch (parts[0]) {
      case undefined: return await viewCatalog(params);
      case 'carta': return await viewListing(parts[1]);
      case 'vendedor': return await viewSeller(decodeURIComponent(parts[1] || ''));
      case 'registro': return viewRegister();
      case 'login': return viewLogin();
      case 'mis-cartas': return await viewMine(params);
      case 'vender': return await viewListingForm();
      case 'vender-accesorio': return await viewListingForm(null, 'accessory');
      case 'accesorios': return await viewAccessories(params);
      case 'editar': return await viewListingForm(parts[1]);
      case 'perfil': return viewProfile();
      case 'torneos': return parts[1] === 'nuevo' ? viewTournamentForm() : parts[1] === 'importar' ? viewTdfImport() : await viewTournaments();
      case 'torneo': return parts[2] === 'reloj' ? await viewTournamentClock(parts[1]) : await viewTournament(parts[1]);
      case 'admin': return await viewAdmin(params);
      case 'competitivo':
        if (parts[1] === 'oficiales' || parts[1] === 'online') return await viewCompEvents(parts[1]);
        if (parts[1] === 'yugioh') return parts[2] === 'torneos' ? await viewYgoEvents() : await viewYgoMeta(params);
        if (parts[1] === 'cartas') return await viewCardUsage(params);
        return await viewMeta(params);
      case 'partidas':
        if (parts[1] === 'nueva') return await viewMatchForm(params);
        if (parts[1] && parts[2] === 'editar') return await viewMatchForm(params, parts[1]);
        if (parts[1]) return await viewMatch(parts[1]);
        return await viewMatches(params);
      case 'decks':
        if (parts[1] === 'nuevo') return await viewDeckEditor();
        if (parts[1] && parts[2] === 'editar') return await viewDeckEditor(parts[1]);
        if (parts[1]) return await viewDeck(parts[1]);
        return await viewDecks();
      default: $app.innerHTML = '<div class="empty">Página no encontrada. <a href="#/">Ir al catálogo</a></div>';
    }
  }
}

(async () => {
  ({ user: currentUser } = await api('/api/auth/me'));
  renderNav();
  window.addEventListener('hashchange', router);
  router();
})();
