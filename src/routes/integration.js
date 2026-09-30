'use strict';
/*
 * Integração com sistemas externos (site de vendas e Silbeck).
 * Autenticação por chave: cabeçalho  X-API-Key: rf_...
 *
 *  GET  /api/v1/disponibilidade?data=2026-10-01&refeicao=almoco
 *  POST /api/v1/reservas            (uma reserva ou { reservas: [...] })
 *  GET  /api/v1/reservas/:numero
 */
const crypto = require('node:crypto');
const { route, HttpError } = require('../http');
const { db, tx, audit, getSetting, setSetting } = require('../db');
const { MEALS, isISODate, todayISO, addDays, nowLocal } = require('../util');
const { restaurantsFor, paxLoads, isEligible } = require('../meals');
const { upsertReservations } = require('../importer');
const { stayPlan } = require('./reservations');

function apiKeyAuth(req) {
  const key = req.headers['x-api-key'];
  if (!key) return null;
  const hash = crypto.createHash('sha256').update(String(key)).digest('hex');
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND active = 1').get(hash);
  if (row) db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowLocal(), row.id);
  return row || null;
}

function availability(date, meal) {
  const loads = paxLoads(date, meal);
  return restaurantsFor(meal).map((r) => {
    const used = loads[r.id] || 0;
    return {
      restaurante: r.code, nome: r.name, capacidade: r.cap || null, ocupado: used,
      disponivel: r.cap ? Math.max(0, r.cap - used) : null, lotado: !!r.cap && used >= r.cap,
    };
  });
}

route('GET', '/api/v1/disponibilidade', { apiKey: true }, ({ query }) => {
  const from = isISODate(query.data) ? query.data : todayISO();
  const days = Math.min(Math.max(parseInt(query.dias, 10) || 1, 1), 31);
  const meals = MEALS.includes(query.refeicao) ? [query.refeicao] : MEALS;
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    for (const m of meals) out.push({ data: d, refeicao: m, restaurantes: availability(d, m) });
  }
  return { disponibilidade: out };
});

// Converte o formato externo (português) para o interno
function fromExternal(o) {
  return {
    reservation_number: o.numero_reserva ?? o.reserva ?? o.reservation_number,
    guest_name: o.nome ?? o.nome_completo ?? o.guest_name,
    checkin: o.entrada ?? o.checkin,
    checkout: o.saida ?? o.checkout,
    room: o.quarto ?? o.room,
    board: o.pensao ?? o.board,
    adults: o.adultos ?? o.adults,
    children: o.criancas ?? o.children,
  };
}

function restByCode(code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM restaurants WHERE (code = ? OR name = ?) AND active = 1').get(String(code).toUpperCase(), String(code));
}

function applyChoices(resNumber, choices) {
  const r = db.prepare('SELECT * FROM reservations WHERE reservation_number = ?').get(resNumber);
  const results = [];
  if (!r) return results;
  for (const c of choices || []) {
    const date = c.data, meal = c.refeicao;
    const rest = restByCode(c.restaurante);
    if (!isISODate(date) || !MEALS.includes(meal) || !rest) { results.push({ ...c, ok: false, erro: 'dados inválidos' }); continue; }
    if (!isEligible(r, date, meal)) { results.push({ ...c, ok: false, erro: 'refeição não incluída na pensão/estadia' }); continue; }
    if (!(rest[`share_${meal}`] > 0)) { results.push({ ...c, ok: false, erro: `${rest.name} não serve esta refeição` }); continue; }
    const a = db.prepare('SELECT * FROM assignments WHERE reservation_id = ? AND date = ? AND meal = ?').get(r.id, date, meal);
    const loads = paxLoads(date, meal);
    const pax = r.adults + r.children;
    const already = a && a.restaurant_id === rest.id ? pax : 0;
    const cap = rest[`cap_${meal}`];
    if (cap && (loads[rest.id] || 0) - already + pax > cap) { results.push({ ...c, ok: false, erro: 'restaurante lotado' }); continue; }
    if (a) db.prepare('UPDATE assignments SET restaurant_id = ?, locked = 1, origin = ? WHERE id = ?').run(rest.id, r.source, a.id);
    else db.prepare('INSERT INTO assignments(reservation_id, date, meal, restaurant_id, locked, origin) VALUES (?,?,?,?,1,?)').run(r.id, date, meal, rest.id, r.source);
    results.push({ ...c, ok: true });
  }
  return results;
}

