'use strict';
/*
 * Cliente da API REST do SB Hotel (Silbeck) — documentação: swagger.yaml (versão 1.0.1).
 *   POST /v1/Liberar?client_id=&client_secret=   -> { access_token, token_type, expires_in }
 *   GET  /v1/Ocupacao?tipoLista=0&dataInicial=&dataFinal=   -> totais de ocupação e diárias do período
 *   GET  /v1/ListaReserva?dataInicial=&dataFinal=&tipoData=cadastro -> reservas (usuário que cadastrou, itens, valores)
 * Usado pelo painel da TV: previsão de faturamento/ocupação por mês e vendas por funcionário.
 */
const { getSetting } = require('./db');
const { monthRange } = require('./util');

const DEFAULT_URL = 'http://cloud.silbeck.com.br:30503/datasnap/rest';

function config() {
  return {
    url: String(getSetting('silbeck_api_url', DEFAULT_URL) || DEFAULT_URL).replace(/\/+$/, ''),
    client_id: getSetting('silbeck_client_id', ''),
    client_secret: getSetting('silbeck_client_secret', ''),
  };
}

// Busca um campo sem diferenciar maiúsculas (a API mistura "ValorDiaria" e "valorDiaria")
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    if (obj[n] !== undefined) return obj[n];
    const k = Object.keys(obj).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k) return obj[k];
  }
  return undefined;
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
// O DataSnap às vezes devolve { result: [ {...} ] }
const unwrap = (j) => (j && Array.isArray(j.result) && j.result.length === 1 && typeof j.result[0] === 'object' ? j.result[0] : j);

let tok = null; // { value, type, until, key }

