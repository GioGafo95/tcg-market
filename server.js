import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { repo, STORAGE, putFile, deleteFile, publicUrl, uploadsHandler } from './storage/index.js';
import { searchCards, getCardByRef, cacheRefImage } from './cards.js';
import { getUsdMxn, toMxn } from './fx.js';
import { outcome, opponentOf, standings, pairRound, streaks, recommendedStructure, firstTopRound, nextTopRound, finalPlacement, RULESET } from './tournaments.js';
import { parseTdf, TdfError, shortName } from './tdf.js';
import { DECK_GAMES, SECTIONS, MAX_ENTRIES, MAX_QTY, deckSummary } from './public/deck-rules.js';
import { buildSnapshot } from './meta.js';
import { buildYgoSnapshot } from './ygo-meta.js';
import { parseLog } from './public/ptcgl-log.js';

const fxInfo = fx => (fx ? { rate: Math.round(fx.rate * 10000) / 10000, date: fx.date, source: fx.source } : null);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 30;
const SECURE_COOKIES = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

const GAMES = ['pokemon', 'yugioh'];
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
// Accesorios: categoría, estado propio y juego (o 'any' si sirve para cualquiera)
const ACC_CATEGORIES = ['sleeves', 'deckbox', 'playmat', 'binder', 'toploader', 'dice', 'storage', 'other'];
const ACC_CONDITIONS = ['NEW', 'LIKE_NEW', 'USED'];
const ACC_GAMES = [...GAMES, 'any'];
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

app.disable('x-powered-by');
// Las fotos llegan como data URLs dentro del JSON (el navegador las comprime antes de enviarlas)
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));
app.use('/uploads', uploadsHandler(express));

app.get('/healthz', (_req, res) => res.json({ ok: true, storage: STORAGE }));

// ---------- Utilidades ----------

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map(p => p.trim()).filter(Boolean).map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    })
  );
}

async function createSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await repo.createSession(token, userId, expires.toISOString());
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', expires, secure: SECURE_COOKIES });
}

const publicUser = u => u && ({
  id: u.id, username: u.username, display_name: u.display_name,
  first_name: u.first_name || '', last_name: u.last_name || '',
  location: u.location, contact: u.contact, created_at: u.created_at,
});
// Datos que solo ve el propio usuario (incluye su ID de jugador Pokémon)
const meUser = u => u && ({ ...publicUser(u), pokemon_id: u.pokemon_id || '', konami_id: u.konami_id || '', is_admin: isAdmin(u) });
// Lo que ve un administrador de cada cuenta (nunca la contraseña)
const adminUser = u => u && ({ ...meUser(u), email: u.email, blocked: !!u.blocked });

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sameId = (a, b) => String(a) === String(b);
const isAdmin = u => u?.role === 'admin';

// Datos de perfil obligatorios: nombre, apellidos, zona y teléfono de contacto
const NAME_RE = /^\p{L}[\p{L}'. -]*\p{L}\.?$/u;
function validateProfile(body) {
  const clean = (v, max) => str(v, max).replace(/\s+/g, ' ');
  const first_name = clean(body.first_name, 40);
  const last_name = clean(body.last_name, 60);
  const location = clean(body.location, 80);
  const contact = str(body.contact, 30).replace(/[\s().-]/g, '');

  if (!NAME_RE.test(first_name)) throw new HttpError(400, 'Escribe tu nombre (solo letras, mínimo 2).');
  if (!NAME_RE.test(last_name)) throw new HttpError(400, 'Escribe tus apellidos (solo letras, mínimo 2).');
  if (location.length < 2) throw new HttpError(400, 'Indica tu ciudad o zona.');
  if (!/^\+?\d{8,15}$/.test(contact))
    throw new HttpError(400, 'Escribe un número de teléfono válido (8 a 15 dígitos, puede empezar con +).');
  return { first_name, last_name, display_name: `${first_name} ${last_name}`, location, contact };
}

// Decodifica, valida (por contenido real, no solo por la extensión) y guarda una foto
function decodePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) throw new HttpError(400, 'Las fotos deben ser JPG, PNG o WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(400, 'Cada foto debe pesar menos de 4 MB.');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const type = isJpeg ? ['.jpg', 'image/jpeg'] : isPng ? ['.png', 'image/png'] : isWebp ? ['.webp', 'image/webp'] : null;
  if (!type) throw new HttpError(400, 'Una de las fotos no es una imagen válida.');
  const id = randomBytes(16).toString('hex');
  return { id, filename: id + type[0], buf, contentType: type[1] };
}

const photoKey = filename => `photos/${filename}`;

// Adjunta req.user si hay una sesión válida
app.use(async (req, _res, next) => {
  try {
    const token = parseCookies(req.headers.cookie).session;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const user = await repo.getSessionUser(token);
      // Una cuenta suspendida pierde sus sesiones al instante
      if (user && !user.blocked) { req.user = user; req.sessionToken = token; }
    }
    next();
  } catch (err) { next(err); }
});

// Tipo de cambio USD→MXN para las respuestas de la API (en caché 6 h; nunca bloquea si falla)
app.use('/api', async (req, _res, next) => {
  req.fx = await getUsdMxn().catch(() => null);
  next();
});
app.get('/api/fx', (req, res) => res.json({
  base: 'USD', quote: 'MXN', fx: fxInfo(req.fx),
  // Regla de fotos obligatorias (el formulario la usa para avisar; el servidor la vuelve a aplicar al guardar)
  photos: { min_usd: PHOTO_MIN_USD, fallback_rate: FALLBACK_USD_MXN },
}));

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
  next();
}

// ---------- Autenticación ----------

app.post('/api/auth/register', async (req, res) => {
  const username = str(req.body.username, 30);
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
    throw new HttpError(400, 'El usuario debe tener 3-30 caracteres: letras, números o _.');
  const profile = validateProfile(req.body);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo electrónico no válido.');
  if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');

  let user;
  try {
    user = await repo.createUser({ username, email, password_hash: hashPassword(password), ...profile });
  } catch (err) {
    if (err.code === 'DUPLICATE') throw new HttpError(409, 'Ese usuario o correo ya está registrado.');
    throw err;
  }
  await createSession(res, user.id);
  res.status(201).json({ user: meUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const login = str(req.body.login, 120);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = login ? await repo.findUserByLogin(login) : null;
  if (!user || !verifyPassword(password, user.password_hash))
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  if (user.blocked) throw new HttpError(403, 'Tu cuenta está suspendida. Contacta a un administrador.');
  await createSession(res, user.id);
  res.json({ user: meUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.sessionToken) await repo.deleteSession(req.sessionToken);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ user: meUser(req.user) || null }));

app.put('/api/auth/me', requireAuth, async (req, res) => {
  const user = await repo.updateUser(req.user.id, validateProfile(req.body));
  res.json({ user: meUser(user) });
});

// ---------- Búsqueda de cartas y precio estimado ----------

app.get('/api/lookup', requireAuth, async (req, res) => {
  const game = GAMES.includes(req.query.game) ? req.query.game : null;
  if (!game) throw new HttpError(400, 'Juego no válido.');
  try {
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 50);
    const source = ['pokemontcg', 'tcgdex', 'tcgdex-es', 'tcgdex-set'].includes(req.query.source) ? req.query.source : '';
    const { results, has_more, source: used = '' } = await searchCards(game, str(req.query.q, 100), page, source);
    res.json({
      results: results.map(r => ({ ...r, market_price_mxn: toMxn(r.market_price, req.fx) })),
      page, has_more, source: used,
      fx: fxInfo(req.fx),
    });
  } catch (err) {
    console.error('lookup:', err.message);
    throw new HttpError(502, 'No se pudo consultar la base de datos de cartas. Intenta de nuevo o rellena los datos a mano.');
  }
});

// ---------- Cartas en venta ----------

// Forma pública de una carta: fotos como URLs, portada y precio de mercado convertido a pesos.
// El precio del vendedor (price) se captura directamente en MXN; el de mercado se guarda en USD (TCGplayer).
function listingOut(l, fx) {
  if (!l) return l;
  const photos = (l.photos || []).map(p => ({ id: String(p.id), url: publicUrl(photoKey(p.filename)) }));
  return {
    ...l, currency: 'MXN', photos, photo_count: photos.length, cover_photo: photos[0]?.url || null,
    market_price_usd: l.market_price ?? null,
    market_price_mxn: toMxn(l.market_price, fx),
    fx: l.market_price ? fxInfo(fx) : null,
  };
}

function validateListing(body) {
  const kind = body.kind === 'accessory' ? 'accessory' : 'card';
  const game = str(body.game, 10);
  const card_name = str(body.card_name, 120);
  const price = Number(body.price);
  const quantity = body.quantity === undefined ? 1 : Number(body.quantity);

  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'El precio no es válido.');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) throw new HttpError(400, 'La cantidad no es válida.');

  // Accesorio: nombre, categoría, marca (en set_name), estado y para qué juego. Sin referencia ni precio de mercado.
  if (kind === 'accessory') {
    if (!card_name) throw new HttpError(400, 'Escribe el nombre del accesorio.');
    if (!ACC_GAMES.includes(game)) throw new HttpError(400, 'Indica para qué juego es el accesorio.');
    if (!ACC_CATEGORIES.includes(body.category)) throw new HttpError(400, 'Elige la categoría del accesorio.');
    return {
      kind, category: body.category, game, card_name,
      condition: ACC_CONDITIONS.includes(body.condition) ? body.condition : 'NEW',
      price: Math.round(price * 100) / 100, quantity,
      set_name: str(body.set_name, 120), card_code: '', rarity: '', language: '',
      notes: str(body.notes, 1000), ref_id: '',
    };
  }

  const condition = CONDITIONS.includes(body.condition) ? body.condition : 'NM';
  if (!GAMES.includes(game)) throw new HttpError(400, 'Elige un juego válido (Pokémon o Yu-Gi-Oh!).');
  if (!card_name) throw new HttpError(400, 'El nombre de la carta es obligatorio.');

  return {
    kind, category: '',
    game, card_name, condition,
    price: Math.round(price * 100) / 100, quantity,
    set_name: str(body.set_name, 120), card_code: str(body.card_code, 40),
    rarity: str(body.rarity, 60), language: str(body.language, 30) || 'Español',
    notes: str(body.notes, 1000), ref_id: str(body.ref_id, 80),
  };
}

