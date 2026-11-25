// Repositorio de datos con Amazon DynamoDB (ambientes en AWS). Diseño de tabla única:
//
//   Entidad              PK                    SK         Índices
//   Usuario              USER#<id>             PROFILE
//   Usuario único        USERNAME#<lower>      UNIQUE     (garantiza que no se repita)
//   Correo único         EMAIL#<lower>         UNIQUE
//   Sesión               SESSION#<token>       SESSION    ttl = caducidad automática
//   Carta en venta       LISTING#<id>          LISTING    GSI1: USER#<id> / fecha · GSI2: LISTING / fecha
//   Contadores           META                  COUNTERS
//   ID Pokémon único     POKEID#<id>           UNIQUE     (un ID de jugador por cuenta)
//   Torneo               TOURNEY#<id>          META       GSI2: TOURNEY / fecha de inicio
//   Jugador inscrito     TOURNEY#<id>          PLAYER#<userId>   GSI1: PLAYER#<userId> / fecha
//   Partida              TOURNEY#<id>          MATCH#<ronda>#<mesa>
//
// El catálogo lee las cartas por GSI2 y filtra en memoria: suficiente para QA y volúmenes pequeños.
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, BatchGetCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
});

const newId = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

const strip = item => {
  if (!item) return null;
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ttl, type, ...rest } = item;
  return rest;
};

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...out.Items);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getUsers(ids) {
  const unique = [...new Set(ids)];
  const map = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const keys = unique.slice(i, i + 100).map(id => ({ PK: `USER#${id}`, SK: 'PROFILE' }));
    let req = { [TABLE]: { Keys: keys } };
    while (req && Object.keys(req).length) {
      const out = await ddb.send(new BatchGetCommand({ RequestItems: req }));
      for (const u of out.Responses?.[TABLE] || []) map.set(u.id, strip(u));
      req = out.UnprocessedKeys;
    }
  }
  return map;
}

// Añade a cada carta los datos públicos del vendedor
async function withSellers(listings) {
  const users = await getUsers(listings.map(l => l.user_id));
  return listings.map(l => {
    const u = users.get(l.user_id) || {};
    return { ...l, username: u.username, display_name: u.display_name, location: u.location, contact: u.contact };
  });
}

function listingItem(id, userId, data, photos, createdAt) {
  return {
    PK: `LISTING#${id}`, SK: 'LISTING', type: 'listing',
    GSI1PK: `USER#${userId}`, GSI1SK: createdAt,
    GSI2PK: 'LISTING', GSI2SK: createdAt,
    id, user_id: userId, ...data, photos, created_at: createdAt, updated_at: now(),
  };
}

