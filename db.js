// Base de datos SQLite usando el módulo nativo de Node (node:sqlite), sin dependencias extra.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/tcg.db');

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

  -- Fotos reales que sube el vendedor de su carta
  CREATE TABLE IF NOT EXISTS listing_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_photos_listing ON listing_photos(listing_id);
`);

// Migraciones: columnas añadidas después de la primera versión
const cols = db.prepare('PRAGMA table_info(listings)').all().map(c => c.name);
const added = {
  ref_id: "TEXT DEFAULT ''",          // id de la carta en la base de datos pública (pokemontcg.io / ygoprodeck)
  market_price: 'REAL',               // precio estimado de mercado en USD
  market_source: "TEXT DEFAULT ''",
  market_updated: 'TEXT',
};
for (const [name, def] of Object.entries(added)) {
  if (!cols.includes(name)) db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${def}`);
}
