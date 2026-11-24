// Repositorio de datos con Amazon DynamoDB (ambientes en AWS). Diseño de tabla única:
//
//   Entidad              PK                    SK         Índices
//   Usuario              USER#<id>             PROFILE
//   Usuario único        USERNAME#<lower>      UNIQUE     (garantiza que no se repita)
//   Correo único         EMAIL#<lower>         UNIQUE
//   Sesión               SESSION#<token>       SESSION    ttl = caducidad automática
//   Carta en venta       LISTING#<id>          LISTING    GSI1: USER#<id> / fecha · GSI2: LISTING / fecha
//   Contadores           META                  COUNTERS
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

  async updateUser(id, { display_name, location, contact }) {
    const out = await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: `USER#${id}`, SK: 'PROFILE' },
      UpdateExpression: 'SET display_name = :d, #loc = :l, contact = :c',
      ExpressionAttributeNames: { '#loc': 'location' },
      ExpressionAttributeValues: { ':d': display_name, ':l': location, ':c': contact },
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
};
