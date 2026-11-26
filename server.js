import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { repo, STORAGE, putFile, deleteFile, publicUrl, uploadsHandler } from './storage/index.js';
import { searchCards, getCardByRef, cacheRefImage } from './cards.js';
import { getUsdMxn, toMxn } from './fx.js';
import { outcome, opponentOf, standings, pairRound, streaks } from './tournaments.js';
import { parseTdf, TdfError, shortName } from './tdf.js';

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
const meUser = u => u && ({ ...publicUser(u), pokemon_id: u.pokemon_id || '' });

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
app.get('/api/fx', (req, res) => res.json({
  base: 'USD', quote: 'MXN', fx: fxInfo(req.fx),
  // Regla de fotos obligatorias (el formulario la usa para avisar; el servidor la vuelve a aplicar al guardar)
  photos: { min_usd: PHOTO_MIN_USD, fallback_rate: FALLBACK_USD_MXN },
}));

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
  res.status(201).json({ user: meUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const login = str(req.body.login, 120);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = login ? await repo.findUserByLogin(login) : null;
  if (!user || !verifyPassword(password, user.password_hash))
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
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
    const source = ['pokemontcg', 'tcgdex', 'tcgdex-es'].includes(req.query.source) ? req.query.source : '';
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
  res.json({ listings: listings.map(l => listingOut(l, req.fx)) });
});

// Expansiones que tienen cartas en venta (para el filtro del catálogo), con cuántas publicaciones hay de cada una
app.get('/api/listings/sets', async (req, res) => {
  const game = GAMES.includes(req.query.game) ? req.query.game : '';
  const listings = await repo.listListings({ onlyAvailable: true, game, kind: 'card' });
  const counts = new Map();
  for (const l of listings) {
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
  if (!l) throw new HttpError(404, 'Carta no encontrada.');
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

async function ownListing(req) {
  const l = await repo.getListing(str(req.params.id, 40));
  if (!l) throw new HttpError(404, 'Carta no encontrada.');
  if (!sameId(l.user_id, req.user.id)) throw new HttpError(403, 'Esta carta no es tuya.');
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

function validateTournament(body) {
  const name = str(body.name, 80).replace(/\s+/g, ' ');
  const location = str(body.location, 80);
  const starts_at = str(body.starts_at, 16);
  const rounds = body.rounds === '' || body.rounds === undefined ? 0 : Number(body.rounds);
  if (name.length < 3) throw new HttpError(400, 'El nombre del torneo debe tener al menos 3 caracteres.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts_at) || Number.isNaN(Date.parse(starts_at)))
    throw new HttpError(400, 'Indica la fecha y hora del torneo.');
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 15) throw new HttpError(400, 'Las rondas deben ser de 0 a 15 (0 = sin límite).');
  return { name, location, starts_at, rounds };
}

const lite = p => p && { user_id: p.user_id, username: p.username, display_name: p.display_name };

async function loadTournament(id) {
  const t = await repo.getTournament(str(id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (t.source === 'tdf') return loadTdfTournament(t);
  const [players, matches] = await Promise.all([repo.getTournamentPlayers(t.id), repo.getMatches(t.id)]);
  return { t, players, matches, table: standings(players, matches) };
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

const isOrganizer = (t, user) => user && sameId(t.organizer_id, user.id);
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
  res.json({
    tournament: { ...tournament, player_count: players.length,
                  ...(L.tdf ? { organizer_tom: organizerName(tdf_data.organizer), categories: tdf_data.categories.map(c => c.label) } : {}) },
    can_manage: manage,
    // El ID de jugador solo lo ve quien organiza (para capturarlo en el reporte oficial)
    players: players.map(p => ({ ...lite(p), user_id: pub(p.user_id), location: p.location, category: p.category,
                                 ...(manage ? { pokemon_id: p.pokemon_id } : {}) })),
    standings: table.map(({ opponents, ...r }) => ({ ...r, user_id: pub(r.user_id) })),
    rounds: [...rounds.values()].map(r => ({ ...r, label: roundLabel(r.round, r.topcut, r.matches.length) })),
    round_complete: matches.filter(m => m.round === t.current_round).every(m => m.result),
    me: joined ? { joined, key: pub(key), match: hideOpponentId(L, currentMatch(L, key)), ...streaks(resultsIn(matches, key)) }
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
  if (existing && !sameId(existing.organizer_id, req.user.id) && existing.tdf_data?.organizer?.popid !== mine)
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
  if (!req.user.pokemon_id) throw new HttpError(400, 'Vincula tu ID de jugador Pokémon antes de inscribirte.');
  await repo.joinTournament(t.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/tournaments/:id/leave', requireAuth, async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (t.status !== 'registration') throw new HttpError(400, 'El torneo ya empezó; habla con quien lo organiza.');
  await repo.leaveTournament(t.id, req.user.id);
  res.json({ ok: true });
});

// Genera la siguiente ronda (la primera cierra las inscripciones)
app.post('/api/tournaments/:id/rounds', requireAuth, async (req, res) => {
  const { t, players, matches } = await managedTournament(req);
  if (t.status === 'finished') throw new HttpError(400, 'El torneo ya terminó.');
  if (players.length < 2) throw new HttpError(400, 'Se necesitan al menos 2 jugadores inscritos.');
  if (matches.some(m => m.round === t.current_round && !m.result))
    throw new HttpError(400, 'Faltan resultados de la ronda actual.');
  if (t.rounds && t.current_round >= t.rounds) throw new HttpError(400, 'Ya se jugaron todas las rondas; finaliza el torneo.');
  const round = t.current_round + 1;
  await repo.addMatches(t.id, pairRound(players, matches, round));
  await repo.updateTournament(t.id, { status: 'running', current_round: round });
  res.status(201).json({ ok: true, round });
});

app.put('/api/tournaments/:id/matches/:round/:table', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  const round = Number(req.params.round), table = Number(req.params.table);
  const m = matches.find(x => x.round === round && x.table_no === table);
  if (!m) throw new HttpError(404, 'Partida no encontrada.');
  if (t.status !== 'running' || round !== t.current_round) throw new HttpError(400, 'Solo se pueden capturar resultados de la ronda en curso.');
  if (m.player2_id == null) throw new HttpError(400, 'Un bye no lleva resultado.');
  const result = ['p1', 'p2', 'tie'].includes(req.body.result) ? req.body.result : null;
  await repo.setMatchResult(t.id, round, table, result);
  res.json({ ok: true });
});

app.post('/api/tournaments/:id/finish', requireAuth, async (req, res) => {
  const { t, matches } = await managedTournament(req);
  if (t.status !== 'running') throw new HttpError(400, 'El torneo no está en curso.');
  if (matches.some(m => m.round === t.current_round && !m.result)) throw new HttpError(400, 'Faltan resultados de la ronda actual.');
  await repo.updateTournament(t.id, { status: 'finished', current_round: t.current_round });
  res.json({ ok: true });
});

app.delete('/api/tournaments/:id', requireAuth, async (req, res) => {
  const t = await repo.getTournament(str(req.params.id, 40));
  if (!t) throw new HttpError(404, 'Torneo no encontrado.');
  if (!isOrganizer(t, req.user)) throw new HttpError(403, 'Solo quien organiza el torneo puede hacer esto.');
  // Un torneo importado de TOM se puede quitar siempre (se puede volver a importar); uno de la app, antes de empezar
  if (t.source !== 'tdf' && t.status !== 'registration') throw new HttpError(400, 'Solo se puede borrar un torneo que no ha empezado.');
  await repo.deleteTournament(t.id);
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