// Obtiene en el servidor la imagen oficial y el precio de mercado de la carta elegida.
// Si la API externa falla, se conservan los valores anteriores (o se guarda sin estimación).
async function resolveReference(data, previous) {
  const empty = { image_url: '', market_price: null, market_source: '', market_updated: null };
  const keep = previous && previous.ref_id === data.ref_id && previous.game === data.game ? {
    image_url: previous.image_url, market_price: previous.market_price,
    market_source: previous.market_source, market_updated: previous.market_updated,
  } : empty;
  if (!data.ref_id) return empty;
  try {
    const card = await getCardByRef(data.game, data.ref_id);
    if (!card) return keep;
    const image_url = (await cacheRefImage(data.game, card.image_url).catch(() => '')) || keep.image_url;
    return {
      image_url,
      market_price: card.market_price,
      market_source: card.market_price ? card.market_source : '',
      market_updated: card.market_price ? new Date().toISOString() : null,
    };
  } catch (err) {
    console.error('reference:', err.message);
    return keep;
  }
}

async function storePhotos(dataUrls) {
  const decoded = dataUrls.map(decodePhoto); // valida todas antes de guardar ninguna
  await Promise.all(decoded.map(p => putFile(photoKey(p.filename), p.buf, p.contentType)));
  return decoded.map(({ id, filename }) => ({ id, filename }));
}

// Las publicaciones de cuentas suspendidas no aparecen en el catálogo público
const visible = listings => listings.filter(l => !l.seller_blocked);

// Catálogo público: todas las cartas en circulación
// kind=accessory → accesorios (por defecto, cartas). En accesorios, filtrar por un juego incluye los universales.
app.get('/api/listings', async (req, res) => {
  const kind = req.query.kind === 'accessory' ? 'accessory' : 'card';
  const game = (kind === 'accessory' ? ACC_GAMES : GAMES).includes(req.query.game) ? req.query.game : '';
  let listings = await repo.listListings({
    onlyAvailable: true, kind,
    game: kind === 'card' || game === 'any' ? game : '',
    category: kind === 'accessory' && ACC_CATEGORIES.includes(req.query.category) ? req.query.category : '',
    condition: CONDITIONS.includes(req.query.condition) ? req.query.condition : '',
    set: kind === 'card' ? str(req.query.set, 120) : '',
    q: str(req.query.q, 100), seller: str(req.query.seller, 30), sort: str(req.query.sort, 20),
  });
  if (kind === 'accessory' && GAMES.includes(game)) listings = listings.filter(l => l.game === game || l.game === 'any');
  res.json({ listings: visible(listings).map(l => listingOut(l, req.fx)) });
});

