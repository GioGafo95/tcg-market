// Macai TCG — SPA en JavaScript puro con rutas por hash (#/...)
import { sceneSVG, emblemSVG } from './scene.js';

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

const GAME_LABEL = { pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' };
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
    ? `<a class="btn small" href="#/torneos">⚔ Torneos</a>
       <a class="btn primary small" href="#/vender">+ Vender carta</a>
       <a class="btn small" href="#/mis-cartas">Mis cartas</a>
       <a class="btn small" href="#/perfil">Mi perfil</a>
       <span class="nav-user">@${esc(currentUser.username)}</span>
       <button class="btn small" id="logout">Salir</button>`
    : `<a class="btn small" href="#/torneos">⚔ Torneos</a>
       <a class="btn small" href="#/login">Iniciar sesión</a>
       <a class="btn primary small" href="#/registro">Crear cuenta</a>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    currentUser = null; renderNav(); refreshMatchBanner(); toast('Sesión cerrada'); go('#/');
  });
}

function cardTile(l, { showSeller = true } = {}) {
  const img = coverImg(l);
  return `
    <a class="card" href="#/carta/${l.id}">
      <div class="card-img">${img ? `<img src="${esc(img)}" alt="${esc(l.card_name)}" loading="lazy">`
                                  : `<span class="placeholder">✦</span>`}
        ${l.photo_count ? `<span class="photo-badge" title="Fotos reales del vendedor">📷 ${l.photo_count}</span>` : ''}</div>
      <div class="card-body">
        <div><span class="badge ${l.game}">${GAME_LABEL[l.game]}</span>
             <span class="badge cond" title="${esc(CONDITIONS[l.condition])}">${esc(l.condition)}</span></div>
        <div class="card-name">${esc(l.card_name)}</div>
        <div class="card-meta">${esc([l.set_name, l.card_code, l.rarity].filter(Boolean).join(' · '))}</div>
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
  const condition = params.get('condition') || '';
  const sort = params.get('sort') || '';

  const qs = new URLSearchParams({ game, q, condition, sort });
  const [{ listings }, stats] = await Promise.all([api(`/api/listings?${qs}`), api('/api/stats')]);
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
      <select name="condition">
        <option value="">Cualquier estado</option>
        ${Object.entries(CONDITIONS).map(([k, v]) =>
          `<option value="${k}" ${condition === k ? 'selected' : ''}>${k} — ${v}</option>`).join('')}
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
  $app.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => update({ game: b.dataset.game })));
  const form = document.getElementById('filters');
  form.addEventListener('submit', e => { e.preventDefault(); update({}); });
  form.querySelectorAll('select').forEach(s => s.addEventListener('change', () => update({})));
  form.q.addEventListener('search', () => update({})); // al pulsar la X de limpiar
  document.getElementById('exploreBtn').addEventListener('click', e => {
    e.preventDefault(); document.getElementById('catalogo').scrollIntoView({ behavior: 'smooth' });
  });
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
  $app.innerHTML = `
    <p><a href="#/">← Volver al catálogo</a></p>
    <div class="detail">
      <div>
        <div class="gallery-main">
          ${first ? `<img id="mainImg" src="${esc(first.url)}" alt="${esc(l.card_name)}">` : `<span class="placeholder">✦</span>`}
          ${first ? `<span class="gallery-label ${first.real ? 'real' : ''}" id="mainLabel">${esc(first.label)}</span>` : ''}
        </div>
        ${gallery.length > 1 ? `<div class="thumbs">${gallery.map((g, i) => `
          <button type="button" class="thumb ${i === 0 ? 'active' : ''}" data-i="${i}" title="${esc(g.label)}">
            <img src="${esc(g.url)}" alt=""><span>${g.real ? '📷' : 'Oficial'}</span>
          </button>`).join('')}</div>` : ''}
        ${l.photos.length ? `<p class="card-meta">📷 ${l.photos.length} foto(s) real(es) subidas por el vendedor.</p>`
          : '<p class="card-meta">Sin fotos reales: en cartas de bajo valor son opcionales. La imagen es la oficial de referencia; pide fotos al vendedor si las necesitas.</p>'}
      </div>
      <div>
        <span class="badge ${l.game}">${GAME_LABEL[l.game]}</span>
        ${l.status === 'sold' ? '<span class="badge sold">Vendida</span>' : ''}
        <h1>${esc(l.card_name)}</h1>
        <div class="price" style="font-size:1.8rem">${money(l.price)}</div>
        ${l.market_price_mxn ? `
          <div class="market-box">
            <div><span class="muted">Precio estimado de mercado</span> <b>${money(l.market_price_mxn)}</b> ${marketCompare(l.price, l.market_price_mxn)}</div>
            <div class="card-meta">${esc(l.market_source)}: ${usd(l.market_price_usd)} (consultado el ${new Date(l.market_updated).toLocaleDateString('es-MX')}),
              convertido con ${fxNote(l.fx)}. Es una referencia, no un precio garantizado.</div>
          </div>` : ''}
        <dl class="specs">
          <dt>Expansión</dt><dd>${esc(l.set_name) || '—'}</dd>
          <dt>Código</dt><dd>${esc(l.card_code) || '—'}</dd>
          <dt>Rareza</dt><dd>${esc(l.rarity) || '—'}</dd>
          <dt>Estado</dt><dd>${esc(l.condition)} — ${esc(CONDITIONS[l.condition])}</dd>
          <dt>Idioma</dt><dd>${esc(l.language)}</dd>
          <dt>Disponibles</dt><dd>${l.quantity}</dd>
          <dt>Publicada</dt><dd>${new Date(l.created_at + 'Z').toLocaleDateString('es')}</dd>
        </dl>
        ${l.notes ? `<p>${esc(l.notes).replace(/\n/g, '<br>')}</p>` : ''}
        <div class="panel seller-box">
          <div class="muted">Vendedor</div>
          <div><a href="#/vendedor/${encodeURIComponent(l.username)}"><b>${esc(l.display_name)}</b> @${esc(l.username)}</a></div>
          ${l.location ? `<div class="muted">📍 ${esc(l.location)}</div>` : ''}
          ${l.contact ? `<div>Contacto: ${esc(l.contact)}</div>` : '<div class="muted">El vendedor no ha dejado un contacto.</div>'}
        </div>
        ${mine ? `<p style="margin-top:1rem"><a class="btn" href="#/editar/${l.id}">Editar mi publicación</a></p>` : ''}
      </div>
    </div>`;

  $app.querySelectorAll('.thumb').forEach(b => b.addEventListener('click', () => {
    const g = gallery[b.dataset.i];
    document.getElementById('mainImg').src = g.url;
    const label = document.getElementById('mainLabel');
    label.textContent = g.label; label.classList.toggle('real', g.real);
    $app.querySelectorAll('.thumb').forEach(x => x.classList.toggle('active', x === b));
  }));
}