function ingest(list, source) {
  const records = list.map((o) => {
    const rec = fromExternal(o);
    const pref = restByCode(o.restaurante_preferido);
    if (pref) rec.pref_restaurant_id = pref.id;
    return rec;
  });
  const result = upsertReservations(records, { source });
  const escolhas = [];
  tx(() => {
    for (const o of list) if (Array.isArray(o.escolhas) && o.escolhas.length) {
      escolhas.push({ numero_reserva: String(fromExternal(o).reservation_number), resultado: applyChoices(String(fromExternal(o).reservation_number).trim(), o.escolhas) });
    }
  });
  return { inseridas: result.inserted, atualizadas: result.updated, sem_mudanca: result.unchanged, trocas_de_quarto: result.roomChanges, erros: result.errors, escolhas };
}

route('POST', '/api/v1/reservas', { apiKey: true }, ({ body, apiClient, ip }) => {
  const list = Array.isArray(body.reservas) ? body.reservas : Array.isArray(body) ? body : [body];
  if (!list.length || list.length > 2000) throw new HttpError(400, 'Envie de 1 a 2000 reservas.');
  const out = ingest(list, apiClient.source === 'outro' ? 'api' : apiClient.source);
  audit({ id: null, username: `api:${apiClient.name}` }, 'api_reservas', { recebidas: list.length, inseridas: out.inseridas, atualizadas: out.atualizadas, erros: out.erros.length }, ip);
  return out;
});

route('GET', '/api/v1/reservas/:numero', { apiKey: true }, ({ params }) => {
  const r = db.prepare('SELECT * FROM reservations WHERE reservation_number = ?').get(params.numero);
  if (!r) throw new HttpError(404, 'Reserva não encontrada.');
  return {
    numero_reserva: r.reservation_number, nome: r.guest_name, entrada: r.checkin, saida: r.checkout, quarto: r.room, pensao: r.board,
    adultos: r.adults, criancas: r.children, situacao: r.status,
    plano: stayPlan(r).map((d) => ({ data: d.date, refeicoes: Object.fromEntries(Object.entries(d.meals).map(([m, v]) => [m, v.included ? (v.restaurant ? v.restaurant.code : null) : false])) })),
  };
});

// ---------- Silbeck: busca periódica ----------
// O formato da API do Silbeck ainda será definido. Esperamos um JSON com uma lista de reservas
// (array direto ou { reservas: [...] }) usando os mesmos campos da API acima. Ajuste fromExternal()
// quando a documentação estiver disponível.
async function syncSilbeck() {
  const url = getSetting('silbeck_url');
  if (!url) return { skipped: 'URL não configurada' };
  const token = getSetting('silbeck_token');
  const resp = await fetch(url, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`Silbeck respondeu HTTP ${resp.status}`);
  const data = await resp.json();
  const list = Array.isArray(data) ? data : data.reservas || data.reservations || data.data || [];
  const out = ingest(list, 'silbeck');
  const summary = `${list.length} recebidas, ${out.inseridas} novas, ${out.atualizadas} atualizadas, ${out.erros.length} com erro`;
  setSetting('silbeck_last_sync', nowLocal());
  setSetting('silbeck_last_result', summary);
  audit(null, 'silbeck_sincronizado', summary);
  return out;
}

let lastSilbeck = 0;
function silbeckTick() {
  const min = Number(getSetting('silbeck_interval_min', '5')) || 5;
  if (!getSetting('silbeck_url') || Date.now() - lastSilbeck < min * 60e3) return;
  lastSilbeck = Date.now();
  syncSilbeck().catch((e) => { setSetting('silbeck_last_result', 'Erro: ' + e.message); console.error('[silbeck]', e.message); });
}

route('POST', '/api/integration/silbeck/sync', { roles: ['admin'] }, async () => {
  try { return await syncSilbeck(); } catch (e) { setSetting('silbeck_last_result', 'Erro: ' + e.message); throw new HttpError(502, e.message); }
});

// Disponibilidade também para a tela interna
route('GET', '/api/availability', ({ query }) => {
  const d = isISODate(query.date) ? query.date : todayISO();
  return MEALS.map((m) => ({ meal: m, restaurants: availability(d, m) }));
});

module.exports = { apiKeyAuth, silbeckTick };
