// TCG Market — SPA en JavaScript puro con rutas por hash (#/...)
import { sceneSVG } from './scene.js';

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
const money = (n) => new Intl.NumberFormat('es', { style: 'currency', currency: 'USD' }).format(n);
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

// Reduce las fotos en el navegador antes de subirlas (máx. 1600 px, JPEG)
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
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
    ? `<a class="btn primary small" href="#/vender">+ Vender carta</a>
       <a class="btn small" href="#/mis-cartas">Mis cartas</a>
       <a class="btn small" href="#/perfil">Mi perfil</a>
       <span class="nav-user">@${esc(currentUser.username)}</span>
       <button class="btn small" id="logout">Salir</button>`
    : `<a class="btn small" href="#/login">Iniciar sesión</a>
       <a class="btn primary small" href="#/registro">Crear cuenta</a>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    currentUser = null; renderNav(); toast('Sesión cerrada'); go('#/');
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
        ${l.market_price ? `<div class="card-meta">Mercado: ${money(l.market_price)}</div>` : ''}
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
        ${l.photos.length ? `<p class="card-meta">📷 ${l.photos.length} foto(s) real(es) subidas por el vendedor.</p>` : ''}
      </div>
      <div>
        <span class="badge ${l.game}">${GAME_LABEL[l.game]}</span>
        ${l.status === 'sold' ? '<span class="badge sold">Vendida</span>' : ''}
        <h1>${esc(l.card_name)}</h1>
        <div class="price" style="font-size:1.8rem">${money(l.price)}</div>
        ${l.market_price ? `
          <div class="market-box">
            <div><span class="muted">Precio estimado de mercado</span> <b>${money(l.market_price)}</b> ${marketCompare(l.price, l.market_price)}</div>
            <div class="card-meta">Fuente: ${esc(l.market_source)} · actualizado ${new Date(l.market_updated).toLocaleDateString('es')}. Es una referencia, no un precio garantizado.</div>
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