export const repo = {
  // ---------- Usuarios ----------
  async createUser(u) {
    const id = newId();
    const user = { id, ...u, username: u.username, created_at: now() };
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: TABLE, Item: { PK: `USERNAME#${u.username.toLowerCase()}`, SK: 'UNIQUE', userId: id },
                 ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: { PK: `EMAIL#${u.email.toLowerCase()}`, SK: 'UNIQUE', userId: id },
                 ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: { PK: `USER#${id}`, SK: 'PROFILE', type: 'user', ...user } } },
        { Update: { TableName: TABLE, Key: { PK: 'META', SK: 'COUNTERS' }, UpdateExpression: 'ADD #u :one',
                    ExpressionAttributeNames: { '#u': 'users' }, ExpressionAttributeValues: { ':one': 1 } } },
      ] }));
    } catch (err) {
      if (err.name === 'TransactionCanceledException') { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
      throw err;
    }
    return user;
  },

  async getUser(id) {
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${id}`, SK: 'PROFILE' } }));
    return strip(out.Item);
  },

  async findUserByUsername(username) {
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USERNAME#${username.toLowerCase()}`, SK: 'UNIQUE' } }));
    return out.Item ? this.getUser(out.Item.userId) : null;
  },

  async findUserByLogin(login) {
    const key = login.includes('@') ? `EMAIL#${login.toLowerCase()}` : `USERNAME#${login.toLowerCase()}`;
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: key, SK: 'UNIQUE' } }));
    return out.Item ? this.getUser(out.Item.userId) : null;
  },

  async updateUser(id, { display_name, first_name, last_name, location, contact }) {
    const out = await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: `USER#${id}`, SK: 'PROFILE' },
      UpdateExpression: 'SET display_name = :d, first_name = :f, last_name = :a, #loc = :l, contact = :c',
      ExpressionAttributeNames: { '#loc': 'location' },
      ExpressionAttributeValues: { ':d': display_name, ':f': first_name, ':a': last_name, ':l': location, ':c': contact },
      ReturnValues: 'ALL_NEW',
    }));
    return strip(out.Attributes);
  },

  // ---------- Sesiones ----------
  async createSession(token, userId, expiresAt) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `SESSION#${token}`, SK: 'SESSION', type: 'session', userId, expires_at: expiresAt,
      ttl: Math.floor(new Date(expiresAt).getTime() / 1000),
    } }));
  },

  async getSessionUser(token) {
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `SESSION#${token}`, SK: 'SESSION' } }));
    if (!out.Item || out.Item.expires_at <= now()) return null;
    return this.getUser(out.Item.userId);
  },

  async deleteSession(token) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `SESSION#${token}`, SK: 'SESSION' } }));
  },

  // ---------- Cartas ----------
  async getListing(id) {
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `LISTING#${id}`, SK: 'LISTING' } }));
    if (!out.Item) return null;
    return (await withSellers([strip(out.Item)]))[0];
  },

  async createListing(userId, data, photos) {
    const id = newId();
    await ddb.send(new PutCommand({ TableName: TABLE, Item: listingItem(id, userId, { ...data, status: 'available' }, photos, now()) }));
    return this.getListing(id);
  },

  async updateListing(id, data, photos) {
    const current = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `LISTING#${id}`, SK: 'LISTING' } }));
    if (!current.Item) return null;
    await ddb.send(new PutCommand({ TableName: TABLE,
      Item: listingItem(id, current.Item.user_id, data, photos, current.Item.created_at) }));
    return this.getListing(id);
  },

  async setListingStatus(id, status) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: `LISTING#${id}`, SK: 'LISTING' },
      UpdateExpression: 'SET #s = :s, updated_at = :u', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':u': now() }, ConditionExpression: 'attribute_exists(PK)',
    }));
  },

  async deleteListing(id) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `LISTING#${id}`, SK: 'LISTING' } }));
  },

  async listListings(f) {
    let items = f.userId
      ? await queryAll({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p',
          ExpressionAttributeValues: { ':p': `USER#${f.userId}` }, ScanIndexForward: false })
      : await queryAll({ TableName: TABLE, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :p',
          ExpressionAttributeValues: { ':p': 'LISTING' }, ScanIndexForward: false });
    items = items.map(strip);

    if (f.onlyAvailable) items = items.filter(l => l.status === 'available' && l.quantity > 0);
    if (f.game) items = items.filter(l => l.game === f.game);
    if (f.condition) items = items.filter(l => l.condition === f.condition);
    if (f.q) {
      const q = f.q.toLowerCase();
      items = items.filter(l => [l.card_name, l.set_name, l.card_code].some(v => (v || '').toLowerCase().includes(q)));
    }
    let out = await withSellers(items);
    if (f.seller) out = out.filter(l => (l.username || '').toLowerCase() === f.seller.toLowerCase());

    const sorters = {
      price_asc: (a, b) => a.price - b.price,
      price_desc: (a, b) => b.price - a.price,
      name: (a, b) => a.card_name.localeCompare(b.card_name, 'es', { sensitivity: 'base' }),
    };
    if (sorters[f.sort]) out.sort(sorters[f.sort]);
    return out.slice(0, 200);
  },

  async stats() {
    const listings = (await this.listListings({ onlyAvailable: true })).slice();
    const byGameMap = {};
    for (const l of listings) {
      byGameMap[l.game] ??= { game: l.game, listings: 0, cards: 0 };
      byGameMap[l.game].listings++;
      byGameMap[l.game].cards += l.quantity;
    }
    const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'META', SK: 'COUNTERS' } }));
    return {
      byGame: Object.values(byGameMap),
      sellers: new Set(listings.map(l => l.user_id)).size,
      users: meta.Item?.users || 0,
    };
  },

  // ---------- ID de jugador Pokémon (Play! Pokémon) ----------
  async setPokemonId(userId, pokemonId) {
    const user = await this.getUser(userId);
    const old = user?.pokemon_id || '';
    if (old === pokemonId) return user;
    const items = [
      { Update: { TableName: TABLE, Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
                  UpdateExpression: 'SET pokemon_id = :p', ExpressionAttributeValues: { ':p': pokemonId } } },
    ];
    if (pokemonId) items.push({ Put: { TableName: TABLE, Item: { PK: `POKEID#${pokemonId}`, SK: 'UNIQUE', userId },
                                       ConditionExpression: 'attribute_not_exists(PK)' } });
    if (old) items.push({ Delete: { TableName: TABLE, Key: { PK: `POKEID#${old}`, SK: 'UNIQUE' } } });
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      if (err.name === 'TransactionCanceledException') { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
      throw err;
    }
    return this.getUser(userId);
  },

  // ---------- Torneos ----------
  async createTournament(organizerId, t) {
    const id = newId();
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `TOURNEY#${id}`, SK: 'META', type: 'tournament', GSI2PK: 'TOURNEY', GSI2SK: t.starts_at,
      id, organizer_id: organizerId, ...t, status: 'registration', current_round: 0, player_count: 0, created_at: now(),
    } }));
    return this.getTournament(id);
  },

  async getTournament(id) {
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `TOURNEY#${id}`, SK: 'META' } }));
    if (!out.Item) return null;
    return (await withOrganizers([strip(out.Item)]))[0];
  },

  async listTournaments() {
    const items = await queryAll({ TableName: TABLE, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :p',
      ExpressionAttributeValues: { ':p': 'TOURNEY' }, ScanIndexForward: false });
    return withOrganizers(items.map(strip).slice(0, 200));
  },

  async updateTournament(id, { status, current_round }) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: `TOURNEY#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, current_round = :r', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':r': current_round }, ConditionExpression: 'attribute_exists(PK)',
    }));
    return this.getTournament(id);
  },

  async deleteTournament(id) {
    const items = await queryAll({ TableName: TABLE, KeyConditionExpression: 'PK = :p',
      ExpressionAttributeValues: { ':p': `TOURNEY#${id}` }, ProjectionExpression: 'PK, SK' });
    await Promise.all(items.map(k => ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: k.PK, SK: k.SK } }))));
  },

  async getTournamentPlayers(id) {
    const items = await queryAll({ TableName: TABLE, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': `TOURNEY#${id}`, ':s': 'PLAYER#' } });
    const users = await getUsers(items.map(i => i.user_id));
    return items
      .map(i => {
        const u = users.get(i.user_id) || {};
        return { user_id: i.user_id, joined_at: i.joined_at, username: u.username, display_name: u.display_name,
                 location: u.location, pokemon_id: u.pokemon_id || '' };
      })
      .sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  },

  async joinTournament(id, userId) {
    const joined = now();
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: TABLE, ConditionExpression: 'attribute_not_exists(PK)', Item: {
          PK: `TOURNEY#${id}`, SK: `PLAYER#${userId}`, type: 'player', GSI1PK: `PLAYER#${userId}`, GSI1SK: joined,
          tournament_id: id, user_id: userId, joined_at: joined } } },
        { Update: { TableName: TABLE, Key: { PK: `TOURNEY#${id}`, SK: 'META' }, UpdateExpression: 'ADD player_count :one',
                    ExpressionAttributeValues: { ':one': 1 } } },
      ] }));
    } catch (err) {
      if (err.name !== 'TransactionCanceledException') throw err; // ya estaba inscrito
    }
  },

  async leaveTournament(id, userId) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: TABLE, Key: { PK: `TOURNEY#${id}`, SK: `PLAYER#${userId}` }, ConditionExpression: 'attribute_exists(PK)' } },
        { Update: { TableName: TABLE, Key: { PK: `TOURNEY#${id}`, SK: 'META' }, UpdateExpression: 'ADD player_count :m',
                    ExpressionAttributeValues: { ':m': -1 } } },
      ] }));
    } catch (err) {
      if (err.name !== 'TransactionCanceledException') throw err; // no estaba inscrito
    }
  },

  async getMatches(id) {
    const items = await queryAll({ TableName: TABLE, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': `TOURNEY#${id}`, ':s': 'MATCH#' } });
    return items.map(strip).map(m => ({ ...m, player2_id: m.player2_id ?? null, result: m.result ?? null }))
      .sort((a, b) => a.round - b.round || a.table_no - b.table_no);
  },

  async addMatches(id, matches) {
    await Promise.all(matches.map(m => ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `TOURNEY#${id}`, SK: matchSK(m.round, m.table_no), type: 'match',
      tournament_id: id, round: m.round, table_no: m.table_no,
      player1_id: m.player1_id, player2_id: m.player2_id ?? undefined, result: m.result ?? undefined,
    } }))));
  },

  async setMatchResult(id, round, tableNo, result) {
    const key = { PK: `TOURNEY#${id}`, SK: matchSK(round, tableNo) };
    await ddb.send(new UpdateCommand(result
      ? { TableName: TABLE, Key: key, UpdateExpression: 'SET #r = :r', ExpressionAttributeNames: { '#r': 'result' },
          ExpressionAttributeValues: { ':r': result }, ConditionExpression: 'attribute_exists(PK)' }
      : { TableName: TABLE, Key: key, UpdateExpression: 'REMOVE #r', ExpressionAttributeNames: { '#r': 'result' },
          ConditionExpression: 'attribute_exists(PK)' }));
  },

  async listUserTournamentIds(userId) {
    const items = await queryAll({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p',
      ExpressionAttributeValues: { ':p': `PLAYER#${userId}` } });
    return items.map(i => i.tournament_id);
  },
};

const matchSK = (round, table) => `MATCH#${String(round).padStart(3, '0')}#${String(table).padStart(4, '0')}`;

// Añade a cada torneo el usuario y nombre de quien lo organiza
async function withOrganizers(list) {
  const users = await getUsers(list.map(t => t.organizer_id));
  return list.map(t => {
    const u = users.get(t.organizer_id) || {};
    return { ...t, player_count: t.player_count || 0, organizer_username: u.username, organizer_name: u.display_name };
  });
}
