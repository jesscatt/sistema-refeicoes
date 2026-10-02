'use strict';
// Painel da TV: faturamento e ocupação do mês atual e dos 3 seguintes (Silbeck), metas das unidades
// (Resort, Park, Azeite, Envase) e ranking de vendas (Walk-ins/Reservas por Funcionário).
const crypto = require('node:crypto');
const { route, HttpError } = require('../http');
const { db, audit, getSetting, setSetting } = require('../db');
const { todayISO, monthRange, addDays } = require('../util');
const { parseSilbeckPdf } = require('../silbeck-pdf');

const TV_EDIT = ['admin', 'supervisor', 'agencia'];
const UNITS = [['resort', 'Resort'], ['park', 'Park'], ['azeite', 'Azeite'], ['envase', 'Envase']];
const DEFAULT_SELLERS = 'Tissiano, Nicolas, Maria, Carlos';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const nextMonth = (m) => addDays(monthRange(m).last, 1).slice(0, 7);
const months4 = () => { const a = [todayISO().slice(0, 7)]; for (let i = 0; i < 3; i++) a.push(nextMonth(a[a.length - 1])); return a; };
const sellersCfg = () => String(getSetting('tv_sellers', DEFAULT_SELLERS)).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
function tvKey() {
  let k = getSetting('tv_key');
  if (!k) { k = crypto.randomBytes(18).toString('base64url'); setSetting('tv_key', k); }
  return k;
}

function lastSales() {
  const b = db.prepare('SELECT MAX(batch) b FROM tv_sales').get().b;
  if (!b) return { rows: [], period_from: null, period_to: null, generated_at: null };
  const rows = db.prepare('SELECT * FROM tv_sales WHERE batch = ? ORDER BY value DESC').all(b);
  return { rows, period_from: rows[0] ? rows[0].period_from : null, period_to: rows[0] ? rows[0].period_to : null, generated_at: rows[0] ? rows[0].generated_at : null, imported_at: rows[0] ? rows[0].imported_at : null };
}