function viewRegister() {
  $app.innerHTML = `
    <div class="panel auth">
      <h1>Crear cuenta</h1>
      <p class="muted">Regístrate para publicar las cartas que vendes.</p>
      <form id="f">
        <div class="field"><label>Usuario</label><input name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_]+" autocomplete="username" placeholder="ej. ash_ketchum"></div>
        <div class="field"><label>Nombre visible</label><input name="display_name" maxlength="60" placeholder="Opcional"></div>
        <div class="field"><label>Correo electrónico</label><input name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label>Contraseña (mín. 8 caracteres)</label><input name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="row">
          <div class="field"><label>Ciudad / zona</label><input name="location" maxlength="80" placeholder="Opcional"></div>
          <div class="field"><label>Contacto para compradores</label><input name="contact" maxlength="120" placeholder="WhatsApp, Instagram…"></div>
        </div>
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
    const l = listings.find(x => x.id === Number(b.dataset.toggle));
    await api(`/api/listings/${l.id}/status`, { method: 'PATCH', body: { status: l.status === 'sold' ? 'available' : 'sold' } });
    toast('Publicación actualizada'); viewMine();
  }));
}

async function viewListingForm(id) {
  if (!requireLogin()) return;
  const l = id ? (await api(`/api/listings/${id}`)).listing : {
    game: 'pokemon', condition: 'NM', language: 'Español', quantity: 1, price: '',
  };
  if (id && l.user_id !== currentUser.id) { $app.innerHTML = '<div class="empty">Esta publicación no es tuya.</div>'; return; }

  // Estado del formulario: carta de referencia elegida y fotos
  let ref = l.ref_id ? { ref_id: l.ref_id, image: l.image_url, market_price: l.market_price, market_source: l.market_source } : null;
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
          <div class="card-meta" style="margin-top:.3rem">Escribe y elige tu carta exacta (edición y rareza): rellenamos los datos, la imagen oficial y el precio estimado de mercado.</div>
          <div class="lookup-results" id="results"></div>
        </div>
        <div id="refBox"></div>

        <div class="row">
          <div class="field"><label>Expansión / set</label><input name="set_name" maxlength="120" value="${esc(l.set_name)}"></div>
          <div class="field"><label>Código / número</label><input name="card_code" maxlength="40" value="${esc(l.card_code)}" placeholder="ej. 199/165 · LOB-005"></div>
          <div class="field"><label>Rareza</label><input name="rarity" maxlength="60" value="${esc(l.rarity)}"></div>
        </div>

        <h2 class="step">2. Fotos reales de tu carta <span class="req">obligatorio</span></h2>
        <p class="card-meta" style="margin-top:-.4rem">Sube de 1 a ${MAX_PHOTOS} fotos de <b>tu</b> carta (frente y reverso, con buena luz). Los compradores las verán al abrir la publicación.</p>
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
          <div class="field"><label>Precio (USD)</label><input name="price" type="number" min="0" step="0.01" required value="${esc(l.price)}">
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
            ? `<div class="est">Precio estimado de mercado: <b>${money(ref.market_price)}</b> <span class="card-meta">(${esc(ref.market_source || 'TCGplayer')})</span></div>
               <button type="button" class="btn small" id="usePrice">Usar este precio</button>`
            : '<div class="card-meta">No hay precio de mercado disponible para esta edición.</div>'}
          <button type="button" class="btn small" id="clearRef">Quitar selección</button>
        </div>
      </div>`;
    document.getElementById('usePrice')?.addEventListener('click', () => { f.price.value = ref.market_price.toFixed(2); renderPriceHint(); });
    document.getElementById('clearRef').addEventListener('click', () => { ref = null; renderRef(); });
    renderPriceHint();
  }
  function renderPriceHint() {
    const hint = document.getElementById('priceHint');
    const price = Number(f.price.value);
    hint.innerHTML = ref?.market_price
      ? `Mercado: ${money(ref.market_price)}${f.price.value ? ' · ' + marketCompare(price, ref.market_price) : ''}`
      : '';
  }
  f.price.addEventListener('input', renderPriceHint);

  async function search() {
    const name = f.card_name.value.trim();
    if (name.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="muted">Buscando…</span>';
    const game = f.game.value;
    try {
      const { results } = await api(`/api/lookup?${new URLSearchParams({ game, q: name })}`);
      if (f.game.value !== game || f.card_name.value.trim() !== name) return; // llegó una búsqueda más nueva
      if (!results.length) { box.innerHTML = '<span class="muted">Sin resultados. Puedes rellenar los datos a mano.</span>'; return; }
      box.innerHTML = results.map((r, i) => `
        <button type="button" data-i="${i}">
          ${r.image_small ? `<img src="${esc(r.image_small)}" alt="" loading="lazy">` : ''}
          <b>${esc(r.card_name)}</b><br>
          <span class="muted">${esc(r.set_name)} ${esc(r.card_code)}</span><br>
          <span class="muted">${esc(r.rarity)}</span>
          ${r.market_price ? `<div class="est-chip">${money(r.market_price)}</div>` : ''}
        </button>`).join('');
      box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        const r = results[b.dataset.i];
        for (const k of ['card_name', 'set_name', 'card_code', 'rarity']) f[k].value = r[k] || '';
        ref = { ref_id: r.ref_id, image: r.image_small || r.image_url, market_price: r.market_price, market_source: r.market_source };
        box.innerHTML = ''; renderRef();
        if (!f.price.value && r.market_price) { f.price.value = r.market_price.toFixed(2); renderPriceHint(); }
      }));
    } catch (err) {
      box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
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

  renderRef();
  renderPhotos();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    const body = formData(f);
    if (!body.card_name.trim()) { err.textContent = 'Escribe el nombre de la carta.'; return; }
    if (keepPhotos.length + newPhotos.length < 1) { err.textContent = 'Sube al menos una foto real de tu carta.'; return; }
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
        <div class="field"><label>Nombre visible</label><input name="display_name" maxlength="60" value="${esc(u.display_name)}"></div>
        <div class="field"><label>Ciudad / zona</label><input name="location" maxlength="80" value="${esc(u.location)}"></div>
        <div class="field"><label>Contacto para compradores</label><input name="contact" maxlength="120" value="${esc(u.contact)}" placeholder="WhatsApp, Instagram, correo…"></div>
        <div class="error" id="err"></div>
        <button class="btn primary">Guardar</button>
      </form>
    </div>`;
  const f = document.getElementById('f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      ({ user: currentUser } = await api('/api/auth/me', { method: 'PUT', body: formData(f) }));
      renderNav(); toast('Perfil actualizado');
    } catch (err) { document.getElementById('err').textContent = err.message; }
  });
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