// Expansiones que tienen cartas en venta (para el filtro del catálogo), con cuántas publicaciones hay de cada una
app.get('/api/listings/sets', async (req, res) => {
  const game = GAMES.includes(req.query.game) ? req.query.game : '';
  const listings = await repo.listListings({ onlyAvailable: true, game, kind: 'card' });
  const counts = new Map();
  for (const l of visible(listings)) {
    const name = (l.set_name || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const sets = [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  res.json({ sets });
});

app.get('/api/listings/mine', requireAuth, async (req, res) => {
  const listings = await repo.listListings({ userId: req.user.id });
  res.json({ listings: listings.map(l => listingOut(l, req.fx)) });
});

app.get('/api/listings/:id', async (req, res) => {
  const l = await repo.getListing(str(req.params.id, 40));
  // La publicación de una cuenta suspendida solo la ven su dueño (no puede entrar) y los administradores
  if (!l || (l.seller_blocked && !isAdmin(req.user))) throw new HttpError(404, 'Carta no encontrada.');
  res.json({ listing: listingOut(l, req.fx) });
});

// Las fotos reales solo son obligatorias si la carta vale más de US$2.50: se toma el mayor entre el precio
// de mercado (consultado en el servidor) y el precio del vendedor convertido a dólares.
const PHOTO_MIN_USD = 2.5;
const FALLBACK_USD_MXN = 17; // si no hay tipo de cambio, uno bajo (exige foto antes, nunca después)
function photosRequired(marketUsd, priceMxn, fx) {
  const sellerUsd = priceMxn / (fx?.rate || FALLBACK_USD_MXN);
  return Math.max(Number(marketUsd) || 0, sellerUsd) > PHOTO_MIN_USD;
}
const photoRequiredMsg = kind => (kind === 'accessory'
  ? `Este accesorio vale más de US$${PHOTO_MIN_USD.toFixed(2)}: sube al menos una foto real.`
  : `Esta carta vale más de US$${PHOTO_MIN_USD.toFixed(2)}: sube al menos una foto real de tu carta.`);

app.post('/api/listings', requireAuth, async (req, res) => {
  const data = validateListing(req.body);
  const newPhotos = Array.isArray(req.body.new_photos) ? req.body.new_photos : [];
  if (newPhotos.length > MAX_PHOTOS) throw new HttpError(400, `Máximo ${MAX_PHOTOS} fotos por carta.`);

  const ref = await resolveReference(data);
  if (!newPhotos.length && photosRequired(ref.market_price, data.price, req.fx)) throw new HttpError(400, photoRequiredMsg(data.kind));
  const photos = await storePhotos(newPhotos);
  const listing = await repo.createListing(req.user.id, { ...data, ...ref }, photos);
  res.status(201).json({ listing: listingOut(listing, req.fx) });
});

// La publicación debe ser del usuario, salvo que sea administrador (puede editar, marcar y borrar cualquiera)
async function ownListing(req) {
  const l = await repo.getListing(str(req.params.id, 40));
  if (!l) throw new HttpError(404, 'Carta no encontrada.');
  if (!sameId(l.user_id, req.user.id) && !isAdmin(req.user)) throw new HttpError(403, 'Esta carta no es tuya.');
  return l;
}

app.put('/api/listings/:id', requireAuth, async (req, res) => {
  const existing = await ownListing(req);
  const data = validateListing(req.body);

  // Fotos: las que el vendedor conserva + las nuevas (al menos una si la carta vale más de US$2.50)
  const current = existing.photos || [];
  const keepIds = Array.isArray(req.body.keep_photos) ? req.body.keep_photos.map(String) : current.map(p => String(p.id));
  const kept = current.filter(p => keepIds.includes(String(p.id)));
  const removed = current.filter(p => !keepIds.includes(String(p.id)));
  const newPhotos = Array.isArray(req.body.new_photos) ? req.body.new_photos : [];
  if (kept.length + newPhotos.length > MAX_PHOTOS) throw new HttpError(400, `Máximo ${MAX_PHOTOS} fotos por carta.`);

  const ref = await resolveReference(data, existing);
  if (kept.length + newPhotos.length < 1 && photosRequired(ref.market_price, data.price, req.fx)) throw new HttpError(400, photoRequiredMsg(data.kind));
  const added = await storePhotos(newPhotos);
  const status = ['sold', 'available'].includes(req.body.status) ? req.body.status : existing.status;

  const listing = await repo.updateListing(existing.id, { ...data, ...ref, status }, [...kept, ...added]);
  await Promise.all(removed.map(p => deleteFile(photoKey(p.filename))));
  res.json({ listing: listingOut(listing, req.fx) });
});

app.patch('/api/listings/:id/status', requireAuth, async (req, res) => {
  const existing = await ownListing(req);
  const status = req.body.status === 'sold' ? 'sold' : 'available';
  await repo.setListingStatus(existing.id, status);
  res.json({ ok: true, status });
});

app.delete('/api/listings/:id', requireAuth, async (req, res) => {
  const existing = await ownListing(req);
  await repo.deleteListing(existing.id);
  await Promise.all((existing.photos || []).map(p => deleteFile(photoKey(p.filename))));
  res.json({ ok: true });
});

// ---------- ID de jugador Pokémon y torneos locales ----------

// ID de jugador de Play! Pokémon: solo dígitos. Vacío = desvincular.
// KONAMI CARD GAME ID (10 dígitos). Vacío = desvincular.
app.put('/api/auth/me/konami-id', requireAuth, async (req, res) => {
  const konamiId = str(req.body.konami_id, 20).replace(/\s+/g, '');
  if (konamiId && !/^\d{10}$/.test(konamiId)) throw new HttpError(400, 'El KONAMI CARD GAME ID tiene 10 dígitos.');
  try { res.json({ user: meUser(await repo.setKonamiId(req.user.id, konamiId)) }); }
  catch (err) { if (err.code === 'DUPLICATE') throw new HttpError(409, 'Ese CARD GAME ID ya está vinculado a otra cuenta.'); throw err; }
});

app.put('/api/auth/me/pokemon-id', requireAuth, async (req, res) => {
  const pokemonId = str(req.body.pokemon_id, 20).replace(/\s+/g, '');
  if (pokemonId && !/^\d{4,10}$/.test(pokemonId))
    throw new HttpError(400, 'El ID de jugador Pokémon debe tener de 4 a 10 dígitos.');
  try {
    const user = await repo.setPokemonId(req.user.id, pokemonId);
    res.json({ user: meUser(user) });
  } catch (err) {
    if (err.code === 'DUPLICATE') throw new HttpError(409, 'Ese ID de jugador ya está vinculado a otra cuenta.');
    throw err;
  }
});

// Configuración del torneo. rounds = 0 → automático según los jugadores; top_cut = 'auto' → según la tabla oficial
const TOP_CUTS = [0, 2, 4, 8, 16, 32];
function validateTournament(body, current = null) {
  const name = str(body.name ?? current?.name, 80).replace(/\s+/g, ' ');
  const location = str(body.location ?? current?.location, 80);
  const starts_at = str(body.starts_at ?? current?.starts_at, 16);
  const game = ['pokemon', 'yugioh'].includes(body.game) ? body.game : current?.game || 'pokemon';
  const rawRounds = body.rounds ?? current?.rounds ?? 0;
  const rounds = rawRounds === '' || rawRounds === 'auto' ? 0 : Number(rawRounds);
  if (name.length < 3) throw new HttpError(400, 'El nombre del torneo debe tener al menos 3 caracteres.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts_at) || Number.isNaN(Date.parse(starts_at)))
    throw new HttpError(400, 'Indica la fecha y hora del torneo.');
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 15) throw new HttpError(400, 'Las rondas deben ser de 1 a 15, o automáticas.');
  const c = { ...(current?.config || {}), ...(body.config || {}) };
  const top = c.top_cut === 'auto' || c.top_cut === undefined || c.top_cut === '' ? 'auto' : Number(c.top_cut);
  if (top !== 'auto' && !TOP_CUTS.includes(top)) throw new HttpError(400, 'El top cut debe ser automático, ninguno, 2, 4, 8, 16 o 32.');
  const config = {
    ...(current?.config?.top_cut_resolved != null ? { top_cut_resolved: current.config.top_cut_resolved } : {}),
    ...(current?.config?.timer ? { timer: current.config.timer } : {}),
    top_cut: top,
    best_of: Number(c.best_of) === 1 ? 1 : 3,
    round_minutes: Math.min(120, Math.max(10, Number(c.round_minutes) || (game === 'yugioh' ? 50 : 50))),
    require_id: c.require_id !== false && c.require_id !== 'false',
    open_registration: c.open_registration !== false && c.open_registration !== 'false',
  };
  return { name, location, starts_at, rounds, game, config };
}
const gameOf = t => (t.game === 'yugioh' ? 'yugioh' : 'pokemon');
const idField = t => (gameOf(t) === 'yugioh' ? 'konami_id' : 'pokemon_id');
const idLabel = t => (gameOf(t) === 'yugioh' ? 'tu KONAMI CARD GAME ID' : 'tu ID de jugador Pokémon');
// Reloj de la ronda (guardado en config.timer): { round, duration, started_at, paused_remaining }
// Arranca solo al generar cada ronda; el organizador puede pausarlo, ajustarlo o reiniciarlo.
const newTimer = (t, round) => ({ round, duration: (t.config?.round_minutes || 50) * 60, started_at: new Date().toISOString(), paused_remaining: null });
function timerState(t) {
  const tm = t.config?.timer;
  const minutes = t.config?.round_minutes || 50;
  if (!tm || tm.round !== t.current_round) return { round: t.current_round, duration: minutes * 60, status: 'idle', remaining: minutes * 60 };
  if (tm.paused_remaining != null) return { round: tm.round, duration: tm.duration, status: 'paused', remaining: tm.paused_remaining };
  const remaining = Math.max(0, tm.duration - (Date.now() - Date.parse(tm.started_at)) / 1000);
  return { round: tm.round, duration: tm.duration, status: remaining > 0 ? 'running' : 'ended', remaining: Math.round(remaining * 10) / 10,
           ends_at: new Date(Date.parse(tm.started_at) + tm.duration * 1000).toISOString() };
}

// Estructura efectiva: la elegida por el organizador o la recomendada para los jugadores activos
function structureOf(t, players) {
  const rec = recommendedStructure(gameOf(t), players.filter(p => !p.dropped).length);
  const top = t.config?.top_cut;
  // Con el torneo empezado, la estructura automática queda fija con los jugadores que había al cerrar inscripciones
  const autoTop = t.config?.top_cut_resolved ?? rec.top_cut;
  return { rounds: t.rounds || rec.rounds, top_cut: top === 'auto' || top === undefined ? autoTop : Number(top), recommended: rec };
}

const lite = p => p && { user_id: p.user_id, username: p.username, display_name: p.display_name };

async function loadTournament(id) {
  const t = await repo.getTournament(str(id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (t.source === 'tdf') return loadTdfTournament(t);
  const [players, matches] = await Promise.all([repo.getTournamentPlayers(t.id), repo.getMatches(t.id)]);
  const table = standings(players, matches, gameOf(t));
  return { t, players, matches, table, final: finalPlacement(table, matches) };
}

// Torneo importado de TOM: los jugadores se identifican por su ID de jugador Pokémon (user_id = ID Pokémon).
// Si alguien de la app tiene ese ID vinculado, se muestra con su nombre y usuario; si no, nombre + inicial.
async function loadTdfTournament(t) {
  const d = t.tdf_data;
  const linked = await repo.getUsersByPokemonIds(Object.keys(d.players));
  const players = [], matches = [], table = [];
  for (const c of d.categories) {
    const catPlayers = [...new Set([...c.members, ...c.rounds.flatMap(r => r.matches.flatMap(m => [m.player1_id, m.player2_id]))])]
      .filter(Boolean).map(pid => {
        const u = linked.get(pid);
        return { user_id: pid, pokemon_id: pid, category: c.label, username: u?.username || null,
                 display_name: u?.display_name || shortName(d.players[pid]), location: u?.location || '' };
      });
    const catMatches = c.rounds.flatMap(r => r.matches.map(m => ({ ...m, round: r.number, topcut: r.topcut, category: c.label })));
    // Puntos y % de rivales solo con el suizo; el récord incluye el top cut; el lugar es el oficial de TOM
    const swiss = standings(catPlayers, catMatches.filter(m => !m.topcut));
    const total = standings(catPlayers, catMatches);
    const official = new Map(c.standings.map(s => [s.id, s.place]));
    const rows = swiss.map(r => {
      const tot = total.find(x => x.user_id === r.user_id);
      return { ...r, wins: tot.wins, losses: tot.losses, ties: tot.ties, category: c.label,
               place: official.get(r.user_id) ?? r.place };
    }).sort((a, b) => a.place - b.place);
    players.push(...catPlayers); matches.push(...catMatches); table.push(...rows);
  }
  return { t, tdf: true, players, matches, table };
}

// Quien organiza el torneo, o un administrador, puede gestionarlo
const isOrganizer = (t, user) => !!user && (sameId(t.organizer_id, user.id) || isAdmin(user));
// Clave del usuario dentro de un torneo: su id en la app, o su ID de jugador si el torneo viene de TOM
const playerKey = (L, user) => (L.tdf ? user.pokemon_id || null : user.id);

// Partida de la ronda en curso para un jugador, con su rival y el récord de ambos
function currentMatch({ t, tdf, players, matches, table }, userId) {
  if (t.status !== 'running' || userId == null) return null;
  const mine = matches.filter(x => opponentOf(x, userId) !== undefined);
  // En un TDF cada categoría lleva su propio número de ronda: se usa la última ronda de la categoría del jugador
  const category = mine[0]?.category;
  const roundNow = tdf ? Math.max(0, ...matches.filter(x => x.category === category).map(x => x.round)) : t.current_round;
  const m = mine.find(x => x.round === roundNow);
  if (!m) return null;
  const oppId = opponentOf(m, userId);
  const rec = id => { const r = table.find(x => sameId(x.user_id, id)); return r && { wins: r.wins, losses: r.losses, ties: r.ties, place: r.place }; };
  return {
    round: m.round, table_no: m.table_no, bye: oppId == null, result: outcome(m, userId),
    opponent: oppId == null ? null : { ...lite(players.find(p => sameId(p.user_id, oppId))), record: rec(oppId) },
    my_record: rec(userId),
  };
}

// Resultados del jugador en un torneo, en orden de rondas
const resultsIn = (matches, userId) => matches.map(m => outcome(m, userId)).filter(Boolean);

app.get('/api/tournaments', async (_req, res) => {
  res.json({ tournaments: await repo.listTournaments() });
});

// Panel personal: ID vinculado, partidas en curso, historial y rachas en todos los torneos
app.get('/api/tournaments/me', requireAuth, async (req, res) => {
  // Torneos de la app en los que se inscribió + torneos de TOM donde aparece su ID de jugador
  const ids = [...new Set([...await repo.listUserTournamentIds(req.user.id),
                           ...await repo.listTournamentIdsByPokemonId(req.user.pokemon_id)].map(String))];
  const loaded = (await Promise.all(ids.map(id => loadTournament(id).catch(() => null)))).filter(Boolean);
  loaded.sort((a, b) => a.t.starts_at.localeCompare(b.t.starts_at));

  const all = [];
  const history = loaded.map(L => {
    const key = playerKey(L, req.user);
    const results = resultsIn(L.matches, key);
    all.push(...results);
    const row = L.table.find(r => sameId(r.user_id, key));
    return { id: L.t.id, name: L.t.name, location: L.t.location, starts_at: L.t.starts_at, status: L.t.status,
             source: L.t.source || 'app', category: row?.category || null,
             player_count: L.players.length, place: row?.place ?? null, ...streaks(results) };
  }).reverse();

  const active = loaded.map(L => {
    const cm = hideOpponentId(L, currentMatch(L, playerKey(L, req.user)));
    return cm && { tournament: { id: L.t.id, name: L.t.name, location: L.t.location }, ...cm };
  }).filter(Boolean);

  res.json({ pokemon_id: req.user.pokemon_id || '', overall: streaks(all), active, history });
});

app.post('/api/tournaments', requireAuth, async (req, res) => {
  const t = await repo.createTournament(req.user.id, validateTournament(req.body));
  res.status(201).json({ tournament: t });
});

// Organizador según el TDF, mostrado como nombre + inicial ("Carlos A.")
const organizerName = o => {
  const words = String(o?.name || '').trim().split(/\s+/).filter(Boolean);
  return words.length ? shortName({ first: words[0], last: words.slice(1).join(' ') }) : '';
};

// Nombre de la ronda: "Ronda 3" en suizo; en el top cut, según cuántas partidas quedan
const roundLabel = (round, topcut, count) => (!topcut ? `Ronda ${round}`
  : count === 1 ? 'Top cut · Final' : count === 2 ? 'Top cut · Semifinales' : count === 4 ? 'Top cut · Cuartos de final' : `Top cut · Ronda ${round}`);

app.get('/api/tournaments/:id', async (req, res) => {
  const L = await loadTournament(req.params.id);
  const { t, players, matches, table } = L;
  const manage = isOrganizer(t, req.user);
  // En un TDF la clave interna es el ID de jugador: hacia afuera se usa un alias (j1, j2…) para no exponerlo
  const alias = L.tdf ? new Map(players.map((p, i) => [String(p.user_id), `j${i + 1}`])) : null;
  const pub = id => (alias ? alias.get(String(id)) ?? null : id);
  const byId = new Map(players.map(p => [String(p.user_id), { ...lite(p), user_id: pub(p.user_id) }]));
  const rounds = new Map();
  for (const m of matches) {
    const k = `${m.category || ''}|${m.round}`;
    if (!rounds.has(k)) rounds.set(k, { round: m.round, category: m.category || null, topcut: !!m.topcut, matches: [] });
    rounds.get(k).matches.push({
      table_no: m.table_no, result: m.result, bye: m.player2_id == null,
      player1: byId.get(String(m.player1_id)) || null, player2: m.player2_id == null ? null : byId.get(String(m.player2_id)) || null,
    });
  }
  const key = req.user ? playerKey(L, req.user) : null;
  const joined = key != null && players.some(p => sameId(p.user_id, key));
  const { tdf_data, ...tournament } = t;
  const struct = L.tdf ? null : structureOf(t, players);
  res.json({
    rules: L.tdf ? null : { game: gameOf(t), label: RULESET[gameOf(t)].label, ties: RULESET[gameOf(t)].ties, ...struct },
    timer: L.tdf ? null : timerState(t), server_now: new Date().toISOString(),
    tournament: { ...tournament, player_count: players.length,
                  ...(L.tdf ? { organizer_tom: organizerName(tdf_data.organizer), categories: tdf_data.categories.map(c => c.label) } : {}) },
    can_manage: manage,
    // El ID de jugador solo lo ve quien organiza (para capturarlo en el reporte oficial)
    players: players.map(p => ({ ...lite(p), user_id: pub(p.user_id), location: p.location, category: p.category, deck: p.deck || '',
                                 dropped: p.dropped || 0, ...(manage ? { pokemon_id: p.pokemon_id, konami_id: p.konami_id || '' } : {}) })),
    standings: (L.final || table).map(({ opponents, ...r }) => ({ ...r, user_id: pub(r.user_id) })),
    rounds: [...rounds.values()].map(r => ({ ...r, label: roundLabel(r.round, r.topcut, r.matches.length) })),
    round_complete: matches.filter(m => m.round === t.current_round).every(m => m.result),
    me: joined ? { joined, key: pub(key), deck: players.find(p => sameId(p.user_id, key))?.deck || '',
                   match: hideOpponentId(L, currentMatch(L, key)), ...streaks(resultsIn(matches, key)) }
               : { joined: false },
  });
});

// En torneos de TOM no se manda el ID de jugador del rival
const hideOpponentId = (L, cm) => (cm && L.tdf && cm.opponent ? { ...cm, opponent: { ...cm.opponent, user_id: undefined } } : cm);

async function managedTournament(req) {
  const L = await loadTournament(req.params.id);
  if (!isOrganizer(L.t, req.user)) throw new HttpError(403, 'Solo quien organiza el torneo puede hacer esto.');
  if (L.tdf) throw new HttpError(400, 'Este torneo viene de TOM: se actualiza subiendo un TDF nuevo.');
  return L;
}

// Importar (o actualizar) un torneo desde el TDF que genera TOM. Lo puede subir quien aparece en el
// archivo como organizador o como jugador; para actualizarlo, quien lo subió o el organizador.
app.post('/api/tournaments/import-tdf', requireAuth, async (req, res) => {
  if (!req.user.pokemon_id) throw new HttpError(400, 'Vincula tu ID de jugador Pokémon antes de importar un torneo.');
  let parsed;
  try {
    parsed = parseTdf(req.body.tdf);
  } catch (err) {
    if (err instanceof TdfError) throw new HttpError(400, err.message);
    throw new HttpError(400, 'No se pudo leer el archivo TDF.');
  }
  const mine = req.user.pokemon_id;
  const isTomOrganizer = parsed.data.organizer.popid === mine;
  if (!isTomOrganizer && !parsed.data.players[mine])
    throw new HttpError(403, 'Tu ID de jugador no aparece en este TDF (ni como organizador ni como jugador).');

  const existing = await repo.findTournamentByTdfId(parsed.tdf_id);
  if (existing && !isOrganizer(existing, req.user) && existing.tdf_data?.organizer?.popid !== mine)
    throw new HttpError(403, `Este torneo ya lo importó @${existing.organizer_username}; solo esa persona o el organizador pueden actualizarlo.`);
  try {
    const t = await repo.saveTdfTournament(req.user.id, parsed, existing?.id);
    res.status(existing ? 200 : 201).json({ tournament: { id: t.id, name: t.name }, updated: !!existing });
  } catch (err) {
    if (err.name === 'TransactionCanceledException') throw new HttpError(409, 'Alguien más está importando este torneo; intenta de nuevo.');
    throw err;
  }
});

app.post('/api/tournaments/:id/join', requireAuth, async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (t.status !== 'registration') throw new HttpError(400, 'Las inscripciones de este torneo ya cerraron.');
  if (t.config?.open_registration === false) throw new HttpError(403, 'En este torneo solo el organizador agrega a los jugadores.');
  if (t.config?.require_id !== false && !req.user[idField(t)]) throw new HttpError(400, `Vincula ${idLabel(t)} en tu perfil antes de inscribirte.`);
  await repo.joinTournament(t.id, req.user.id);
  res.json({ ok: true });
});

// Deck con el que juega el usuario en un torneo de la app (alimenta el metajuego de la página)
app.put('/api/tournaments/:id/deck', requireAuth, async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t || t.source === 'tdf') throw new HttpError(404, 'Torneo no encontrado.');
  const players = await repo.getTournamentPlayers(t.id);
  if (!players.some(p => sameId(p.user_id, req.user.id))) throw new HttpError(400, 'Primero inscríbete en el torneo.');
  // Solo un deck guardado del propio usuario y del mismo juego que el torneo (vacío = quitarlo)
  let deck = '';
  if (req.body.deck_id) {
    const d = await repo.getDeck(str(String(req.body.deck_id), 40));
    if (!d || !sameId(d.user_id, req.user.id)) throw new HttpError(404, 'Ese deck no es tuyo.');
    if (d.game !== gameOf(t)) throw new HttpError(400, `Elige un deck de ${gameOf(t) === 'yugioh' ? 'Yu-Gi-Oh!' : 'Pokémon'}.`);
    deck = d.name;
  }
  await repo.setTournamentDeck(t.id, req.user.id, deck);
  res.json({ ok: true, deck });
});

app.post('/api/tournaments/:id/leave', requireAuth, async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (t.status !== 'registration') throw new HttpError(400, 'El torneo ya empezó; habla con quien lo organiza.');
  await repo.leaveTournament(t.id, req.user.id);
  res.json({ ok: true });
});

// Genera la siguiente ronda. En la primera se fija la estructura (rondas y top cut) según los jugadores.
app.post('/api/tournaments/:id/rounds', requireAuth, async (req, res) => {
  const { t, players, matches, table } = await managedTournament(req);
  if (t.status === 'finished') throw new HttpError(400, 'El torneo ya terminó. Reábrelo si necesitas otra ronda.');
  const active = players.filter(p => !p.dropped);
  if (active.length < 2) throw new HttpError(400, 'Se necesitan al menos 2 jugadores activos.');
  if (matches.some(m => m.round === t.current_round && !m.result && m.player2_id != null))
    throw new HttpError(400, 'Faltan resultados de la ronda actual.');
  const round = t.current_round + 1;
  const game = gameOf(t);

  if (t.phase === 'top') {
    const prev = matches.filter(m => m.topcut && m.round === t.current_round);
    if (prev.some(m => m.player2_id != null && !['p1', 'p2'].includes(m.result))) throw new HttpError(400, 'Cada partida de top cut necesita un ganador.');
    const next = nextTopRound(prev, round);
    if (!next.length) throw new HttpError(400, 'El top cut ya terminó: finaliza el torneo.');
    await repo.addMatches(t.id, next);
    await repo.updateTournament(t.id, { current_round: round, config: { ...t.config, timer: newTimer(t, round) } });
    return res.status(201).json({ ok: true, round, phase: 'top' });
  }
  // Primera ronda: se fijan las rondas de suizo si eran automáticas
  let rounds = t.rounds;
  const rec = recommendedStructure(game, active.length);
  if (round === 1 && !rounds) rounds = rec.rounds;
  if (rounds && round > rounds) throw new HttpError(400, 'Ya se jugaron todas las rondas de suizo: inicia el top cut o finaliza el torneo.');
  await repo.addMatches(t.id, pairRound(players, matches, round, game));
  await repo.updateTournament(t.id, { status: 'running', current_round: round, rounds,
    config: { ...t.config, timer: newTimer(t, round), ...(round === 1 ? { top_cut_resolved: rec.top_cut } : {}) } });
  res.status(201).json({ ok: true, round, phase: 'swiss' });
});

// Inicia el top cut con los mejores N del suizo (sembrados 1 vs N, 2 vs N-1…)
app.post('/api/tournaments/:id/topcut', requireAuth, async (req, res) => {
  const { t, players, matches, table } = await managedTournament(req);
  if (t.phase === 'top') throw new HttpError(400, 'El top cut ya empezó.');
  if (matches.some(m => m.round === t.current_round && !m.result && m.player2_id != null)) throw new HttpError(400, 'Faltan resultados de la ronda actual.');
  const size = Number(req.body.size) || structureOf(t, players).top_cut;
  if (!TOP_CUTS.includes(size) || size < 2) throw new HttpError(400, 'Elige un top cut de 2, 4, 8, 16 o 32.');
  if (table.filter(r => !r.dropped).length < size) throw new HttpError(400, 'No hay suficientes jugadores activos para ese top cut.');
  const round = t.current_round + 1;
  await repo.addMatches(t.id, firstTopRound(table, size, round));
  await repo.updateTournament(t.id, { phase: 'top', current_round: round, config: { ...t.config, top_cut: size, timer: newTimer(t, round) } });
  res.status(201).json({ ok: true, round });
});

// Deshace la ronda actual (borra sus emparejamientos y resultados)
app.delete('/api/tournaments/:id/rounds/current', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  if (!t.current_round) throw new HttpError(400, 'No hay rondas que deshacer.');
  const wasTop = matches.some(m => m.round === t.current_round && m.topcut);
  await repo.deleteRoundMatches(t.id, t.current_round);
  const round = t.current_round - 1;
  const stillTop = wasTop && matches.some(m => m.round === round && m.topcut);
  await repo.updateTournament(t.id, { current_round: round, status: round === 0 ? 'registration' : 'running', phase: stillTop ? 'top' : 'swiss', config: { ...t.config, timer: null } });
  res.json({ ok: true, round });
});

