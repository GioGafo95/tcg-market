import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { repo, STORAGE, putFile, deleteFile, publicUrl, uploadsHandler } from './storage/index.js';
import { searchCards, getCardByRef, cacheRefImage } from './cards.js';
import { getUsdMxn, toMxn } from './fx.js';

const fxInfo = fx => (fx ? { rate: Math.round(fx.rate * 10000) / 10000, date: fx.date, source: fx.source } : null);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 30;
const SECURE_COOKIES = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

const GAMES = ['pokemon', 'yugioh'];
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
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

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sameId = (a, b) => String(a) === String(b);

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
      if (user) { req.user = user; req.sessionToken = token; }
    }
    next();
  } catch (err) { next(err); }
});

// Tipo de cambio USD→MXN para las respuestas de la API (en caché 6 h; nunca bloquea si falla)
app.use('/api', async (req, _res, next) => {
  req.fx = await getUsdMxn().catch(() => null);
  next();
});
app.get('/api/fx', (req, res) => res.json({ base: 'USD', quote: 'MXN', fx: fxInfo(req.fx) }));

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión.' });
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
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const login = str(req.body.login, 120);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = login ? await repo.findUserByLogin(login) : null;
  if (!user || !verifyPassword(password, user.password_hash))
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.sessionToken) await repo.deleteSession(req.sessionToken);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user) || null }));

app.put('/api/auth/me', requireAuth, async (req, res) => {
  const user = await repo.updateUser(req.user.id, validateProfile(req.body));
  res.json({ user: publicUser(user) });
});

// ---------- Búsqueda de cartas y precio estimado ----------

app.get('/api/lookup', requireAuth, async (req, res) => {
  const game = GAMES.includes(req.query.game) ? req.query.game : null;
  if (!game) throw new HttpError(400, 'Juego no válido.');
  try {
    const results = await searchCards(game, str(req.query.q, 100));
    res.json({
      results: results.map(r => ({ ...r, market_price_mxn: toMxn(r.market_price, req.fx) })),
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
  const game = str(body.game, 10);
  const card_name = str(body.card_name, 120);
  const price = Number(body.price);
  const quantity = body.quantity === undefined ? 1 : Number(body.quantity);
  const condition = CONDITIONS.includes(body.condition) ? body.condition : 'NM';

  if (!GAMES.includes(game)) throw new HttpError(400, 'Elige un juego válido (Pokémon o Yu-Gi-Oh!).');
  if (!card_name) throw new HttpError(400, 'El nombre de la carta es obligatorio.');
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'El precio no es válido.');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) throw new HttpError(400, 'La cantidad no es válida.');

  return {
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

// Catálogo público: todas las cartas en circulación
app.get('/api/listings', async (req, res) => {
  const listings = await repo.listListings({
    onlyAvailable: true,
    game: GAMES.includes(req.query.game) ? req.query.game : '',
    condition: CONDITIONS.includes(req.query.condition) ? req.query.condition : '',
    q: str(req.query.q, 100), seller: str(req.query.seller, 30), sort: str(req.query.sort, 20),
  });
  res.json({ listings: listings.map(l => listingOut(l, req.fx)) });
});

app.get('/api/listings/mine', requireAuth, async (req, res) => {
  const listings = await repo.listListings({ userId: req.user.id });
  res.json({ listings: listings.map(l => listingOut(l, req.fx)) });
});

app.get('/api/listings/:id', async (req, res) => {
  const l = await repo.getListing(str(req.params.id, 40));
  if (!l) throw new HttpError(404, 'Carta no encontrada.');
  res.json({ listing: listingOut(l, req.fx) });
});

app.post('/api/listings', requireAuth, async (req, res) => {
  const data = validateListing(req.body);
  const newPhotos = Array.isArray(req.body.new_photos) ? req.body.new_photos : [];
  if (newPhotos.length < 1) throw new HttpError(400, 'Debes subir al menos una foto real de tu carta.');
  if (newPhotos.length > MAX_PHOTOS) throw new HttpError(400, `Máximo ${MAX_PHOTOS} fotos por carta.`);

  const ref = await resolveReference(data);
  const photos = await storePhotos(newPhotos);
  const listing = await repo.createListing(req.user.id, { ...data, ...ref }, photos);
  res.status(201).json({ listing: listingOut(listing, req.fx) });
});

async function ownListing(req) {
  const l = await repo.getListing(str(req.params.id, 40));
  if (!l) throw new HttpError(404, 'Carta no encontrada.');
  if (!sameId(l.user_id, req.user.id)) throw new HttpError(403, 'Esta carta no es tuya.');
  return l;
}

app.put('/api/listings/:id', requireAuth, async (req, res) => {
  const existing = await ownListing(req);
  const data = validateListing(req.body);

  // Fotos: las que el vendedor conserva + las nuevas. Siempre debe quedar al menos una.
  const current = existing.photos || [];
  const keepIds = Array.isArray(req.body.keep_photos) ? req.body.keep_photos.map(String) : current.map(p => String(p.id));
  const kept = current.filter(p => keepIds.includes(String(p.id)));
  const removed = current.filter(p => !keepIds.includes(String(p.id)));
  const newPhotos = Array.isArray(req.body.new_photos) ? req.body.new_photos : [];
  if (kept.length + newPhotos.length < 1) throw new HttpError(400, 'Tu publicación debe tener al menos una foto real de la carta.');
  if (kept.length + newPhotos.length > MAX_PHOTOS) throw new HttpError(400, `Máximo ${MAX_PHOTOS} fotos por carta.`);

  const ref = await resolveReference(data, existing);
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

// ---------- Perfiles públicos y estadísticas ----------

app.get('/api/users/:username', async (req, res) => {
  const user = await repo.findUserByUsername(str(req.params.username, 30));
  if (!user) throw new HttpError(404, 'Usuario no encontrado.');
  const listings = await repo.listListings({ userId: user.id, onlyAvailable: true });
  res.json({ user: publicUser(user), listings: listings.map(l => listingOut(l, req.fx)) });
});

app.get('/api/stats', async (_req, res) => res.json(await repo.stats()));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Las fotos pesan demasiado.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos mal formados.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 502 ? err.message : 'Error interno del servidor.' });
});

app.listen(PORT, () => console.log(`TCG Market escuchando en http://localhost:${PORT} (almacenamiento: ${STORAGE})`));