async function request(method, path, params = {}, { auth = true, retry = true } = {}) {
  const c = config();
  if (!c.client_id || !c.client_secret) throw new Error('Informe o client_id e o client_secret da API do Silbeck.');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
  const url = `${c.url}${path}${qs.toString() ? '?' + qs : ''}`;
  const headers = { Accept: 'application/json' };
  let body;
  if (auth) {
    const t = await token();
    headers.Authorization = `${t.type || 'Bearer'} ${t.value}`;
  } else if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = qs.toString();
  }
  let resp;
  try {
    resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new Error(`Não foi possível conectar à API do Silbeck (${c.url}): ${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  const text = await resp.text();
  if (resp.status === 401 && auth && retry) { tok = null; return request(method, path, params, { auth, retry: false }); }
  if (!resp.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); const e = pick(j, 'erro', 'error', 'message', 'mensagem'); if (e) msg = Array.isArray(e) ? e.map((x) => pick(x, 'mensagem') || JSON.stringify(x)).join('; ') : String(typeof e === 'object' ? JSON.stringify(e) : e); } catch {}
    throw new Error(`A API do Silbeck respondeu ${resp.status} em ${path}: ${msg}`);
  }
  try { return unwrap(JSON.parse(text)); } catch { throw new Error(`Resposta inválida da API do Silbeck em ${path}.`); }
}

async function token() {
  const c = config();
  const key = `${c.url}|${c.client_id}|${c.client_secret}`;
  if (tok && tok.key === key && tok.until > Date.now() + 30000) return tok;
  const j = await request('POST', '/v1/Liberar', { client_id: c.client_id, client_secret: c.client_secret }, { auth: false });
  const value = pick(j, 'access_token', 'token');
  if (!value) throw new Error('A API do Silbeck não devolveu o token de acesso. Confira o client_id e o client_secret.');
  const exp = num(pick(j, 'expires_in')) || 3600;
  tok = { value, type: pick(j, 'token_type') || 'Bearer', until: Date.now() + exp * 1000, key };
  return tok;
}

// ---------- Previsão de faturamento e ocupação de um mês ----------
async function forecastMonth(month) {
  const { first, last } = monthRange(month);
  const j = await request('GET', '/v1/Ocupacao', { tipoLista: 0, dataInicial: first, dataFinal: last });
  return mapForecast(j, month);
}

function pct(v) { const n = num(v); return n === null ? null : n <= 1 && n > 0 ? n * 100 : n; }

function mapForecast(j, month) {
  const { first, last } = monthRange(month);
  const list = pick(j, 'listaOcupacao') || [];
  const days = list.map((d) => {
    const apto = pick(d, 'apto') || {};
    return { date: String(pick(d, 'data') || '').slice(0, 10), apts_occ: num(pick(apto, 'total')), apts_pct: pct(pick(apto, 'percentual')), revenue: num(pick(d, 'totalDiaria')) };
  }).filter((d) => d.date);
  const aptsOcc = num(pick(j, 'aptoTotal')) ?? days.reduce((s, d) => s + (d.apts_occ || 0), 0);
  const aptsPct = pct(pick(j, 'aptoTotalPercentual'));
  const bedsOcc = num(pick(j, 'paxTotal'));
  const bedsPct = pct(pick(j, 'paxTotalPercentual'));
  const revenue = num(pick(j, 'totalDiaria')) ?? days.reduce((s, d) => s + (d.revenue || 0), 0);
  return {
    type: 'previsao', month, period_from: first, period_to: last,
    revenue, apts_occ: aptsOcc, apts_pct: aptsPct, apts_total: aptsPct ? Math.round((aptsOcc * 100) / aptsPct) : null,
    beds_occ: bedsOcc, beds_pct: bedsPct, beds_total: bedsPct && bedsOcc ? Math.round((bedsOcc * 100) / bedsPct) : null,
    adr_apt: num(pick(j, 'aptoTotalDiariaMedia')), adr_bed: num(pick(j, 'paxTotalDiariaMedia')), stay_avg: num(pick(j, 'mediaPermanencia')),
    days, generated_at: null,
  };
}

// ---------- Vendas por funcionário (reservas cadastradas no período) ----------
const nights = (a, b) => { if (!a || !b) return 0; const d = (Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400000; return d > 0 ? Math.round(d) : 0; };
const CANCELLED = new Set([3]); // 3 - Cancelada

function mapSales(j, from, to) {
  const list = pick(j, 'listaReserva') || [];
  const by = new Map();
  for (const r of list) {
    const seller = String(pick(r, 'nomeUsuario') || 'SEM USUÁRIO').trim().replace(/\s+/g, ' ').toUpperCase();
    for (const it of pick(r, 'listaReservaItem') || []) {
      if (CANCELLED.has(num(pick(it, 'status')))) continue;
      const qty = num(pick(it, 'qtdeApartamento')) || 1;
      const n = nights(pick(it, 'dataEntrada'), pick(it, 'dataSaida'));
      const pax = (num(pick(it, 'quantidadeAdulto')) || 0) + (num(pick(it, 'quantidadeCrianca')) || 0);
      let value = num(pick(it, 'valorTotalDiaria'));
      if (value === null) value = (pick(it, 'listaData') || []).reduce((s, d) => s + (num(pick(d, 'valorDiaria', 'ValorDiariaPrevista')) || 0), 0);
      const cur = by.get(seller) || { name: seller, room_nights: 0, apts: 0, pax_rn: 0, value: 0 };
      cur.room_nights += n * qty; cur.apts += qty; cur.pax_rn += n * pax * qty; cur.value += value || 0;
      by.set(seller, cur);
    }
  }
  const sellers = [...by.values()].map((s) => ({ ...s, value: Math.round(s.value * 100) / 100 })).sort((a, b) => b.value - a.value);
  return { type: 'vendas', period_from: from, period_to: to, sellers, total: Math.round(sellers.reduce((s, x) => s + x.value, 0) * 100) / 100, generated_at: null };
}

async function salesPeriod(from, to) {
  const j = await request('GET', '/v1/ListaReserva', { dataInicial: from, dataFinal: to, tipoData: 'cadastro' });
  return mapSales(j, from, to);
}

module.exports = { config, request, token, forecastMonth, salesPeriod, mapForecast, mapSales, DEFAULT_URL, resetToken: () => { tok = null; } };