// Rehace los emparejamientos de la ronda actual del suizo (p. ej. si alguien se retiró antes de empezar)
app.post('/api/tournaments/:id/rounds/current/repair', requireAuth, async (req, res) => {
  const { t, players, matches } = await managedTournament(req);
  if (!t.current_round || t.phase === 'top') throw new HttpError(400, 'Solo se pueden rehacer los emparejamientos de una ronda de suizo.');
  await repo.deleteRoundMatches(t.id, t.current_round);
  const earlier = matches.filter(m => m.round < t.current_round);
  await repo.addMatches(t.id, pairRound(players, earlier, t.current_round, gameOf(t)));
  await repo.updateTournament(t.id, { config: { ...t.config, timer: newTimer(t, t.current_round) } });
  res.json({ ok: true });
});

// Intercambia de lugar a dos jugadores en la ronda actual (corrige emparejamientos a mano)
app.post('/api/tournaments/:id/rounds/current/swap', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  const cur = matches.filter(m => m.round === t.current_round).map(m => ({ ...m }));
  const a = String(req.body.a), b = String(req.body.b);
  if (!cur.length || a === b) throw new HttpError(400, 'Elige dos jugadores distintos de la ronda actual.');
  const seat = id => { for (const m of cur) { if (String(m.player1_id) === id) return [m, 'player1_id']; if (String(m.player2_id) === id) return [m, 'player2_id']; } return null; };
  const sa = seat(a), sb = seat(b);
  if (!sa || !sb) throw new HttpError(400, 'Los dos jugadores deben estar en la ronda actual.');
  const tmp = sa[0][sa[1]]; sa[0][sa[1]] = sb[0][sb[1]]; sb[0][sb[1]] = tmp;
  for (const m of [sa[0], sb[0]]) m.result = m.player2_id == null ? 'p1' : null;   // las mesas tocadas pierden su resultado
  await repo.deleteRoundMatches(t.id, t.current_round);
  await repo.addMatches(t.id, cur);
  res.json({ ok: true });
});

