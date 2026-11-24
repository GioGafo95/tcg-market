import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { searchCards, getCardByRef, cacheRefImage } from './cards.js';

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 30;

const GAMES = ['pokemon', 'yugioh'];
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_DIR = 'uploads/photos';
mkdirSync(PHOTO_DIR, { recursive: true });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Las fotos llegan como data URLs dentro del JSON (el navegador las comprime antes de enviarlas)
app.use(express.json({ limit: '30mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads', {
  setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

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

function createSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expires.toISOString());
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'lax', expires,
    secure: process.env.NODE_ENV === 'production',
  });
}

const publicUser = u => u && ({
  id: u.id, username: u.username, display_name: u.display_name,
  location: u.location, contact: u.contact, created_at: u.created_at,
});

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Decodifica, valida (por contenido real, no solo por la extensión) y guarda una foto
function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) throw new HttpError(400, 'Las fotos deben ser JPG, PNG o WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(400, 'Cada foto debe pesar menos de 4 MB.');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const ext = isJpeg ? '.jpg' : isPng ? '.png' : isWebp ? '.webp' : null;
  if (!ext) throw new HttpError(400, 'Una de las fotos no es una imagen válida.');
  const filename = randomBytes(16).toString('hex') + ext;
  writeFileSync(join(PHOTO_DIR, filename), buf);
  return filename;
}

function removePhotoFile(filename) {
  try { unlinkSync(join(PHOTO_DIR, filename)); } catch { /* ya no existe */ }
}

// Adjunta req.user si hay una sesión válida
app.use((req, _res, next) => {
  const token = parseCookies(req.headers.cookie).session;
  if (token) {
    const row = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
    if (row) { req.user = row; req.sessionToken = token; }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  next();
}

// ---------- Autenticación ----------

app.post('/api/auth/register', (req, res) => {
  const username = str(req.body.username, 30);
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const display_name = str(req.body.display_name, 60) || username;

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
    return res.status(400).json({ error: 'El usuario debe tener 3-30 caracteres: letras, números o _.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Correo electrónico no válido.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email);
  if (exists) return res.status(409).json({ error: 'Ese usuario o correo ya está registrado.' });

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (username, email, password_hash, display_name, location, contact)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
      username, email, hashPassword(password), display_name,
      str(req.body.location, 80), str(req.body.contact, 120));

  createSession(res, Number(lastInsertRowid));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const login = str(req.body.login, 120);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login.toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user) || null }));

app.put('/api/auth/me', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET display_name = ?, location = ?, contact = ? WHERE id = ?').run(
    str(req.body.display_name, 60) || req.user.username,
    str(req.body.location, 80), str(req.body.contact, 120), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---------- Búsqueda de cartas y precio estimado ----------

app.get('/api/lookup', requireAuth, async (req, res) => {
  const game = GAMES.includes(req.query.game) ? req.query.game : null;
  if (!game) return res.status(400).json({ error: 'Juego no válido.' });
  try {
    res.json({ results: await searchCards(game, str(req.query.q, 100)) });
  } catch (err) {
    console.error('lookup:', err.message);
    res.status(502).json({ error: 'No se pudo consultar la base de datos de cartas. Intenta de nuevo o rellena los datos a mano.' });
  }
});

// ---------- Cartas en venta ----------

const LISTING_SELECT = `
  SELECT l.*, u.username, u.display_name, u.location, u.contact,
    (SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
    (SELECT filename FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover_photo
  FROM listings l JOIN users u ON u.id = l.user_id`;

function getPhotos(listingId) {
  return db.prepare('SELECT id, filename FROM listing_photos WHERE listing_id = ? ORDER BY position, id')
    .all(listingId).map(p => ({ id: p.id, url: `/${PHOTO_DIR}/${p.filename}` }));
}

function withPhotos(row) {
  return row && { ...row, photos: getPhotos(row.id) };
}

const listingOut = row => ({
  ...row, cover_photo: row.cover_photo ? `/${PHOTO_DIR}/${row.cover_photo}` : null,
});

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
  const keep = previous && previous.ref_id === data.ref_id && previous.game === data.game ? {
    image_url: previous.image_url, market_price: previous.market_price,
    market_source: previous.market_source, market_updated: previous.market_updated,
  } : { image_url: '', market_price: null, market_source: '', market_updated: null };
  if (!data.ref_id) return { image_url: '', market_price: null, market_source: '', market_updated: null };
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

// Catálogo público: todas las cartas en circulación
app.get('/api/listings', (req, res) => {
  const where = [`l.status = 'available'`, 'l.quantity > 0'];
  const params = [];
  if (GAMES.includes(req.query.game)) { where.push('l.game = ?'); params.push(req.query.game); }
  if (CONDITIONS.includes(req.query.condition)) { where.push('l.condition = ?'); params.push(req.query.condition); }
  if (req.query.q) {
    where.push('(l.card_name LIKE ? OR l.set_name LIKE ? OR l.card_code LIKE ?)');
    const q = `%${str(req.query.q, 100)}%`;
    params.push(q, q, q);
  }
  if (req.query.seller) { where.push('u.username = ?'); params.push(str(req.query.seller, 30)); }

  const order = {
    price_asc: 'l.price ASC', price_desc: 'l.price DESC', name: 'l.card_name COLLATE NOCASE ASC',
  }[req.query.sort] || 'l.created_at DESC';

  const rows = db.prepare(`${LISTING_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`).all(...params);
  res.json({ listings: rows.map(listingOut) });
});

app.get('/api/listings/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`${LISTING_SELECT} WHERE l.user_id = ? ORDER BY l.created_at DESC`).all(req.user.id);
  res.json({ listings: rows.map(listingOut) });
});

app.get('/api/listings/:id', (req, res) => {
  const row = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Carta no encontrada.' });
  res.json({ listing: withPhotos(listingOut(row)) });
});

app.post('/api/listings', requireAuth, async (req, res) => {
  const data = validateListing(req.body);
  const newPhotos = Array.isArray(req.body.new_photos) ? req.body.new_photos : [];
  if (newPhotos.length < 1) throw new HttpError(400, 'Debes subir al menos una foto real de tu carta.');
  if (newPhotos.length > MAX_PHOTOS) throw new HttpError(400, `Máximo ${MAX_PHOTOS} fotos por carta.`);

  const ref = await resolveReference(data);
  const saved = newPhotos.map(savePhoto); // valida todas antes de tocar la base de datos

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO listings (user_id, game, card_name, set_name, card_code, rarity, condition, language,
                          price, quantity, notes, ref_id, image_url, market_price, market_source, market_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.id, data.game, data.card_name, data.set_name, data.card_code, data.rarity, data.condition,
      data.language, data.price, data.quantity, data.notes, data.ref_id,
      ref.image_url, ref.market_price, ref.market_source, ref.market_updated);

  const insertPhoto = db.prepare('INSERT INTO listing_photos (listing_id, filename, position) VALUES (?, ?, ?)');
  saved.forEach((f, i) => insertPhoto.run(lastInsertRowid, f, i));

  res.status(201).json({ listing: withPhotos(listingOut(db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(lastInsertRowid))) });
});

function ownListing(req) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Carta no encontrada.');
  if (row.user_id !== req.user.id) throw new HttpError(403, 'Esta carta no es tuya.');
  return row;
}