function dashboard() {
  const ms = months4();
  const cur = ms[0];
  const fc = Object.fromEntries(db.prepare(`SELECT * FROM tv_forecast WHERE month IN (${ms.map(() => '?').join(',')})`).all(...ms).map((r) => [r.month, r]));
  const months = ms.map((m) => {
    const f = fc[m];
    return f ? { month: m, revenue: f.revenue, apts_pct: f.apts_pct, beds_pct: f.beds_pct, apts_occ: f.apts_occ, apts_total: f.apts_total, adr_apt: f.adr_apt, stay_avg: f.stay_avg, generated_at: f.generated_at } : { month: m, revenue: null };
  });
  // Unidades do mês atual: Resort usa o faturamento do Silbeck quando o valor não foi informado
  const saved = Object.fromEntries(db.prepare('SELECT * FROM tv_units WHERE month = ?').all(cur).map((r) => [r.unit, r]));
  const units = UNITS.map(([k, label]) => {
    const s = saved[k] || {};
    let value = s.value, source = 'informado';
    if (k === 'resort' && (value === null || value === undefined) && fc[cur]) { value = fc[cur].revenue; source = 'silbeck'; }
    const goal = s.goal ?? null;
    return { unit: k, label, value: value ?? null, goal, missing: goal != null && value != null ? Math.max(0, goal - value) : null, pct: goal ? (value || 0) / goal : null, source };
  });
  const tv = units.reduce((s, u) => s + (u.value || 0), 0), tg = units.reduce((s, u) => s + (u.goal || 0), 0);
  // Ranking de vendas: somente os vendedores do cliente final configurados
  const sales = lastSales();
  const ranking = sellersCfg().map((name) => {
    const n = norm(name);
    const hit = sales.rows.filter((r) => norm(r.seller).split(' ')[0] === n.split(' ')[0] || norm(r.seller).startsWith(n));
    return {
      name, full_names: hit.map((h) => h.seller),
      value: hit.reduce((s, h) => s + h.value, 0), room_nights: hit.reduce((s, h) => s + (h.room_nights || 0), 0), apts: hit.reduce((s, h) => s + (h.apts || 0), 0),
    };
  }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const salesTotal = ranking.reduce((s, r) => s + r.value, 0);
  const salesGoal = Number(getSetting('tv_sales_goal_' + cur, '')) || null;
  return {
    now: new Date().toISOString(), month: cur, months, units,
    units_total: { value: tv, goal: tg || null, missing: tg ? Math.max(0, tg - tv) : null, pct: tg ? tv / tg : null },
    sales: { period_from: sales.period_from, period_to: sales.period_to, generated_at: sales.generated_at, ranking, total: salesTotal, goal: salesGoal, missing: salesGoal ? Math.max(0, salesGoal - salesTotal) : null, pct: salesGoal ? salesTotal / salesGoal : null },
  };
}

// Dados do painel: com a chave da TV (sem login) ou com usuário logado
route('GET', '/api/tv/data', { auth: false }, ({ query, req }) => {
  const key = String(query.key || req.headers['x-tv-key'] || '');
  const ok = key && crypto.timingSafeEqual(Buffer.from(key.padEnd(64).slice(0, 64)), Buffer.from(tvKey().padEnd(64).slice(0, 64))) && key === tvKey();
  if (!ok) {
    const sid = (String(req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/) || [])[1];
    const s = sid && db.prepare('SELECT u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ? AND s.expires_at > ?').get(sid, Date.now());
    if (!s || !s.active || !['admin', 'supervisor', 'agencia', 'refeicao'].includes(s.role)) throw new HttpError(401, 'Acesso ao painel não autorizado.');
  }
  return dashboard();
});

route('GET', '/api/tv/admin', { roles: TV_EDIT }, () => {
  const cur = todayISO().slice(0, 7);
  const ms = months4();
  return {
    ...dashboard(), key: tvKey(), sellers: sellersCfg().join(', '), months4: ms,
    unit_rows: ms.map((m) => ({ month: m, units: UNITS.map(([k, label]) => { const r = db.prepare('SELECT * FROM tv_units WHERE month = ? AND unit = ?').get(m, k) || {}; return { unit: k, label, value: r.value ?? null, goal: r.goal ?? null }; }), sales_goal: Number(getSetting('tv_sales_goal_' + m, '')) || null })),
    forecasts: db.prepare('SELECT month, revenue, apts_pct, beds_pct, generated_at, imported_at, filename FROM tv_forecast ORDER BY month DESC LIMIT 12').all(),
    sales_all: lastSales(), current: cur,
  };
});

route('POST', '/api/tv/upload', { roles: TV_EDIT, raw: 15 * 1024 * 1024 }, ({ body, req, user, ip }) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  let r;
  try { r = parseSilbeckPdf(body); } catch (e) { throw new HttpError(400, e.message); }
  if (r.type === 'previsao') {
    db.prepare(`INSERT INTO tv_forecast(month, period_from, period_to, revenue, apts_total, apts_occ, apts_pct, beds_total, beds_occ, beds_pct, adr_apt, adr_bed, stay_avg, days, generated_at, imported_at, filename)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'), ?)
      ON CONFLICT(month) DO UPDATE SET period_from = excluded.period_from, period_to = excluded.period_to, revenue = excluded.revenue, apts_total = excluded.apts_total, apts_occ = excluded.apts_occ,
        apts_pct = excluded.apts_pct, beds_total = excluded.beds_total, beds_occ = excluded.beds_occ, beds_pct = excluded.beds_pct, adr_apt = excluded.adr_apt, adr_bed = excluded.adr_bed,
        stay_avg = excluded.stay_avg, days = excluded.days, generated_at = excluded.generated_at, imported_at = excluded.imported_at, filename = excluded.filename`)
      .run(r.month, r.period_from, r.period_to, r.revenue, r.apts_total, r.apts_occ, r.apts_pct, r.beds_total, r.beds_occ, r.beds_pct, r.adr_apt, r.adr_bed, r.stay_avg, JSON.stringify(r.days), r.generated_at, filename);
    audit(user, 'tv_previsao_importada', { mes: r.month, faturamento: r.revenue, ocupacao: r.apts_pct, arquivo: filename }, ip);
    return { type: r.type, month: r.month, revenue: r.revenue, apts_pct: r.apts_pct, beds_pct: r.beds_pct };
  }
  const batch = (db.prepare('SELECT MAX(batch) b FROM tv_sales').get().b || 0) + 1;
  const ins = db.prepare('INSERT INTO tv_sales(batch, period_from, period_to, seller, room_nights, apts, pax_rn, value, generated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const s of r.sellers) ins.run(batch, r.period_from, r.period_to, s.name, s.room_nights, s.apts, s.pax_rn, s.value, r.generated_at);
  audit(user, 'tv_vendas_importadas', { periodo: [r.period_from, r.period_to], vendedores: r.sellers.length, total: r.total, arquivo: filename }, ip);
  return { type: r.type, period_from: r.period_from, period_to: r.period_to, sellers: r.sellers.length, total: r.total };
});

route('PUT', '/api/tv/units', { roles: TV_EDIT }, ({ body, user, ip }) => {
  const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : null;
  if (!month) throw new HttpError(400, 'Informe o mês.');
  const val = (v) => (v === '' || v === null || v === undefined ? null : Math.round(Number(String(v).replace(/\./g, '').replace(',', '.')) * 100) / 100);
  const up = db.prepare(`INSERT INTO tv_units(month, unit, value, goal, updated_by) VALUES (?,?,?,?,?)
    ON CONFLICT(month, unit) DO UPDATE SET value = excluded.value, goal = excluded.goal, updated_by = excluded.updated_by, updated_at = datetime('now','localtime')`);
  for (const u of body.units || []) {
    if (!UNITS.some(([k]) => k === u.unit)) continue;
    const v = val(u.value), g = val(u.goal);
    if ((v !== null && !Number.isFinite(v)) || (g !== null && !Number.isFinite(g))) throw new HttpError(400, 'Valor inválido.');
    up.run(month, u.unit, v, g, user.id);
  }
  if (body.sales_goal !== undefined) setSetting('tv_sales_goal_' + month, val(body.sales_goal) ?? '');
  audit(user, 'tv_metas_alteradas', body, ip);
  return { ok: true };
});

route('PUT', '/api/tv/settings', { roles: TV_EDIT }, ({ body, user, ip }) => {
  if (body.sellers !== undefined) {
    const list = String(body.sellers).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) throw new HttpError(400, 'Informe ao menos um vendedor.');
    setSetting('tv_sellers', list.join(', '));
  }
  if (body.new_key) setSetting('tv_key', crypto.randomBytes(18).toString('base64url'));
  audit(user, 'tv_configurado', { sellers: body.sellers, nova_chave: !!body.new_key }, ip);
  return { ok: true, key: tvKey() };
});

module.exports = { dashboard };