// Captura o corrige el resultado de cualquier partida (las clasificaciones se recalculan solas)
app.put('/api/tournaments/:id/matches/:round/:table', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  const round = Number(req.params.round), table = Number(req.params.table);
  const m = matches.find(x => x.round === round && x.table_no === table);
  if (!m) throw new HttpError(404, 'Partida no encontrada.');
  if (m.player2_id == null) throw new HttpError(400, 'Un bye no lleva resultado.');
  const allowed = m.topcut ? ['p1', 'p2'] : RULESET[gameOf(t)].ties ? ['p1', 'p2', 'tie', 'dl'] : ['p1', 'p2', 'dl'];
  const result = allowed.includes(req.body.result) ? req.body.result : null;
  if (req.body.result && !result) throw new HttpError(400, m.topcut ? 'En el top cut cada partida necesita un ganador.' : 'En Yu-Gi-Oh! no hay empates: si se acaba el tiempo es doble derrota.');
  if (m.topcut && matches.some(x => x.topcut && x.round > round)) throw new HttpError(400, 'Ya se emparejó la siguiente ronda del top cut: deshazla antes de corregir este resultado.');
  await repo.setMatchResult(t.id, round, table, result);
  res.json({ ok: true });
});

// Editar datos y configuración del torneo (nombre, fecha, juego, rondas, top cut, registro…)
app.put('/api/tournaments/:id', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  const v = validateTournament(req.body, t);
  if (t.status !== 'registration' && v.game !== gameOf(t)) throw new HttpError(400, 'No se puede cambiar el juego de un torneo que ya empezó.');
  const swissPlayed = Math.max(0, ...matches.filter(m => !m.topcut).map(m => m.round));
  if (v.rounds && v.rounds < swissPlayed) throw new HttpError(400, `Ya se jugaron ${swissPlayed} rondas de suizo; no puedes poner menos.`);
  res.json({ tournament: await repo.updateTournament(t.id, v) });
});

