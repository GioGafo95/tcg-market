// Repositorio de datos con SQLite (desarrollo local). Usa el módulo nativo node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/tcg.db');

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    location      TEXT DEFAULT '',
    contact       TEXT DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game        TEXT NOT NULL CHECK (game IN ('pokemon', 'yugioh')),
    card_name   TEXT NOT NULL,
    set_name    TEXT DEFAULT '',
    card_code   TEXT DEFAULT '',
    rarity      TEXT DEFAULT '',
    condition   TEXT NOT NULL DEFAULT 'NM',
    language    TEXT NOT NULL DEFAULT 'Español',
    price       REAL NOT NULL CHECK (price >= 0),
    quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    image_url   TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_listings_game   ON listings(game);
  CREATE INDEX IF NOT EXISTS idx_listings_user   ON listings(user_id);
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);

  CREATE TABLE IF NOT EXISTS listing_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_photos_listing ON listing_photos(listing_id);

  CREATE TABLE IF NOT EXISTS tournaments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    location      TEXT DEFAULT '',
    starts_at     TEXT NOT NULL,
    rounds        INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('registration', 'running', 'finished')),
    current_round INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tournament_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tplayers_user ON tournament_players(user_id);

  -- Partidas por ronda. player2_id NULL = bye. result: p1 | p2 | tie | NULL (pendiente)
  CREATE TABLE IF NOT EXISTS matches (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round         INTEGER NOT NULL,
    table_no      INTEGER NOT NULL,
    player1_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player2_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    result        TEXT CHECK (result IN ('p1', 'p2', 'tie')),
    PRIMARY KEY (tournament_id, round, table_no)
  );
`);

// Migraciones de columnas añadidas después de la primera versión
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
for (const name of ['first_name', 'last_name', 'pokemon_id']) {
  if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT DEFAULT ''`);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pokemon_id ON users(pokemon_id) WHERE pokemon_id <> ''");