app.put('/api/listings/:id', requireAuth, async (req, res) => {
  const existing = ownListing(req);
  const data = validateListing(req.body);

  // Fotos: las que el vendedor conserva + las nuevas. Siempre debe quedar al menos una.
  const current = db.prepare('SELECT id, filename FROM listing_photos WHERE listing_id = ? ORDER BY position, id').all(existing.id);
  const keepIds = Array.isArray(req.body.keep_photos) ? req.body.keep_photos.map(Number) : current.map(p => p.id);
  const kept = current.filter(p => keepIds.includes(p.id));
  const removed = current.filter(p => !keepIds.includes(p.id));
  const newPhotos = Array.isArray(req.body.new_photos) ? req.body.new_photos : [];
  if (kept.length + newPhotos.length < 1) throw new HttpError(400, 'Tu publicación debe tener al menos una foto real de la carta.');
  if (kept.length + newPhotos.length > MAX_PHOTOS) throw new HttpError(400, `Máximo ${MAX_PHOTOS} fotos por carta.`);

  const ref = await resolveReference(data, existing);
  const saved = newPhotos.map(savePhoto);
  const status = req.body.status === 'sold' ? 'sold' : req.body.status === 'available' ? 'available' : existing.status;

  db.prepare(`
    UPDATE listings SET game=?, card_name=?, set_name=?, card_code=?, rarity=?, condition=?, language=?,
      price=?, quantity=?, notes=?, status=?, ref_id=?, image_url=?, market_price=?, market_source=?,
      market_updated=?, updated_at=datetime('now')
    WHERE id = ?`).run(
      data.game, data.card_name, data.set_name, data.card_code, data.rarity, data.condition, data.language,
      data.price, data.quantity, data.notes, status, data.ref_id, ref.image_url, ref.market_price,
      ref.market_source, ref.market_updated, existing.id);

  const del = db.prepare('DELETE FROM listing_photos WHERE id = ?');
  removed.forEach(p => { del.run(p.id); removePhotoFile(p.filename); });
  const insertPhoto = db.prepare('INSERT INTO listing_photos (listing_id, filename, position) VALUES (?, ?, ?)');
  saved.forEach((f, i) => insertPhoto.run(existing.id, f, kept.length + i));

  res.json({ listing: withPhotos(listingOut(db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(existing.id))) });
});

app.patch('/api/listings/:id/status', requireAuth, (req, res) => {
  const existing = ownListing(req);
  const status = req.body.status === 'sold' ? 'sold' : 'available';
  db.prepare(`UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, existing.id);
  res.json({ ok: true, status });
});

app.delete('/api/listings/:id', requireAuth, (req, res) => {
  const existing = ownListing(req);
  const photos = db.prepare('SELECT filename FROM listing_photos WHERE listing_id = ?').all(existing.id);
  db.prepare('DELETE FROM listings WHERE id = ?').run(existing.id);
  photos.forEach(p => removePhotoFile(p.filename));
  res.json({ ok: true });
});

// ---------- Perfiles públicos y estadísticas ----------

app.get('/api/users/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.params.username, 30));
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const listings = db.prepare(`${LISTING_SELECT} WHERE l.user_id = ? AND l.status = 'available' AND l.quantity > 0
    ORDER BY l.created_at DESC`).all(user.id);
  res.json({ user: publicUser(user), listings: listings.map(listingOut) });
});

app.get('/api/stats', (_req, res) => {
  const byGame = db.prepare(`SELECT game, COUNT(*) AS listings, COALESCE(SUM(quantity),0) AS cards
    FROM listings WHERE status = 'available' AND quantity > 0 GROUP BY game`).all();
  const sellers = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM listings
    WHERE status = 'available' AND quantity > 0`).get().n;
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ byGame, sellers, users });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Las fotos pesan demasiado.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos mal formados.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, () => console.log(`TCG Market escuchando en http://localhost:${PORT}`));