// Buscar usuarios registrados (para que el organizador los agregue)
app.get('/api/users-search', requireAuth, async (req, res) => {
  const q = str(req.query.q, 40);
  if (q.length < 2) return res.json({ users: [] });
  const users = await repo.searchUsers(q, 12);
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, display_name: u.display_name, location: u.location,
    has_pokemon_id: !!u.pokemon_id, has_konami_id: !!u.konami_id })) });
});

// El organizador agrega a un jugador registrado (también como inscripción tardía con el torneo en curso)
app.post('/api/tournaments/:id/players', requireAuth, async (req, res) => {
  const { t, players } = await managedTournament(req);
  if (t.status === 'finished') throw new HttpError(400, 'El torneo ya terminó.');
  const user = req.body.user_id ? await repo.getUser(str(String(req.body.user_id), 40)) : await repo.findUserByUsername(str(req.body.username, 30));
  if (!user || user.blocked) throw new HttpError(404, 'No existe ese usuario registrado.');
  if (players.some(p => sameId(p.user_id, user.id))) throw new HttpError(409, `@${user.username} ya está inscrito.`);
  if (t.config?.require_id !== false && !user[idField(t)])
    throw new HttpError(400, `@${user.username} no ha vinculado ${gameOf(t) === 'yugioh' ? 'su KONAMI CARD GAME ID' : 'su ID de jugador Pokémon'}. Pídele que lo agregue en su perfil o desactiva el requisito en la configuración.`);
  await repo.joinTournament(t.id, user.id);
  res.status(201).json({ ok: true, late: t.status === 'running' });
});

// Quitar (antes de empezar) o dar de baja (con el torneo en curso) a un jugador; ?undo=1 lo reactiva
app.delete('/api/tournaments/:id/players/:userId', requireAuth, async (req, res) => {
  const { t, players } = await managedTournament(req);
  const p = players.find(x => sameId(x.user_id, req.params.userId));
  if (!p) throw new HttpError(404, 'Ese jugador no está inscrito.');
  if (req.query.undo === '1') { await repo.setPlayerDropped(t.id, p.user_id, 0); return res.json({ ok: true, dropped: 0 }); }
  if (t.status === 'registration') { await repo.leaveTournament(t.id, p.user_id); return res.json({ ok: true, removed: true }); }
  await repo.setPlayerDropped(t.id, p.user_id, Math.max(1, t.current_round));
  res.json({ ok: true, dropped: t.current_round });
});

// Reloj de la ronda: solo lectura para todos (los jugadores lo consultan cada pocos segundos)
app.get('/api/tournaments/:id/timer', async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t || t.source === 'tdf') throw new HttpError(404, 'Torneo no encontrado.');
  res.set('Cache-Control', 'no-store');
  res.json({ timer: timerState(t), server_now: new Date().toISOString(), status: t.status, current_round: t.current_round });
});

// El organizador controla el reloj: start | pause | resume | add (minutos, puede ser negativo) | reset
app.post('/api/tournaments/:id/timer', requireAuth, async (req, res) => {
  const { t } = await managedTournament(req);
  if (t.status !== 'running' || !t.current_round) throw new HttpError(400, 'El reloj se usa con una ronda en curso.');
  const cur = timerState(t);
  const action = str(req.body.action, 10);
  let timer = t.config?.timer && t.config.timer.round === t.current_round ? { ...t.config.timer } : null;
  const now = new Date().toISOString();
  if (action === 'start') {
    const minutes = Number(req.body.minutes) || t.config?.round_minutes || 50;
    if (minutes < 1 || minutes > 180) throw new HttpError(400, 'Elige entre 1 y 180 minutos.');
    timer = { round: t.current_round, duration: Math.round(minutes * 60), started_at: now, paused_remaining: null };
  } else if (action === 'pause') {
    if (cur.status !== 'running') throw new HttpError(400, 'El reloj no está corriendo.');
    timer.paused_remaining = cur.remaining;
  } else if (action === 'resume') {
    if (cur.status !== 'paused') throw new HttpError(400, 'El reloj no está en pausa.');
    // Se reanuda moviendo el inicio para que falte exactamente lo que quedaba
    timer.started_at = new Date(Date.now() - (timer.duration - timer.paused_remaining) * 1000).toISOString();
    timer.paused_remaining = null;
  } else if (action === 'add') {
    if (!timer) throw new HttpError(400, 'Primero inicia el reloj.');
    const secs = Math.round((Number(req.body.minutes) || 0) * 60);
    if (!secs) throw new HttpError(400, 'Indica cuántos minutos sumar o restar.');
    if (cur.status === 'ended' && secs > 0) {
      // Si ya había terminado, se vuelve a contar desde ahora
      timer = { ...timer, duration: secs, started_at: now, paused_remaining: null };
    } else {
      timer.duration = Math.max(1, timer.duration + secs);
      if (timer.paused_remaining != null) timer.paused_remaining = Math.max(0, timer.paused_remaining + secs);
    }
  } else if (action === 'reset') {
    timer = null;
  } else throw new HttpError(400, 'Acción no válida.');
  const updated = await repo.updateTournament(t.id, { config: { ...t.config, timer } });
  res.json({ timer: timerState(updated), server_now: new Date().toISOString() });
});

// Reabrir un torneo terminado (para corregir algo o jugar otra ronda)
app.post('/api/tournaments/:id/reopen', requireAuth, async (req, res) => {
  const { t } = await managedTournament(req);
  if (t.status !== 'finished') throw new HttpError(400, 'El torneo no está terminado.');
  await repo.updateTournament(t.id, { status: 'running' });
  res.json({ ok: true });
});

app.post('/api/tournaments/:id/finish', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  if (t.status !== 'running') throw new HttpError(400, 'El torneo no está en curso.');
  if (matches.some(m => m.round === t.current_round && !m.result && m.player2_id != null)) throw new HttpError(400, 'Faltan resultados de la ronda actual.');
  await repo.updateTournament(t.id, { status: 'finished', current_round: t.current_round });
  res.json({ ok: true });
});

app.delete('/api/tournaments/:id', requireAuth, async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (!isOrganizer(t, req.user)) throw new HttpError(403, 'Solo quien organiza el torneo puede hacer esto.');
  // Un torneo importado de TOM se puede quitar siempre (se puede volver a importar); uno de la app, también (con confirmación)
  await repo.deleteTournament(t.id);
  res.json({ ok: true });
});

// ---------- Decks ----------

const safeImageUrl = v => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{4,400}$/.test(v) ? v : '');
const DECK_CATEGORIES = ['pokemon', 'trainer', 'energy', 'monster', 'spell', 'trap', 'extra', ''];