const cols = db.prepare('PRAGMA table_info(listings)').all().map(c => c.name);
for (const [name, def] of Object.entries({
  ref_id: "TEXT DEFAULT ''", market_price: 'REAL', market_source: "TEXT DEFAULT ''", market_updated: 'TEXT',
})) {
  if (!cols.includes(name)) db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${def}`);
}

// SQLite guarda fechas como "YYYY-MM-DD HH:MM:SS" (UTC); se exponen en ISO 8601
const iso = v => (v && !v.includes('T') ? v.replace(' ', 'T') + 'Z' : v);
const userOut = u => u && { ...u, created_at: iso(u.created_at) };

const LISTING_SELECT = `
  SELECT l.*, u.username, u.display_name, u.location, u.contact
  FROM listings l JOIN users u ON u.id = l.user_id`;

function listingOut(row) {
  if (!row) return null;
  const photos = db.prepare('SELECT id, filename FROM listing_photos WHERE listing_id = ? ORDER BY position, id').all(row.id)
    .map(p => ({ id: String(p.id), filename: p.filename }));
  return { ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at), photos };
}

const LISTING_FIELDS = ['game', 'card_name', 'set_name', 'card_code', 'rarity', 'condition', 'language', 'price',
  'quantity', 'notes', 'ref_id', 'image_url', 'market_price', 'market_source', 'market_updated'];

function savePhotos(listingId, photos) {
  db.prepare('DELETE FROM listing_photos WHERE listing_id = ?').run(listingId);
  const ins = db.prepare('INSERT INTO listing_photos (listing_id, filename, position) VALUES (?, ?, ?)');
  photos.forEach((p, i) => ins.run(listingId, p.filename, i));
}

export const repo = {
  // ---------- Usuarios ----------
  async createUser(u) {
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(u.username, u.email);
    if (exists) { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (username, email, password_hash, display_name, first_name, last_name, location, contact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.username, u.email, u.password_hash, u.display_name, u.first_name, u.last_name, u.location, u.contact);
    return this.getUser(lastInsertRowid);
  },
  async getUser(id) { return userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(id)); },
  async findUserByUsername(username) { return userOut(db.prepare('SELECT * FROM users WHERE username = ?').get(username)); },
  async findUserByLogin(login) {
    return userOut(db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login.toLowerCase()));
  },
  async updateUser(id, { display_name, first_name, last_name, location, contact }) {
    db.prepare(`UPDATE users SET display_name = ?, first_name = ?, last_name = ?, location = ?, contact = ? WHERE id = ?`)
      .run(display_name, first_name, last_name, location, contact, id);
    return this.getUser(id);
  },

  // ---------- Sesiones ----------
  async createSession(token, userId, expiresAt) {
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  },
  async getSessionUser(token) {
    return userOut(db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString()));
  },
  async deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); },

  // ---------- Cartas ----------
  async getListing(id) { return listingOut(db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(Number(id))); },

  async createListing(userId, data, photos) {
    const { lastInsertRowid } = db.prepare(`INSERT INTO listings (user_id, ${LISTING_FIELDS.join(', ')})
      VALUES (?, ${LISTING_FIELDS.map(() => '?').join(', ')})`).run(userId, ...LISTING_FIELDS.map(f => data[f] ?? null));
    savePhotos(lastInsertRowid, photos);
    return this.getListing(lastInsertRowid);
  },

  async updateListing(id, data, photos) {
    db.prepare(`UPDATE listings SET ${LISTING_FIELDS.map(f => `${f} = ?`).join(', ')}, status = ?, updated_at = datetime('now')
      WHERE id = ?`).run(...LISTING_FIELDS.map(f => data[f] ?? null), data.status, Number(id));
    savePhotos(Number(id), photos);
    return this.getListing(id);
  },

  async setListingStatus(id, status) {
    db.prepare(`UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, Number(id));
  },

  async deleteListing(id) { db.prepare('DELETE FROM listings WHERE id = ?').run(Number(id)); },

  // Filtros: { game, condition, q, seller, userId, onlyAvailable, sort }
  async listListings(f) {
    const where = [], params = [];
    if (f.onlyAvailable) where.push(`l.status = 'available'`, 'l.quantity > 0');
    if (f.game) { where.push('l.game = ?'); params.push(f.game); }
    if (f.condition) { where.push('l.condition = ?'); params.push(f.condition); }
    if (f.userId) { where.push('l.user_id = ?'); params.push(f.userId); }
    if (f.seller) { where.push('u.username = ?'); params.push(f.seller); }
    if (f.q) {
      where.push('(l.card_name LIKE ? OR l.set_name LIKE ? OR l.card_code LIKE ?)');
      params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    const order = { price_asc: 'l.price ASC', price_desc: 'l.price DESC', name: 'l.card_name COLLATE NOCASE ASC' }[f.sort]
      || 'l.created_at DESC';
    return db.prepare(`${LISTING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 200`)
      .all(...params).map(listingOut);
  },

  async stats() {
    const byGame = db.prepare(`SELECT game, COUNT(*) AS listings, COALESCE(SUM(quantity),0) AS cards
      FROM listings WHERE status = 'available' AND quantity > 0 GROUP BY game`).all();
    const sellers = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM listings WHERE status = 'available' AND quantity > 0`).get().n;
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    return { byGame, sellers, users };
  },

  // ---------- ID de jugador Pokémon (Play! Pokémon) ----------
  async setPokemonId(userId, pokemonId) {
    const taken = pokemonId && db.prepare('SELECT 1 FROM users WHERE pokemon_id = ? AND id <> ?').get(pokemonId, userId);
    if (taken) { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
    db.prepare('UPDATE users SET pokemon_id = ? WHERE id = ?').run(pokemonId, userId);
    return this.getUser(userId);
  },

  // ---------- Torneos ----------
  async createTournament(organizerId, t) {
    const { lastInsertRowid } = db.prepare(`INSERT INTO tournaments (organizer_id, name, location, starts_at, rounds)
      VALUES (?, ?, ?, ?, ?)`).run(organizerId, t.name, t.location, t.starts_at, t.rounds);
    return this.getTournament(lastInsertRowid);
  },

  async getTournament(id) {
    const t = db.prepare(`SELECT t.*, u.username AS organizer_username, u.display_name AS organizer_name,
      (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS player_count
      FROM tournaments t JOIN users u ON u.id = t.organizer_id WHERE t.id = ?`).get(Number(id));
    return t ? { ...t, created_at: iso(t.created_at) } : null;
  },

  async listTournaments() {
    return db.prepare(`SELECT t.*, u.username AS organizer_username, u.display_name AS organizer_name,
      (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS player_count
      FROM tournaments t JOIN users u ON u.id = t.organizer_id ORDER BY t.starts_at DESC LIMIT 200`).all()
      .map(t => ({ ...t, created_at: iso(t.created_at) }));
  },

  async updateTournament(id, { status, current_round }) {
    db.prepare('UPDATE tournaments SET status = ?, current_round = ? WHERE id = ?').run(status, current_round, Number(id));
    return this.getTournament(id);
  },

  async deleteTournament(id) { db.prepare('DELETE FROM tournaments WHERE id = ?').run(Number(id)); },

  async getTournamentPlayers(id) {
    return db.prepare(`SELECT p.user_id, p.joined_at, u.username, u.display_name, u.location, u.pokemon_id
      FROM tournament_players p JOIN users u ON u.id = p.user_id WHERE p.tournament_id = ? ORDER BY p.joined_at, p.user_id`)
      .all(Number(id)).map(p => ({ ...p, joined_at: iso(p.joined_at) }));
  },

  async joinTournament(id, userId) {
    db.prepare('INSERT OR IGNORE INTO tournament_players (tournament_id, user_id) VALUES (?, ?)').run(Number(id), userId);
  },

  async leaveTournament(id, userId) {
    db.prepare('DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?').run(Number(id), userId);
  },

  async getMatches(id) {
    return db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, table_no').all(Number(id));
  },

  async addMatches(id, matches) {
    const ins = db.prepare(`INSERT INTO matches (tournament_id, round, table_no, player1_id, player2_id, result)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const m of matches) ins.run(Number(id), m.round, m.table_no, m.player1_id, m.player2_id ?? null, m.result ?? null);
  },

  async setMatchResult(id, round, tableNo, result) {
    db.prepare('UPDATE matches SET result = ? WHERE tournament_id = ? AND round = ? AND table_no = ?')
      .run(result, Number(id), round, tableNo);
  },

  // Torneos en los que participa un usuario (para su historial y su partida actual)
  async listUserTournamentIds(userId) {
    return db.prepare('SELECT tournament_id FROM tournament_players WHERE user_id = ?').all(userId).map(r => r.tournament_id);
  },
};
