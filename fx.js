// Tipo de cambio USD → MXN para mostrar el precio de mercado (TCGplayer, en USD) en pesos.
// Fuente principal: Frankfurter (tipo de referencia del Banco Central Europeo). Respaldo: open.er-api.com.
// Se guarda en memoria 6 horas; si ninguna fuente responde se usa el último valor conocido.
const TTL_MS = 6 * 60 * 60 * 1000;
let cached = null; // { rate, date, source, fetchedAt }

const SOURCES = [
  {
    name: 'Banco Central Europeo (Frankfurter)',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN',
    parse: d => ({ rate: d?.rates?.MXN, date: d?.date }),
  },
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: d => ({ rate: d?.rates?.MXN, date: d?.time_last_update_utc ? new Date(d.time_last_update_utc).toISOString().slice(0, 10) : null }),
  },
];

export async function getUsdMxn() {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const { rate, date } = s.parse(await res.json());
      if (Number.isFinite(rate) && rate > 5 && rate < 100) {
        cached = { rate, date, source: s.name, fetchedAt: Date.now() };
        return cached;
      }
    } catch { /* probar la siguiente fuente */ }
  }
  return cached; // último valor conocido (o null si nunca se obtuvo)
}

export const toMxn = (usd, fx) => (Number.isFinite(usd) && usd > 0 && fx ? Math.round(usd * fx.rate * 100) / 100 : null);