function validateDeck(body) {
  const name = str(body.name, 60).replace(/\s+/g, ' ');
  const game = DECK_GAMES.includes(body.game) ? body.game : null;
  if (name.length < 2) throw new HttpError(400, 'Ponle un nombre al deck (mínimo 2 caracteres).');
  if (!game) throw new HttpError(400, 'Elige el juego del deck (Pokémon o Yu-Gi-Oh!).');
  const list = Array.isArray(body.cards) ? body.cards : [];
  if (list.length > MAX_ENTRIES) throw new HttpError(400, `Un deck admite máximo ${MAX_ENTRIES} cartas distintas.`);
  const cards = list.map(c => {
    const qty = Number(c?.qty);
    const cardName = str(c?.name, 120);
    if (!cardName || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
    const price = Number(c.price_usd);
    return {
      ref_id: str(c.ref_id, 80), name: cardName, set_name: str(c.set_name, 120), card_code: str(c.card_code, 40),
      set_code_short: str(c.set_code_short, 10), image: safeImageUrl(c.image), image_large: safeImageUrl(c.image_large),
      category: DECK_CATEGORIES.includes(c.category) ? c.category : '', basic_energy: game === 'pokemon' && !!c.basic_energy,
      section: SECTIONS[game].includes(c.section) ? c.section : 'main', qty,
      price_usd: Number.isFinite(price) && price > 0 && price < 100000 ? Math.round(price * 100) / 100 : 0,
    };
  }).filter(Boolean);
  return { name, game, description: str(body.description, 1000), is_public: !!body.is_public, cards };
}

// Deck con su resumen (total, si es legal, valor estimado en pesos con el tipo de cambio del día)
function deckOut(d, fx, { withCards = true } = {}) {
  if (!d) return d;
  const summary = deckSummary(d.game, d.cards || []);
  const { cards, ...rest } = d;
  return {
    ...rest, ...(withCards ? { cards } : {}),
    summary: { ...summary, value_mxn: toMxn(summary.value_usd, fx), fx: summary.value_usd ? fxInfo(fx) : null },
  };
}

// Un deck lo ven su dueño y los administradores; si es público, cualquiera con el enlace
async function readableDeck(req) {
  const d = await repo.getDeck(str(req.params.id, 40));
  const own = d && req.user && sameId(d.user_id, req.user.id);
  if (!d || !(own || d.is_public || isAdmin(req.user))) throw new HttpError(404, 'Deck no encontrado.');
  return { d, own };
}
async function ownDeck(req, { allowAdmin = false } = {}) {
  const d = await repo.getDeck(str(req.params.id, 40));
  if (!d) throw new HttpError(404, 'Deck no encontrado.');
  if (!sameId(d.user_id, req.user.id) && !(allowAdmin && isAdmin(req.user))) throw new HttpError(403, 'Este deck no es tuyo.');
  return d;
}

app.get('/api/decks', requireAuth, async (req, res) => {
  const decks = await repo.listDecks(req.user.id);
  res.json({ decks: decks.map(d => deckOut(d, req.fx, { withCards: false })) });
});

app.post('/api/decks', requireAuth, async (req, res) => {
  const mine = await repo.listDecks(req.user.id);
  if (mine.length >= 100) throw new HttpError(400, 'Llegaste al máximo de 100 decks. Borra alguno para crear otro.');
  const d = await repo.createDeck(req.user.id, validateDeck(req.body));
  res.status(201).json({ deck: deckOut(d, req.fx) });
});

app.get('/api/decks/:id', async (req, res) => {
  const { d, own } = await readableDeck(req);
  res.json({ deck: deckOut(d, req.fx), can_edit: own });
});

app.put('/api/decks/:id', requireAuth, async (req, res) => {
  const d = await ownDeck(req);
  res.json({ deck: deckOut(await repo.updateDeck(d.id, validateDeck(req.body)), req.fx) });
});

app.delete('/api/decks/:id', requireAuth, async (req, res) => {
  const d = await ownDeck(req, { allowAdmin: true });
  await repo.deleteDeck(d.id);
  res.json({ ok: true });
});

// ---------- Competitivo: metajuego ----------

const META_KEY = 'meta-snapshot-v1';
let metaBuilding = null;

// Foto del metajuego. Las visitas siempre reciben la foto guardada (nunca esperan a Limitless); se rehace con
// POST /api/meta/refresh, que llama una tarea programada cada 6 h. Solo si todavía no existe ninguna foto se arma al vuelo.
const META_MIN_REFRESH = 5 * 3600e3;
const POKE_CARDS_KEY = 'pokemon-cards-v1';
const YGO_KEY = 'ygo-snapshot-v1';
let ygoBuilding = null;
function rebuildMeta(cur) {
  if (!metaBuilding) {
    metaBuilding = (async () => {
      const prevCards = await repo.getKV(POKE_CARDS_KEY).catch(() => null);
      return buildSnapshot({ ...(cur || {}), _cardImages: prevCards?.images, _setIndex: prevCards?._setIndex });
    })()
      .then(async ({ _cards, _cardImages, _setIndex, ...snap }) => {
        await repo.putKV(META_KEY, snap);
        if (_cards) await repo.putKV(POKE_CARDS_KEY, { ..._cards, updated_at: snap.updated_at });
        return snap;
      })
      .catch(err => { console.error('meta:', err.message); if (cur) return { ...cur, stale: true }; throw err; })
      .finally(() => { metaBuilding = null; });
  }
  return metaBuilding;
}
async function getMetaSnapshot() {
  const cur = await repo.getKV(META_KEY).catch(() => null);
  return cur || rebuildMeta(null);
}
function rebuildYgo(cur) {
  if (!ygoBuilding) {
    ygoBuilding = buildYgoSnapshot(cur)
      .then(async snap => { await repo.putKV(YGO_KEY, snap); return snap; })
      .catch(err => { console.error('ygo meta:', err.message); if (cur) return { ...cur, stale: true }; throw err; })
      .finally(() => { ygoBuilding = null; });
  }
  return ygoBuilding;
}
async function getYgoSnapshot() {
  const cur = await repo.getKV(YGO_KEY).catch(() => null);
  return cur || rebuildYgo(null);
}

// Metajuego de los torneos de esta página: decks registrados por los jugadores y sus resultados
async function macaiMeta() {
  const tournaments = (await repo.listTournaments()).filter(t => t.source !== 'tdf' && t.status !== 'registration');
  const decks = new Map();
  let total = 0;
  const list = [];
  for (const t of tournaments.slice(0, 40)) {
    const [players, matches] = await Promise.all([repo.getTournamentPlayers(t.id), repo.getMatches(t.id)]);
    const withDeck = players.filter(p => p.deck);
    if (!withDeck.length) continue;
    const table = finalPlacement(standings(players, matches, gameOf(t)), matches);
    const byId = id => players.find(p => sameId(p.user_id, id));
    list.push({ id: t.id, name: t.name, date: String(t.starts_at).slice(0, 10), players: players.length,
      top: table.slice(0, 8).map(r => ({ placing: r.place, name: byId(r.user_id)?.display_name, deck: { name: byId(r.user_id)?.deck || '' } })) });
    for (const p of withDeck) {
      const key = p.deck.toLowerCase();
      if (!decks.has(key)) decks.set(key, { key, name: p.deck, icons: [], players: 0, wins: 0, losses: 0, ties: 0, top8: 0, wins1st: 0 });
      const d = decks.get(key);
      const row = table.find(r => sameId(r.user_id, p.user_id));
      d.players++; total++;
      if (row) { d.wins += row.wins; d.losses += row.losses; d.ties += row.ties; if (row.place <= 8) d.top8++; if (row.place === 1) d.wins1st++; }
    }
  }
  return {
    total, events: list.length, list,
    decks: [...decks.values()].map(d => {
      const g = d.wins + d.losses + d.ties;
      return { ...d, share: Math.round(d.players / (total || 1) * 1000) / 10, games: g,
               winrate: g ? Math.round((d.wins + d.ties / 3) / g * 1000) / 10 : null, trend: null, weekly: [] };
    }).sort((a, b) => b.players - a.players),
  };
}

app.get('/api/meta', async (_req, res) => {
  const [snap, macai] = await Promise.all([
    getMetaSnapshot().catch(() => null), macaiMeta().catch(() => ({ decks: [], list: [], total: 0, events: 0 })),
  ]);
  if (!snap) throw new HttpError(502, 'No se pudieron obtener las estadísticas de Limitless ahora. Intenta en unos minutos.');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ...snap, macai });
});

// Rehace la foto si tiene más de 5 h (cualquiera puede llamarlo: como mucho provoca una actualización cada 5 h).
// Un administrador puede forzarla con ?force=1.
// ?part=pokemon (por defecto) o ?part=yugioh: cada parte se actualiza por separado (la función tiene 30 s)
app.post('/api/meta/refresh', async (req, res) => {
  const ygo = req.query.part === 'yugioh';
  const key = ygo ? YGO_KEY : META_KEY;
  const cur = await repo.getKV(key).catch(() => null);
  const force = req.query.force === '1' && isAdmin(req.user);
  if (cur && !force && Date.now() - Date.parse(cur.updated_at) < META_MIN_REFRESH)
    return res.json({ ok: true, part: ygo ? 'yugioh' : 'pokemon', refreshed: false, updated_at: cur.updated_at });
  const snap = await (ygo ? rebuildYgo(cur) : rebuildMeta(cur));
  res.json({ ok: true, part: ygo ? 'yugioh' : 'pokemon', refreshed: !snap.stale, partial: !!snap.partial, updated_at: snap.updated_at });
});

// Metajuego de Yu-Gi-Oh! (Omega + YGOPRODeck)
app.get('/api/meta/yugioh', async (_req, res) => {
  const snap = await getYgoSnapshot().catch(() => null);
  if (!snap) throw new HttpError(502, 'No se pudieron obtener las estadísticas de Yu-Gi-Oh! ahora. Intenta en unos minutos.');
  const { _info, cards, ...rest } = snap;
  res.set('Cache-Control', 'public, max-age=300');
  res.json(rest);
});

