// Macai TCG — SPA en JavaScript puro con rutas por hash (#/...)
import { sceneSVG, emblemSVG } from './scene.js';
import { SECTIONS, SECTION_LABEL, CATEGORY_LABEL, MAX_QTY, deckSummary, deckToText, parseDeckText, mergeCards } from './deck-rules.js';

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
const $navToggle = document.getElementById('navToggle');
function setMenu(open) {
  $topbar.classList.toggle('nav-open', open);
  $navToggle.setAttribute('aria-expanded', String(open));
  $navToggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
}
$navToggle.addEventListener('click', () => setMenu(!$topbar.classList.contains('nav-open')));
$nav.addEventListener('click', e => { if (e.target.closest('a, button')) setMenu(false); });
document.addEventListener('click', e => { if (!$topbar.contains(e.target)) setMenu(false); });
window.addEventListener('hashchange', () => setMenu(false));

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

function renderNav() {
  $nav.innerHTML = currentUser
    ? `<a class="btn small" href="#/accesorios">🎒 Accesorios</a>
       <a class="btn small" href="#/torneos">⚔ Torneos</a>
       <a class="btn primary small" href="#/vender">+ Vender carta</a>
       <a class="btn small" href="#/decks">🃏 Mis decks</a>
       <a class="btn small" href="#/mis-cartas">Mis publicaciones</a>
       <a class="btn small" href="#/perfil">Mi perfil</a>
       ${currentUser.is_admin ? '<a class="btn small admin-link" href="#/admin">🛡 Admin</a>' : ''}
       <span class="nav-user">@${esc(currentUser.username)}</span>
       <button class="btn small" id="logout">Salir</button>`
    : `<a class="btn small" href="#/accesorios">🎒 Accesorios</a>
       <a class="btn small" href="#/torneos">⚔ Torneos</a>
       <a class="btn small" href="#/login">Iniciar sesión</a>
       <a class="btn primary small" href="#/registro">Crear cuenta</a>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    currentUser = null; renderNav(); refreshMatchBanner(); toast('Sesión cerrada'); go('#/');
  });
}

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
        <div>${acc ? `<span class="badge acc-cat">${esc(cat?.label || 'Accesorio')}</span>` : ''}
             <span class="badge ${l.game}">${GAME_LABEL[l.game] || ''}</span>
             <span class="badge cond" title="${esc(acc ? condLabel(l) : CONDITIONS[l.condition])}">${esc(acc ? condLabel(l) : l.condition)}</span></div>
        <div class="card-name">${esc(l.card_name)}</div>
        <div class="card-meta">${esc((acc ? [l.set_name] : [l.set_name, l.card_code, l.rarity]).filter(Boolean).join(' · '))}</div>
        ${showSeller ? `<div class="card-meta">Vende @${esc(l.username)}${l.location ? ' · ' + esc(l.location) : ''}</div>` : ''}
        ${l.market_price_mxn ? `<div class="card-meta">Mercado: ${money(l.market_price_mxn)}</div>` : ''}
        <div class="card-foot"><span class="price">${money(l.price)}</span>
          <span class="card-meta">x${l.quantity}</span></div>
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

  $app.innerHTML = `
    <section class="scene">
      ${sceneSVG()}
      <div class="scene-content">
        <div class="hero-copy">
          <span class="kicker">✦ Pokémon · Yu-Gi-Oh! ✦</span>
          <h1>Cada carta tiene una historia.<br><span class="grad">Encuentra la tuya.</span></h1>
          <p>El mercado donde los coleccionistas del reino intercambian sus tesoros. Fotos reales, precios de referencia y vendedores de tu zona.</p>
          <div class="hero-cta">
            <a class="btn primary big" href="#catalogo" id="exploreBtn">Explorar cartas</a>
            <a class="btn ghost big" href="${currentUser ? '#/vender' : '#/registro'}">${currentUser ? 'Vender una carta' : 'Crear cuenta gratis'}</a>
          </div>
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
    <div class="tabs">
      ${[['', 'Todas'], ['pokemon', 'Pokémon'], ['yugioh', 'Yu-Gi-Oh!']].map(([v, t]) =>
        `<button class="tab ${game === v ? 'active' : ''}" data-game="${v}">${t}</button>`).join('')}
    </div>
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Buscar por nombre, expansión o código…" value="${esc(q)}">
      <select name="set" aria-label="Expansión">
        <option value="">Todas las expansiones</option>
        ${sets.map(s => `<option value="${esc(s.name)}" ${set.toLowerCase() === s.name.toLowerCase() ? 'selected' : ''}>${esc(s.name)} (${s.count})</option>`).join('')}
      </select>
      <select name="sort">
        ${[['', 'Más recientes'], ['price_asc', 'Precio: menor a mayor'], ['price_desc', 'Precio: mayor a menor'], ['name', 'Nombre A-Z']]
          .map(([v, t]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </form>
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
  $app.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => update({ game: b.dataset.game, set: '' })));
  const form = document.getElementById('filters');
  form.addEventListener('submit', e => { e.preventDefault(); update({}); });
  form.querySelectorAll('select').forEach(s => s.addEventListener('change', () => update({})));
  form.q.addEventListener('search', () => update({})); // al pulsar la X de limpiar
  document.getElementById('exploreBtn').addEventListener('click', e => {
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
            <img src="${esc(g.url)}" alt=""><span>${g.real ? '📷' : 'Oficial'}</span>
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

async function viewMine() {
  if (!requireLogin()) return;
  const { listings } = await api('/api/listings/mine');
  $app.innerHTML = `
    <div class="hero">
      <div><h1>Mis publicaciones</h1><p class="muted">Administra las cartas y accesorios que tienes a la venta.</p></div>
      <div class="t-actions"><a class="btn" href="#/vender-accesorio">+ Vender accesorio</a><a class="btn primary" href="#/vender">+ Vender carta</a></div>
    </div>
    ${listings.length ? `
      <div class="panel" style="overflow-x:auto">
        <table class="mine">
          <thead><tr><th></th><th>Publicación</th><th>Juego</th><th>Estado</th><th>Precio</th><th>Cant.</th><th>Publicación</th><th></th></tr></thead>
          <tbody>${listings.map(l => `
            <tr>
              <td>${coverImg(l) ? `<img src="${esc(coverImg(l))}" alt="">` : ''}</td>
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
      </div>` : `<div class="empty">Aún no tienes publicaciones. <a href="#/vender">Vende una carta</a> o <a href="#/vender-accesorio">un accesorio</a>.</div>`}`;

  $app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('¿Borrar esta publicación? No se puede deshacer.')) return;
    await api(`/api/listings/${b.dataset.del}`, { method: 'DELETE' });
    toast('Publicación borrada'); viewMine();
  }));
  $app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const l = listings.find(x => String(x.id) === b.dataset.toggle);
    await api(`/api/listings/${l.id}/status`, { method: 'PATCH', body: { status: l.status === 'sold' ? 'available' : 'sold' } });
    toast('Publicación actualizada'); viewMine();
  }));
}

// Selector de fotos reales (formularios de cartas y de accesorios): pinta #photoGrid y usa #photoInput
function setupPhotos(initial = []) {
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
  return { count: () => keep.length + added.length, added: () => added, keepIds: () => keep.map(p => p.id) };
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
  if (othersListing) $app.querySelector('.form-wide')?.insertAdjacentHTML('afterbegin',
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
  $app.innerHTML = `
    <p><a href="#/mis-cartas">← Mis publicaciones</a></p>
    <div class="panel form-wide">
      <h1>${id ? 'Editar carta' : 'Vender una carta'}</h1>
      <form id="f" novalidate>
        <div class="tabs" id="gameTabs">
          ${['pokemon', 'yugioh'].map(g => `<button type="button" class="tab ${l.game === g ? 'active' : ''}" data-game="${g}">${GAME_LABEL[g]}</button>`).join('')}
        </div>
        <input type="hidden" name="game" value="${esc(l.game)}">

        <h2 class="step">1. ¿Qué carta vendes?</h2>
        <div class="field">
          <label>Nombre de la carta</label>
          <div style="display:flex; gap:.5rem">
            <input name="card_name" required maxlength="120" value="${esc(l.card_name)}" placeholder="ej. Charizard ex / Dark Magician" autocomplete="off">
            <button type="button" class="btn" id="lookup">Buscar</button>
          </div>
          <div class="card-meta" style="margin-top:.3rem">Escribe y elige tu carta exacta (edición y rareza): rellenamos los datos, la imagen oficial y el precio estimado de mercado. Puedes afinar con el número (ej. "Pikachu 25", "Charizard ex 199/165") o el código de edición de Yu-Gi-Oh! (ej. "LOB-EN001").</div>
          <div class="lookup-results" id="results"></div>
        </div>
        <div id="refBox"></div>

        <div class="row">
          <div class="field"><label>Expansión / set</label><input name="set_name" maxlength="120" value="${esc(l.set_name)}"></div>
          <div class="field"><label>Código / número</label><input name="card_code" maxlength="40" value="${esc(l.card_code)}" placeholder="ej. 199/165 · LOB-005"></div>
          <div class="field"><label>Rareza</label><input name="rarity" maxlength="60" value="${esc(l.rarity)}"></div>
        </div>

        <h2 class="step">2. Fotos reales de tu carta <span class="req" id="photoReq"></span></h2>
        <p class="card-meta" style="margin-top:-.4rem">Sube hasta ${MAX_PHOTOS} fotos de <b>tu</b> carta (frente y reverso, con buena luz). Los compradores las verán al abrir la publicación.
          <span id="photoRule"></span></p>
        <div class="photo-grid" id="photoGrid"></div>
        <input type="file" id="photoInput" accept="image/jpeg,image/png,image/webp" multiple hidden>

        <h2 class="step">3. Estado y precio</h2>
        <div class="row">
          <div class="field"><label>Estado</label><select name="condition">
            ${Object.entries(CONDITIONS).map(([k, v]) => `<option value="${k}" ${l.condition === k ? 'selected' : ''}>${k} — ${v}</option>`).join('')}
          </select></div>
          <div class="field"><label>Idioma</label><select name="language">
            ${LANGUAGES.map(x => `<option ${l.language === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select></div>
          <div class="field"><label>Precio (MXN)</label><input name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(l.price)}">
            <div class="card-meta" id="priceHint"></div></div>
          <div class="field"><label>Cantidad</label><input name="quantity" type="number" inputmode="numeric" min="0" max="999" step="1" required value="${esc(l.quantity)}"></div>
        </div>
        <div class="field"><label>Notas para el comprador</label><textarea name="notes" rows="3" maxlength="1000" placeholder="Detalles, envío, intercambios…">${esc(l.notes)}</textarea></div>
        <div class="error" id="err"></div>
        <div class="actions">
          <button class="btn primary" id="submitBtn">${id ? 'Guardar cambios' : 'Publicar carta'}</button>
          <a class="btn" href="#/mis-cartas">Cancelar</a>
        </div>
      </form>
    </div>`;

  const f = document.getElementById('f');
  const box = document.getElementById('results');

  // --- Carta de referencia y precio estimado ---
  function renderRef() {
    const el = document.getElementById('refBox');
    if (!ref) { el.innerHTML = ''; renderPriceHint(); return; }
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
    renderPriceHint();
  }
  function renderPriceHint() {
    const hint = document.getElementById('priceHint');
    const price = Number(f.price.value);
    hint.innerHTML = ref?.market_price
      ? `Mercado: ${money(ref.market_price)}${f.price.value ? ' · ' + marketCompare(price, ref.market_price) : ''}`
      : '';
    updatePhotoRule(); // el precio o la carta elegida cambian si las fotos son obligatorias
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
        box.innerHTML = ''; renderRef();
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
  const photos = setupPhotos(l.photos);

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
      <p class="muted">Tu ID de jugador solo lo ven quienes organizan los torneos en los que te inscribes. <a href="#/torneos">Ir a torneos</a></p>
      ${pokemonIdForm(u.pokemon_id || '')}
    </div>`;
  bindPokemonIdForm(viewProfile);
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
      <span><span class="badge t-${t.status}">${T_STATUS[t.status]}${t.status === 'running' ? ` · ronda ${t.current_round}` : ''}</span>
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
    <div class="t-hero">
      ${emblemSVG()}
      <div>
        <span class="kicker">⚔ Torneos locales Pokémon ⚔</span>
        <h1>La arena del reino</h1>
        <p class="muted">Vincula tu ID de jugador, inscríbete en torneos de tu zona y entérate al instante de contra quién juegas cada ronda.</p>
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
            <p class="muted">${me.pokemon_id ? `ID vinculado: <b>${esc(me.pokemon_id)}</b>` : 'Aún no vinculas tu ID de jugador.'}</p>
          </div>
          <div class="stat-row">
            <div class="tstat win"><b>${o.wins}</b><span>Victorias</span></div>
            <div class="tstat loss"><b>${o.losses}</b><span>Derrotas</span></div>
            <div class="tstat"><b>${o.ties}</b><span>Empates</span></div>
            <div class="tstat"><b>${o.best_win_streak}</b><span>Mejor racha</span></div>
          </div>
        </div>
        <p class="streak-line"><b>Racha actual:</b> ${streakText(o)} ${pills(o.last)}</p>
        ${pokemonIdForm(me.pokemon_id)}
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
}

function viewTournamentForm() {
  if (!requireLogin()) return;
  $app.innerHTML = `
    <p><a href="#/torneos">← Torneos</a></p>
    <div class="panel auth">
      <h1>Organizar torneo</h1>
      <p class="muted">Crea el torneo, comparte el enlace con los jugadores y genera las rondas el día del evento.</p>
      <form id="f">
        <div class="field"><label>Nombre</label><input name="name" required minlength="3" maxlength="80" placeholder="ej. Liga de la Tienda · Noviembre"></div>
        <div class="field"><label>Lugar</label><input name="location" maxlength="80" placeholder="ej. Tienda Dragón, Col. Roma"></div>
        <div class="row">
          <div class="field"><label>Fecha y hora</label><input name="starts_at" type="datetime-local" required></div>
          <div class="field"><label>Rondas (0 = libre)</label><input name="rounds" type="number" min="0" max="15" value="0"></div>
        </div>
        <div class="error" id="err"></div>
        <button class="btn primary">Crear torneo</button>
      </form>
    </div>`;
  const f = document.getElementById('f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { tournament } = await api('/api/tournaments', { method: 'POST', body: formData(f) });
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
  const resultCell = (m, round) => {
    if (m.bye) return '<span class="badge cond">Bye</span>';
    if (!isTdf && d.can_manage && t.status === 'running' && round === t.current_round) {
      return `<select data-res="${round}/${m.table_no}">
        ${[['', 'Pendiente'], ['p1', `Gana ${m.player1.display_name}`], ['p2', `Gana ${m.player2.display_name}`], ['tie', 'Empate']]
          .map(([v, txt]) => `<option value="${v}" ${(m.result || '') === v ? 'selected' : ''}>${esc(txt)}</option>`).join('')}
      </select>`;
    }
    if (!m.result) return '<span class="muted">En juego</span>';
    return m.result === 'tie' ? 'Empate' : `Gana ${esc((m.result === 'p1' ? m.player1 : m.player2)?.display_name)}`;
  };

  $app.innerHTML = `
    <p><a href="#/torneos">← Torneos</a></p>
    <div class="t-hero">
      ${emblemSVG()}
      <div>
        <span class="badge t-${t.status}">${T_STATUS[t.status]}${t.status !== 'registration' && !isTdf ? ` · ronda ${t.current_round}${t.rounds ? ` de ${t.rounds}` : ''}` : ''}</span>
        ${isTdf ? `<span class="badge t-tom">Importado de TOM</span> ${(t.categories || []).map(c => `<span class="badge cond">${esc(c)}</span>`).join(' ')}` : ''}
        <h1>${esc(t.name)}</h1>
        <p class="muted">📅 ${fmtDate(t.starts_at)}${t.location ? ` · 📍 ${esc(t.location)}` : ''} · 👥 ${t.player_count} jugador(es) ·
          ${isTdf ? `organiza ${esc(t.organizer_tom || '—')} · importado por @${esc(t.organizer_username)}` : `organiza @${esc(t.organizer_username)}`}</p>
      </div>
      <div class="t-actions">
        ${t.status === 'registration' && currentUser
          ? (me.joined ? '<button class="btn" id="leave">Salir del torneo</button>' : '<button class="btn primary" id="join">Inscribirme</button>')
          : ''}
        ${!currentUser && t.status === 'registration' ? '<a class="btn primary" href="#/login">Inicia sesión para inscribirte</a>' : ''}
      </div>
    </div>
    <div class="error" id="err"></div>

    ${currentUser && !currentUser.pokemon_id && t.status === 'registration' && !me.joined
      ? `<div class="panel">${pokemonIdForm('')}</div>` : ''}

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

    ${d.can_manage && !isTdf ? `
      <div class="panel organizer">
        <h2>Panel de organizador</h2>
        <p class="muted">${t.status === 'registration' ? 'Cuando estén todos, genera la ronda 1: se cierran las inscripciones y se emparejan al azar.'
          : t.status === 'running' ? 'Captura los resultados de la ronda; cuando estén completos genera la siguiente (emparejamiento suizo por puntos, sin revanchas).'
          : 'Torneo terminado.'}</p>
        <div class="t-actions">
          ${t.status !== 'finished' && !(t.rounds && t.current_round >= t.rounds)
            ? `<button class="btn primary" id="nextRound" ${t.status === 'running' && !d.round_complete ? 'disabled' : ''}>${t.status === 'registration' ? 'Empezar · generar ronda 1' : `Generar ronda ${t.current_round + 1}`}</button>` : ''}
          ${t.status === 'running' ? `<button class="btn" id="finish" ${d.round_complete ? '' : 'disabled'}>Finalizar torneo</button>` : ''}
          ${t.status === 'registration' ? '<button class="btn danger" id="del">Borrar torneo</button>' : ''}
        </div>
      </div>` : ''}

    ${d.rounds.length ? [...d.rounds].reverse().map(r => `
      <h2>${esc(r.label || `Ronda ${r.round}`)}${multiCat ? ` · ${esc(r.category)}` : ''}${r.round === lastRound[r.category || ''] && t.status === 'running' ? ' <span class="badge t-running">en curso</span>' : ''}</h2>
      <div class="panel" style="overflow-x:auto">
        <table class="mine pairings"><thead><tr><th>Mesa</th><th>Jugador 1</th><th></th><th>Jugador 2</th><th>Resultado</th></tr></thead>
        <tbody>${r.matches.map(m => `<tr class="${[m.player1, m.player2].some(isMe) ? 'mine-row' : ''}">
          <td>${m.table_no}</td><td>${nameOf(m.player1)}</td><td class="muted">vs</td>
          <td>${m.bye ? '<span class="muted">— bye —</span>' : nameOf(m.player2)}</td><td>${resultCell(m, r.round)}</td></tr>`).join('')}</tbody></table>
      </div>`).join('') : ''}

    ${t.status !== 'registration' ? `
      <h2>Clasificación</h2>
      <div class="panel" style="overflow-x:auto">
        ${isTdf ? '<p class="card-meta">Lugar oficial calculado por TOM. Récord con top cut incluido; puntos y % de rivales solo del suizo.</p>' : ''}
        <table class="mine"><thead><tr><th>#</th><th>Jugador</th>${multiCat ? '<th>Categoría</th>' : ''}<th>Récord</th><th>Puntos</th><th>% rivales</th></tr></thead>
        <tbody>${d.standings.map(s => `<tr class="${isMe(s) ? 'mine-row' : ''}">
          <td>${s.place}${s.place === 1 && t.status === 'finished' ? ' 👑' : ''}</td><td>${nameOf(s)}</td>${multiCat ? `<td>${esc(s.category)}</td>` : ''}
          <td>${record(s)}</td><td><b>${s.points}</b></td><td>${s.opp_win_pct}%</td></tr>`).join('')}</tbody></table>
      </div>` : ''}

    <h2>${isTdf ? 'Jugadores' : 'Jugadores inscritos'} (${d.players.length})</h2>
    ${isTdf ? '<p class="muted">Los jugadores con cuenta en la app aparecen con su usuario; los demás, con nombre e inicial del apellido.</p>' : ''}
    ${d.players.length ? `<div class="panel" style="overflow-x:auto">
      <table class="mine"><thead><tr><th>Jugador</th>${isTdf ? '<th>Categoría</th>' : '<th>Zona</th>'}${d.can_manage ? '<th>ID Pokémon</th>' : ''}</tr></thead>
      <tbody>${d.players.map(p => `<tr class="${isMe(p) ? 'mine-row' : ''}"><td>${nameOf(p)}</td><td>${esc((isTdf ? p.category : p.location) || '—')}</td>${d.can_manage ? `<td>${esc(p.pokemon_id || '—')}</td>` : ''}</tr>`).join('')}</tbody></table>
    </div>` : '<p class="muted">Todavía no hay jugadores inscritos.</p>'}`;

  const reload = () => viewTournament(id);
  const act = (elId, fn) => document.getElementById(elId)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await fn(); } catch (err) { document.getElementById('err').textContent = err.message; e.currentTarget.disabled = false; }
  });
  act('join', async () => { await api(`/api/tournaments/${id}/join`, { method: 'POST' }); toast('¡Inscrito! Suerte en la arena'); reload(); });
  act('leave', async () => { await api(`/api/tournaments/${id}/leave`, { method: 'POST' }); toast('Saliste del torneo'); reload(); });
  act('nextRound', async () => { const { round } = await api(`/api/tournaments/${id}/rounds`, { method: 'POST' }); toast(`Ronda ${round} emparejada`); reload(); });
  act('finish', async () => {
    if (!confirm('¿Finalizar el torneo? Ya no se podrán generar más rondas.')) { document.getElementById('finish').disabled = false; return; }
    await api(`/api/tournaments/${id}/finish`, { method: 'POST' }); toast('Torneo finalizado'); reload();
  });
  act('del', async () => {
    const msg = isTdf ? '¿Quitar este torneo importado? Podrás volver a importarlo con el TDF.' : '¿Borrar este torneo? No se puede deshacer.';
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
  bindPokemonIdForm(reload);
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
    <div class="hero">
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
    <div class="hero">
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

  $app.innerHTML = `
    <p><a href="${id ? `#/decks/${id}` : '#/decks'}">← ${id ? 'Volver al deck' : 'Mis decks'}</a></p>
    <div class="panel form-wide deck-editor">
      <h1>${id ? 'Editar deck' : 'Nuevo deck'}</h1>
      <div class="row">
        <div class="field"><label>Nombre del deck</label><input id="dName" maxlength="60" value="${esc(deck.name)}" placeholder="ej. Charizard ex · Dragapult"></div>
        <div class="field"><label>Juego</label>
          <div class="tabs" id="dGame">${['pokemon', 'yugioh'].map(g => `<button type="button" class="tab ${game === g ? 'active' : ''}" data-game="${g}">${GAME_LABEL[g]}</button>`).join('')}</div></div>
      </div>
      <div class="field"><label>Notas (opcional)</label><textarea id="dDesc" maxlength="1000" rows="2" placeholder="Estrategia, cambios pendientes, para qué torneo…">${esc(deck.description)}</textarea></div>
      <label class="check"><input type="checkbox" id="dPublic" ${deck.is_public ? 'checked' : ''}> 🌐 Público: cualquiera con el enlace puede verlo y aparece en tu perfil</label>

      <div class="deck-cols">
        <section>
          <h2 class="step">Buscar cartas</h2>
          <form id="dSearch" class="deck-search">
            <input id="dq" placeholder="ej. Charizard ex, Ultra Ball, Dark Magician" autocomplete="off">
            <button class="btn" type="submit">Buscar</button>
          </form>
          <p class="card-meta" id="dHint">Toca una carta para agregarla.${game === 'yugioh' ? ' Las de fusión, sincronía, XYZ y link van solas al Extra Deck.' : ''}</p>
          <div class="lookup-results deck-results" id="dResults"></div>
          <details class="deck-import">
            <summary>Importar una lista en texto</summary>
            <p class="card-meta">Pega la lista exportada de Pokémon TCG Live (o líneas como "4 Pikachu ex SVI 57" / "3 Dark Magician").
              Las cartas importadas no traen imagen ni precio; puedes reemplazarlas buscándolas.</p>
            <textarea id="dImport" rows="6" placeholder="Pokémon: 12&#10;4 Charmander PAF 7&#10;…"></textarea>
            <button type="button" class="btn small" id="dImportBtn">Agregar al deck</button>
          </details>
        </section>
        <section>
          <h2 class="step">Tu deck</h2>
          <div id="dSummary"></div>
          <div id="dList"></div>
        </section>
      </div>
      <p class="error" id="dErr"></p>
      <div class="t-actions deck-save">
        <button class="btn primary" id="dSave">${id ? 'Guardar cambios' : 'Guardar deck'}</button>
        <a class="btn" href="${id ? `#/decks/${id}` : '#/decks'}" id="dCancel">Cancelar</a>
      </div>
    </div>`;

  const $list = document.getElementById('dList'), $sum = document.getElementById('dSummary'), $res = document.getElementById('dResults');
  const touch = () => { dirty = true; paint(); };

  function paint() {
    const s = deckSummary(game, cards);
    if (fx && s.value_usd) s.value_mxn = Math.round(s.value_usd * fx.rate * 100) / 100;
    $sum.innerHTML = summaryBox(game, s, fx);
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
    game = b.dataset.game; cards = []; $res.innerHTML = '';
    document.querySelectorAll('#dGame .tab').forEach(t => t.classList.toggle('active', t === b));
    document.getElementById('dHint').textContent = 'Toca una carta para agregarla.' +
      (game === 'yugioh' ? ' Las de fusión, sincronía, XYZ y link van solas al Extra Deck.' : '');
    touch();
  });

  // Búsqueda (mismo buscador que al vender: páginas con "Ver más")
  let found = [], query = '', source = '';
  async function search(page) {
    if (page === 1) { found = []; $res.innerHTML = '<div class="lookup-count muted">Buscando…</div>'; }
    try {
      const qs = new URLSearchParams({ game, q: query, page, ...(page > 1 && source ? { source } : {}) });
      const r = await api(`/api/lookup?${qs}`);
      if (page === 1) source = r.source || '';
      if (r.fx) fx = r.fx;
      found.push(...r.results);
      $res.innerHTML = found.length ? `
        <div class="lookup-count muted">${found.length}${r.has_more ? '+' : ''} resultado(s)</div>
        ${found.map((c, i) => `
          <button type="button" data-add="${i}" title="Agregar ${esc(c.card_name)}">
            ${safeImg(c.image_small || c.image_url) ? `<img src="${esc(c.image_small || c.image_url)}" alt="" loading="lazy">` : '<span class="no-img">✦</span>'}
            <b>${esc(c.card_name)}</b>
            <div class="muted">${esc([c.set_name, c.card_code].filter(Boolean).join(' · '))}</div>
            <span class="add-badge">+ Agregar</span>
          </button>`).join('')}
        ${r.has_more ? `<button type="button" class="btn small more" data-more="${page + 1}">Ver más resultados</button>` : ''}`
        : '<div class="lookup-count muted">Sin resultados. Prueba con el nombre en inglés o con el número de la carta.</div>';
    } catch (err) { $res.innerHTML = `<div class="lookup-count error">${esc(err.message)}</div>`; }
  }
  document.getElementById('dSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    query = document.getElementById('dq').value.trim();
    if (query.length < 2) { toast('Escribe al menos 2 letras'); return; }
    search(1);
  });
  $res.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { more.disabled = true; more.textContent = 'Cargando…'; search(Number(more.dataset.more)); return; }
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
    b.classList.add('added'); setTimeout(() => b.classList.remove('added'), 500);
    toast(`+1 ${r.card_name}`); touch();
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
  document.getElementById('dCancel').addEventListener('click', (e) => {
    if (dirty && !confirm('Tienes cambios sin guardar. ¿Salir sin guardar?')) e.preventDefault();
  });
  document.getElementById('dSave').addEventListener('click', async (e) => {
    const btn = e.currentTarget, err = document.getElementById('dErr');
    btn.disabled = true; err.textContent = '';
    try {
      const body = { name: document.getElementById('dName').value, game, description: document.getElementById('dDesc').value,
                     is_public: document.getElementById('dPublic').checked, cards };
      const { deck: saved } = await api(id ? `/api/decks/${id}` : '/api/decks', { method: id ? 'PUT' : 'POST', body });
      dirty = false; toast(id ? 'Deck guardado' : '¡Deck creado!'); go(`#/decks/${saved.id}`);
    } catch (e2) { err.textContent = e2.message; btn.disabled = false; }
  });

  paint();
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
    <div class="hero"><div><h1>🛡 Administración</h1>
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
          <td>${coverImg(l) ? `<img src="${esc(coverImg(l))}" alt="">` : ''}</td>
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

async function router() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  window.scrollTo(0, 0);
  refreshMatchBanner();
  try {
    switch (parts[0]) {
      case undefined: return await viewCatalog(params);
      case 'carta': return await viewListing(parts[1]);
      case 'vendedor': return await viewSeller(decodeURIComponent(parts[1] || ''));
      case 'registro': return viewRegister();
      case 'login': return viewLogin();
      case 'mis-cartas': return await viewMine();
      case 'vender': return await viewListingForm();
      case 'vender-accesorio': return await viewListingForm(null, 'accessory');
      case 'accesorios': return await viewAccessories(params);
      case 'editar': return await viewListingForm(parts[1]);
      case 'perfil': return viewProfile();
      case 'torneos': return parts[1] === 'nuevo' ? viewTournamentForm() : parts[1] === 'importar' ? viewTdfImport() : await viewTournaments();
      case 'torneo': return await viewTournament(parts[1]);
      case 'admin': return await viewAdmin(params);
      case 'decks':
        if (parts[1] === 'nuevo') return await viewDeckEditor();
        if (parts[1] && parts[2] === 'editar') return await viewDeckEditor(parts[1]);
        if (parts[1]) return await viewDeck(parts[1]);
        return await viewDecks();
      default: $app.innerHTML = '<div class="empty">Página no encontrada. <a href="#/">Ir al catálogo</a></div>';
    }
  } catch (err) {
    $app.innerHTML = `<div class="empty">${esc(err.message)} <br><a href="#/">Ir al catálogo</a></div>`;
  }
}

(async () => {
  ({ user: currentUser } = await api('/api/auth/me'));
  renderNav();
  window.addEventListener('hashchange', router);
  router();
})();