async function viewSeller(username) {
  const { user, listings } = await api(`/api/users/${encodeURIComponent(username)}`);
  $app.innerHTML = `
    <p><a href="#/">← Volver al catálogo</a></p>
    <h1>${esc(user.display_name)} <span class="muted">@${esc(user.username)}</span></h1>
    <p class="muted">${user.location ? '📍 ' + esc(user.location) + ' · ' : ''}Miembro desde ${new Date(user.created_at + 'Z').toLocaleDateString('es')}
      ${user.contact ? ' · Contacto: ' + esc(user.contact) : ''}</p>
    <h2>${listings.length} carta(s) a la venta</h2>
    ${listings.length ? `<div class="grid">${listings.map(l => cardTile(l, { showSeller: false })).join('')}</div>`
                      : '<div class="empty">Este usuario no tiene cartas a la venta.</div>'}`;
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
      <div><h1>Mis cartas</h1><p class="muted">Administra las cartas que tienes a la venta.</p></div>
      <a class="btn primary" href="#/vender">+ Vender carta</a>
    </div>
    ${listings.length ? `
      <div class="panel" style="overflow-x:auto">
        <table class="mine">
          <thead><tr><th></th><th>Carta</th><th>Juego</th><th>Estado</th><th>Precio</th><th>Cant.</th><th>Publicación</th><th></th></tr></thead>
          <tbody>${listings.map(l => `
            <tr>
              <td>${coverImg(l) ? `<img src="${esc(coverImg(l))}" alt="">` : ''}</td>
              <td><a href="#/carta/${l.id}">${esc(l.card_name)}</a><div class="card-meta">${esc([l.set_name, l.card_code].filter(Boolean).join(' · '))}</div></td>
              <td><span class="badge ${l.game}">${GAME_LABEL[l.game]}</span></td>
              <td>${esc(l.condition)}</td>
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
      </div>` : `<div class="empty">Aún no has publicado cartas. <a href="#/vender">Publica tu primera carta</a>.</div>`}`;

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

async function viewListingForm(id) {
  if (!requireLogin()) return;
  const [l, fxInfo] = await Promise.all([
    id ? api(`/api/listings/${id}`).then(r => r.listing) : { game: 'pokemon', condition: 'NM', language: 'Español', quantity: 1, price: '' },
    api('/api/fx').catch(() => ({})),
  ]);
  if (id && l.user_id !== currentUser.id) { $app.innerHTML = '<div class="empty">Esta publicación no es tuya.</div>'; return; }
  // Fotos obligatorias solo si la carta vale más de US$2.50 (mercado o precio del vendedor; el servidor lo vuelve a revisar)
  const PHOTO_MIN_USD = fxInfo.photos?.min_usd ?? 2.5;
  const usdRate = fxInfo.fx?.rate || fxInfo.photos?.fallback_rate || 17;

  // Estado del formulario: carta de referencia elegida y fotos
  // ref.market_price está en MXN (convertido en el servidor); ref.usd es el valor original de TCGplayer
  let ref = l.ref_id ? { ref_id: l.ref_id, image: l.image_url, market_price: l.market_price_mxn, usd: l.market_price_usd,
                         market_source: l.market_source, fx: l.fx } : null;
  let keepPhotos = (l.photos || []).map(p => ({ ...p }));
  let newPhotos = []; // data URLs comprimidas

  $app.innerHTML = `
    <p><a href="#/mis-cartas">← Mis cartas</a></p>
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
          <div class="field"><label>Precio (MXN)</label><input name="price" type="number" min="0" step="0.01" required value="${esc(l.price)}">
            <div class="card-meta" id="priceHint"></div></div>
          <div class="field"><label>Cantidad</label><input name="quantity" type="number" min="0" max="999" step="1" required value="${esc(l.quantity)}"></div>
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
  const photoInput = document.getElementById('photoInput');
  function renderPhotos() {
    const total = keepPhotos.length + newPhotos.length;
    document.getElementById('photoGrid').innerHTML = `
      ${keepPhotos.map((p, i) => `<div class="photo"><img src="${esc(p.url)}" alt=""><button type="button" data-keep="${i}" title="Quitar">✕</button></div>`).join('')}
      ${newPhotos.map((p, i) => `<div class="photo"><img src="${p}" alt=""><button type="button" data-new="${i}" title="Quitar">✕</button></div>`).join('')}
      ${total < MAX_PHOTOS ? `<button type="button" class="photo add" id="addPhoto">＋<span>${total ? 'Añadir otra' : 'Subir fotos'}</span></button>` : ''}`;
    document.getElementById('addPhoto')?.addEventListener('click', () => photoInput.click());
    document.querySelectorAll('[data-keep]').forEach(b => b.addEventListener('click', () => { keepPhotos.splice(b.dataset.keep, 1); renderPhotos(); }));
    document.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => { newPhotos.splice(b.dataset.new, 1); renderPhotos(); }));
  }
  photoInput.addEventListener('change', async () => {
    const files = [...photoInput.files].slice(0, MAX_PHOTOS - keepPhotos.length - newPhotos.length);
    photoInput.value = '';
    for (const file of files) {
      try { newPhotos.push(await compressImage(file)); }
      catch { toast(`No se pudo leer ${file.name}`); }
    }
    renderPhotos();
  });

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
  renderPhotos();
  updatePhotoRule();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    const body = formData(f);
    if (!body.card_name.trim()) { err.textContent = 'Escribe el nombre de la carta.'; return; }
    if (keepPhotos.length + newPhotos.length < 1 && photosNeeded()) {
      err.textContent = `Esta carta vale más de US$${PHOTO_MIN_USD.toFixed(2)}: sube al menos una foto real de tu carta.`; return;
    }
    if (body.price === '' || Number(body.price) < 0) { err.textContent = 'Indica un precio válido.'; return; }
    body.price = Number(body.price); body.quantity = Number(body.quantity);
    body.ref_id = ref?.ref_id || '';
    body.new_photos = newPhotos;
    if (id) body.keep_photos = keepPhotos.map(p => p.id);
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
      case 'editar': return await viewListingForm(parts[1]);
      case 'perfil': return viewProfile();
      case 'torneos': return parts[1] === 'nuevo' ? viewTournamentForm() : parts[1] === 'importar' ? viewTdfImport() : await viewTournaments();
      case 'torneo': return await viewTournament(parts[1]);
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