// Cartas más usadas (staples, side deck, techs por arquetipo)
app.get('/api/meta/cards', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (req.query.game === 'yugioh') {
    const snap = await getYgoSnapshot().catch(() => null);
    if (!snap?.cards) throw new HttpError(502, 'Aún no hay datos de cartas de Yu-Gi-Oh!. Intenta en unos minutos.');
    return res.json({ game: 'yugioh', updated_at: snap.updated_at, ...snap.cards, images: snap.images });
  }
  let cards = await repo.getKV(POKE_CARDS_KEY).catch(() => null);
  if (!cards) { await getMetaSnapshot().catch(() => null); cards = await repo.getKV(POKE_CARDS_KEY).catch(() => null); }
  if (!cards) throw new HttpError(502, 'Aún no hay datos de cartas de Pokémon. Intenta en unos minutos.');
  const { _setIndex, ...rest } = cards;
  res.json({ game: 'pokemon', ...rest });
});

// ---------- Competitivo: registro personal de partidas ----------

const RESULTS = ['W', 'L', 'T'];
function validateMatchLog(body) {
  const source = body.source === 'online' ? 'online' : 'physical';
  const date = str(body.played_at, 10);
  const played_at = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : new Date().toISOString().slice(0, 10);
  const prizes = v => (v !== null && v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 6 ? Number(v) : null);
  const games = (Array.isArray(body.games) ? body.games : []).slice(0, 3)
    .map(g => ({ result: RESULTS.includes(g?.result) ? g.result : null, first: g?.first === true ? true : g?.first === false ? false : null,
                 prizes_me: prizes(g?.prizes_me), prizes_opp: prizes(g?.prizes_opp) }))
    .filter(g => g.result);
  const m = {
    source, played_at, format: body.format === 'bo3' ? 'bo3' : 'bo1',
    event: str(body.event, 80), my_deck: str(body.my_deck, 60), opp_deck: str(body.opp_deck, 60), opp_name: str(body.opp_name, 40),
    notes: str(body.notes, 2000), games,
  };
  // Partida online: se lee el log en el servidor (perspectiva: el jugador elegido o el dueño de la mano inicial)
  const log = typeof body.log === 'string' ? body.log.slice(0, 200000) : '';
  if (source === 'online' && log) {
    const st = parseLog(log);
    if (st.players.length < 2 || !st.turns.length) throw new HttpError(400, 'No se reconoció el log. Cópialo completo desde Pokémon TCG Live (historial de la partida).');
    const me = st.players.includes(body.me_name) ? body.me_name : st.me;
    const opp = st.players.find(p => p !== me);
    Object.assign(m, {
      me_name: me, opp_name: m.opp_name || opp, turns: st.turns.length, reason: st.reason || '',
      mulligans_me: st.mulligans[me] || 0, mulligans_opp: st.mulligans[opp] || 0,
    });
    if (!games.length) m.games = [{ result: st.winner ? (st.winner === me ? 'W' : 'L') : 'T', first: st.first ? st.first === me : null,
                                     prizes_me: st.prizes[me] ?? null, prizes_opp: st.prizes[opp] ?? null }];
    m.log = log;
  }
  if (!m.games.length) throw new HttpError(400, 'Indica el resultado de la partida.');
  // Resultado del match: Bo1 = el juego; Bo3 = quien gane 2
  const w = m.games.filter(g => g.result === 'W').length, l = m.games.filter(g => g.result === 'L').length;
  m.result = m.format === 'bo1' ? m.games[0].result : w > l ? 'W' : l > w ? 'L' : 'T';
  m.went_first = m.games[0].first;
  return m;
}

async function ownMatchLog(req) {
  const m = await repo.getMatchLog(str(req.params.id, 40));
  if (!m || !sameId(m.user_id, req.user.id)) throw new HttpError(404, 'Partida no encontrada.');
  return m;
}

app.get('/api/my-matches', requireAuth, async (req, res) => {
  res.json({ matches: await repo.listMatchLogs(req.user.id) });
});
app.post('/api/my-matches', requireAuth, async (req, res) => {
  const mine = await repo.listMatchLogs(req.user.id);
  if (mine.length >= 1000) throw new HttpError(400, 'Llegaste al máximo de 1000 partidas guardadas.');
  res.status(201).json({ match: await repo.createMatchLog(req.user.id, validateMatchLog(req.body)) });
});
app.get('/api/my-matches/:id', requireAuth, async (req, res) => {
  res.json({ match: await ownMatchLog(req) });
});
app.put('/api/my-matches/:id', requireAuth, async (req, res) => {
  const cur = await ownMatchLog(req);
  const m = validateMatchLog({ ...cur, ...req.body, log: req.body.log ?? cur.log });
  res.json({ match: await repo.updateMatchLog(cur.id, m) });
});
app.delete('/api/my-matches/:id', requireAuth, async (req, res) => {
  const cur = await ownMatchLog(req);
  await repo.deleteMatchLog(cur.id);
  res.json({ ok: true });
});

// ---------- Perfiles públicos y estadísticas ----------

app.get('/api/users/:username', async (req, res) => {
  const user = await repo.findUserByUsername(str(req.params.username, 30));
  if (!user || (user.blocked && !isAdmin(req.user))) throw new HttpError(404, 'Usuario no encontrado.');
  const [listings, decks] = await Promise.all([
    repo.listListings({ userId: user.id, onlyAvailable: true }), repo.listDecks(user.id, { onlyPublic: true }),
  ]);
  res.json({ user: publicUser(user), listings: listings.map(l => listingOut(l, req.fx)),
             decks: decks.map(d => deckOut(d, req.fx, { withCards: false })) });
});

app.get('/api/stats', async (_req, res) => res.json(await repo.stats()));

// ---------- Administración (solo administradores) ----------

// Resumen, usuarios con sus totales y todas las publicaciones (incluidas vendidas y de cuentas suspendidas)
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const [users, listings, tournaments] = await Promise.all([
    repo.listUsers(), repo.listListings({}), repo.listTournaments(),
  ]);
  const perUser = new Map();
  for (const l of listings) {
    const c = perUser.get(String(l.user_id)) || { available: 0, sold: 0 };
    c[l.status === 'sold' ? 'sold' : 'available']++;
    perUser.set(String(l.user_id), c);
  }
  res.json({
    summary: {
      users: users.length,
      admins: users.filter(isAdmin).length,
      blocked: users.filter(u => u.blocked).length,
      listings_available: listings.filter(l => l.status === 'available').length,
      listings_sold: listings.filter(l => l.status === 'sold').length,
      accessories: listings.filter(l => l.kind === 'accessory').length,
      tournaments: tournaments.length,
    },
    users: users.map(u => ({ ...adminUser(u), listings: perUser.get(String(u.id)) || { available: 0, sold: 0 } })),
    listings: listings.map(l => listingOut(l, req.fx)),
  });
});

async function targetUser(req) {
  const user = await repo.getUser(str(req.params.id, 40));
  if (!user) throw new HttpError(404, 'Usuario no encontrado.');
  return user;
}

// Editar datos de perfil, rol de administrador y suspensión de una cuenta
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await targetUser(req);
  const self = sameId(user.id, req.user.id);
  const role = req.body.is_admin === undefined ? user.role || '' : req.body.is_admin ? 'admin' : '';
  const blocked = req.body.blocked === undefined ? !!user.blocked : !!req.body.blocked;
  if (self && role !== 'admin') throw new HttpError(400, 'No puedes quitarte a ti mismo el rol de administrador.');
  if (self && blocked) throw new HttpError(400, 'No puedes suspender tu propia cuenta.');

  if (['first_name', 'last_name', 'location', 'contact'].some(k => req.body[k] !== undefined))
    await repo.updateUser(user.id, validateProfile({ ...user, ...req.body }));
  const updated = await repo.setUserAdminFlags(user.id, { role, blocked });
  res.json({ user: adminUser(updated) });
});

// Borrar una cuenta con todas sus publicaciones y fotos. Si participa en torneos se pide suspenderla en su lugar,
// para no romper rondas ni resultados de otros jugadores.
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await targetUser(req);
  if (sameId(user.id, req.user.id)) throw new HttpError(400, 'No puedes borrar tu propia cuenta desde aquí.');
  const [joined, tournaments] = await Promise.all([repo.listUserTournamentIds(user.id), repo.listTournaments()]);
  if (joined.length || tournaments.some(t => sameId(t.organizer_id, user.id)))
    throw new HttpError(409, 'Esta cuenta participa u organiza torneos: suspéndela en lugar de borrarla.');

  const listings = await repo.listListings({ userId: user.id });
  for (const l of listings) {
    await repo.deleteListing(l.id);
    await Promise.all((l.photos || []).map(p => deleteFile(photoKey(p.filename)).catch(() => {})));
  }
  for (const d of await repo.listDecks(user.id)) await repo.deleteDeck(d.id);
  for (const m of await repo.listMatchLogs(user.id)) await repo.deleteMatchLog(m.id);
  await repo.deleteUser(user.id);
  res.json({ ok: true, deleted_listings: listings.length });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Las fotos pesan demasiado.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos mal formados.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 502 ? err.message : 'Error interno del servidor.' });
});

app.listen(PORT, () => console.log(`TCG Market escuchando en http://localhost:${PORT} (almacenamiento: ${STORAGE})`));
