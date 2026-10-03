'use strict';
// Painel da TV: faturamento e ocupação do mês atual e dos 3 seguintes (Silbeck), metas das unidades
// (Resort, Parque, Azeite, Terceiros, Envase) e ranking de vendas por canal (cliente final e agências).
const crypto = require('node:crypto');
const { route, HttpError } = require('../http');
const { db, tx, audit, getSetting, setSetting } = require('../db');
const silbeck = require('../silbeck-api');
const { todayISO, monthRange, addDays } = require('../util');
const { parseSilbeckPdf } = require('../silbeck-pdf');

const TV_EDIT = ['admin', 'supervisor', 'agencia'];
const UNITS = [['resort', 'Resort'], ['parque', 'Parque'], ['azeite', 'Azeite'], ['terceiros', 'Terceiros'], ['envase', 'Envase']];
// Vendedores por canal: cliente final e agências
const GROUPS = [
  { key: 'final', label: 'Cliente final', setting: 'tv_sellers', def: 'Carlos, Tissiano, Maria, Gustavo, Nicolas' },
  { key: 'agencia', label: 'Agências', setting: 'tv_sellers_agencia', def: 'Luísa, Bianca, Guilherme, Flavio, Vitório', half: true }, // agências: diárias e apartamentos pela metade
];
// atualização das listas definidas em 02/10/2026 (aplicada uma única vez)
if (!getSetting('tv_sellers_v2')) { for (const g of GROUPS) setSetting(g.setting, g.def); setSetting('tv_sellers_v2', '1'); }

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const nextMonth = (m) => addDays(monthRange(m).last, 1).slice(0, 7);
const months4 = () => { const a = [todayISO().slice(0, 7)]; for (let i = 0; i < 3; i++) a.push(nextMonth(a[a.length - 1])); return a; };
const splitNames = (v) => String(v || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const sellersCfg = (g) => splitNames(getSetting(g.setting, g.def));
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

// Vendido até agora no Resort: total do último relatório de Walk-ins/Reservas por Funcionário do mês (todos os vendedores)
function resortSold(month) {
  const s = lastSales();
  if (!s.rows.length || !s.period_from || s.period_from.slice(0, 7) !== month) return null;
  return Math.round(s.rows.reduce((t, r) => t + (r.value || 0), 0) * 100) / 100;
}

// Unidades desativadas (não aparecem no painel nem entram nos totais)
const unitsOff = () => new Set(String(getSetting('tv_units_off', '')).split(',').filter(Boolean));

function dashboard() {
  const ms = months4();
  const cur = ms[0];
  const fc = Object.fromEntries(db.prepare(`SELECT * FROM tv_forecast WHERE month IN (${ms.map(() => '?').join(',')})`).all(...ms).map((r) => [r.month, r]));
  const months = ms.map((m) => {
    const f = fc[m];
    return f ? { month: m, revenue: f.revenue, apts_pct: f.apts_pct, beds_pct: f.beds_pct, apts_occ: f.apts_occ, apts_total: f.apts_total, adr_apt: f.adr_apt, stay_avg: f.stay_avg, beds_occ: f.beds_occ,
      // ticket médio = valor total ÷ ocupação total (hóspedes por noite)
      ticket: f.revenue && f.beds_occ ? Math.round((f.revenue / f.beds_occ) * 100) / 100 : null, generated_at: f.generated_at } : { month: m, revenue: null };
  });
  // Unidades do mês atual (planilha de metas): valor real emitido em notas + antecipações/outras receitas x previsão
  const saved = Object.fromEntries(db.prepare('SELECT * FROM tv_units WHERE month = ?').all(cur).map((r) => [r.unit, r]));
  const off = unitsOff();
  const units = UNITS.filter(([k]) => !off.has(k)).map(([k, label]) => {
    const s = saved[k] || {};
    // Vendido até agora: no Resort, o total do relatório de vendas (Walk-ins/Reservas) do mês; nas demais unidades, o valor lançado
    const silbeck = k === 'resort' ? resortSold(cur) : null;
    const value = silbeck ?? s.value ?? null, other = s.other_value ?? null, goal = s.goal ?? null;
    // Antecipações/outras receitas somam no realizado e na previsão total (como na planilha: total = previsões + antecipações)
    const done = (value || 0) + (other || 0);
    const target = goal != null ? goal + (other || 0) : null;
    return { unit: k, label, value, source: silbeck != null ? 'silbeck' : 'lancado', other, other_note: s.other_note || null, done, goal, target, missing: target != null ? Math.max(0, target - done) : null, pct: target ? done / target : null };
  });
  const tv = units.reduce((s, u) => s + (u.value || 0), 0), to = units.reduce((s, u) => s + (u.other || 0), 0), tg = units.reduce((s, u) => s + (u.goal || 0), 0);
  // Ranking de vendas por canal (cliente final e agências), somente os vendedores configurados
  const sales = lastSales();
  const rankOf = (names, f = 1) => names.map((name) => {
    const n = norm(name);
    const hit = sales.rows.filter((r) => norm(r.seller).split(' ')[0] === n.split(' ')[0] || norm(r.seller).startsWith(n));
    return {
      name, full_names: hit.map((h) => h.seller),
      value: hit.reduce((s, h) => s + h.value, 0), room_nights: Math.round(hit.reduce((s, h) => s + (h.room_nights || 0), 0) * f), apts: Math.round(hit.reduce((s, h) => s + (h.apts || 0), 0) * f), // sempre número inteiro
    };
  }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const groups = GROUPS.map((g) => { const ranking = rankOf(sellersCfg(g), g.half ? 0.5 : 1); return { key: g.key, label: g.label, ranking, total: ranking.reduce((s, r) => s + r.value, 0) }; });
  const salesTotal = groups.reduce((s, g) => s + g.total, 0);
  const salesGoal = Number(getSetting('tv_sales_goal_' + cur, '')) || null;
  return {
    now: new Date().toISOString(), month: cur, months, units,
    units_total: { value: tv, other: to, done: tv + to, goal: tg ? tg + to : null, missing: tg ? Math.max(0, tg - tv) : null, pct: tg ? (tv + to) / (tg + to) : null },
    sales: { period_from: sales.period_from, period_to: sales.period_to, generated_at: sales.generated_at, groups, total: salesTotal, goal: salesGoal, missing: salesGoal ? Math.max(0, salesGoal - salesTotal) : null, pct: salesGoal ? salesTotal / salesGoal : null },
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
    ...dashboard(), key: tvKey(), sellers: Object.fromEntries(GROUPS.map((g) => [g.key, sellersCfg(g).join(', ')])), months4: ms,
    unit_rows: ms.map((m) => ({ month: m, units: UNITS.map(([k, label]) => { const r = db.prepare('SELECT * FROM tv_units WHERE month = ? AND unit = ?').get(m, k) || {}; return { unit: k, label, active: !unitsOff().has(k), silbeck: k === 'resort' ? resortSold(m) : null, value: r.value ?? null, other_value: r.other_value ?? null, other_note: r.other_note || '', goal: r.goal ?? null }; }), sales_goal: Number(getSetting('tv_sales_goal_' + m, '')) || null })),
    forecasts: db.prepare('SELECT month, revenue, apts_pct, beds_pct, generated_at, imported_at, filename FROM tv_forecast ORDER BY month DESC LIMIT 12').all(),
    sales_all: lastSales(), current: cur,
  };
});

function saveForecast(r, filename) {
  db.prepare(`INSERT INTO tv_forecast(month, period_from, period_to, revenue, apts_total, apts_occ, apts_pct, beds_total, beds_occ, beds_pct, adr_apt, adr_bed, stay_avg, days, generated_at, imported_at, filename)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'), ?)
    ON CONFLICT(month) DO UPDATE SET period_from = excluded.period_from, period_to = excluded.period_to, revenue = excluded.revenue, apts_total = excluded.apts_total, apts_occ = excluded.apts_occ,
      apts_pct = excluded.apts_pct, beds_total = excluded.beds_total, beds_occ = excluded.beds_occ, beds_pct = excluded.beds_pct, adr_apt = excluded.adr_apt, adr_bed = excluded.adr_bed,
      stay_avg = excluded.stay_avg, days = excluded.days, generated_at = excluded.generated_at, imported_at = excluded.imported_at, filename = excluded.filename`)
    .run(r.month, r.period_from, r.period_to, r.revenue, r.apts_total, r.apts_occ, r.apts_pct, r.beds_total, r.beds_occ, r.beds_pct, r.adr_apt, r.adr_bed, r.stay_avg, JSON.stringify(r.days || []), r.generated_at, filename);
}
function saveSales(r) {
  const batch = (db.prepare('SELECT MAX(batch) b FROM tv_sales').get().b || 0) + 1;
  const ins = db.prepare('INSERT INTO tv_sales(batch, period_from, period_to, seller, room_nights, apts, pax_rn, value, generated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  tx(() => { for (const s of r.sellers) ins.run(batch, r.period_from, r.period_to, s.name, s.room_nights, s.apts, s.pax_rn, s.value, r.generated_at); });
  return batch;
}

route('POST', '/api/tv/upload', { roles: TV_EDIT, raw: 15 * 1024 * 1024 }, ({ body, req, user, ip }) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  let r;
  try { r = parseSilbeckPdf(body); } catch (e) { throw new HttpError(400, e.message); }
  if (r.type === 'previsao') {
    saveForecast(r, filename);
    audit(user, 'tv_previsao_importada', { mes: r.month, faturamento: r.revenue, ocupacao: r.apts_pct, arquivo: filename }, ip);
    return { type: r.type, month: r.month, revenue: r.revenue, apts_pct: r.apts_pct, beds_pct: r.beds_pct };
  }
  saveSales(r);
  audit(user, 'tv_vendas_importadas', { periodo: [r.period_from, r.period_to], vendedores: r.sellers.length, total: r.total, arquivo: filename }, ip);
  return { type: r.type, period_from: r.period_from, period_to: r.period_to, sellers: r.sellers.length, total: r.total };
});

// ---------- API do Silbeck: busca automática ----------
const ADMIN_ONLY = ['admin'];
const nowLocal = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

async function syncSilbeckTv(user = null) {
  const ms = months4();
  const today = todayISO();
  const stamp = nowLocal();
  const out = { months: [], sales: null };
  for (const m of ms) {
    const f = await silbeck.forecastMonth(m);
    f.generated_at = stamp;
    saveForecast(f, 'API do Silbeck');
    out.months.push({ month: m, revenue: f.revenue, apts_pct: f.apts_pct });
  }
  const from = ms[0] + '-01';
  const s = await silbeck.salesPeriod(from, today);
  s.generated_at = stamp;
  saveSales(s);
  out.sales = { period_from: from, period_to: today, sellers: s.sellers.length, total: s.total };
  const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const summary = `${out.months.map((x) => `${MES[Number(x.month.slice(5)) - 1]}/${x.month.slice(0, 4)}: R$ ${Math.round(x.revenue || 0).toLocaleString('pt-BR')}`).join(' · ')} · vendas: ${s.sellers.length} funcionários, R$ ${Math.round(s.total).toLocaleString('pt-BR')}`;
  setSetting('silbeck_tv_last_sync', stamp);
  setSetting('silbeck_tv_last_result', 'OK · ' + summary);
  audit(user, 'tv_silbeck_sincronizado', out);
  return out;
}

let lastTvSync = 0, tvSyncing = false;
function tvSilbeckTick() {
  if (getSetting('silbeck_tv_auto', '0') !== '1' || tvSyncing) return;
  const min = Math.max(10, Number(getSetting('silbeck_tv_interval_min', '30')) || 30);
  if (Date.now() - lastTvSync < min * 60e3) return;
  lastTvSync = Date.now(); tvSyncing = true;
  syncSilbeckTv().catch((e) => { setSetting('silbeck_tv_last_result', 'Erro: ' + e.message); console.error('[silbeck-tv]', e.message); }).finally(() => { tvSyncing = false; });
}

route('GET', '/api/tv/silbeck', { roles: TV_EDIT }, () => {
  const c = silbeck.config();
  return {
    url: c.url, client_id: c.client_id, has_secret: !!c.client_secret,
    auto: getSetting('silbeck_tv_auto', '0') === '1', interval_min: Number(getSetting('silbeck_tv_interval_min', '30')) || 30,
    last_sync: getSetting('silbeck_tv_last_sync', null), last_result: getSetting('silbeck_tv_last_result', null),
  };
});

route('PUT', '/api/tv/silbeck', { roles: ADMIN_ONLY }, ({ body, user, ip }) => {
  if (body.url !== undefined) {
    const u = String(body.url).trim();
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw new HttpError(400, 'Endereço da API inválido.');
    setSetting('silbeck_api_url', u || silbeck.DEFAULT_URL);
  }
  if (body.client_id !== undefined) setSetting('silbeck_client_id', String(body.client_id).trim());
  if (body.client_secret) setSetting('silbeck_client_secret', String(body.client_secret).trim()); // em branco = mantém o atual
  if (body.auto !== undefined) setSetting('silbeck_tv_auto', body.auto ? '1' : '0');
  if (body.interval_min !== undefined) setSetting('silbeck_tv_interval_min', String(Math.max(10, Math.min(1440, Number(body.interval_min) || 30))));
  silbeck.resetToken();
  audit(user, 'tv_silbeck_configurado', { url: body.url, client_id: body.client_id, segredo_alterado: !!body.client_secret, auto: body.auto, intervalo: body.interval_min }, ip);
  return { ok: true };
});

// Testa a conexão: gera o token e consulta a ocupação de hoje (nada é gravado)
route('POST', '/api/tv/silbeck/test', { roles: TV_EDIT }, async () => {
  const t0 = Date.now();
  try {
    silbeck.resetToken();
    await silbeck.token();
    const d = todayISO();
    const raw = await silbeck.request('GET', '/v1/Ocupacao', { tipoLista: 0, dataInicial: d, dataFinal: d });
    const f = silbeck.mapForecast(raw, d.slice(0, 7));
    return { ok: true, ms: Date.now() - t0, today: { apts_occ: f.apts_occ, apts_pct: f.apts_pct, revenue: f.revenue }, sample: JSON.stringify(raw).slice(0, 1500) };
  } catch (e) { throw new HttpError(502, e.message); }
});

route('POST', '/api/tv/silbeck/sync', { roles: TV_EDIT }, async ({ user }) => {
  try { return await syncSilbeckTv(user); } catch (e) { setSetting('silbeck_tv_last_result', 'Erro: ' + e.message); throw new HttpError(502, e.message); }
});

route('PUT', '/api/tv/units', { roles: TV_EDIT }, ({ body, user, ip }) => {
  const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : null;
  if (!month) throw new HttpError(400, 'Informe o mês.');
  const val = (v) => (v === '' || v === null || v === undefined ? null : Math.round(Number(String(v).replace(/\./g, '').replace(',', '.')) * 100) / 100);
  const up = db.prepare(`INSERT INTO tv_units(month, unit, value, other_value, other_note, goal, updated_by) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(month, unit) DO UPDATE SET value = excluded.value, other_value = excluded.other_value, other_note = excluded.other_note, goal = excluded.goal, updated_by = excluded.updated_by, updated_at = datetime('now','localtime')`);
  for (const u of body.units || []) {
    if (!UNITS.some(([k]) => k === u.unit)) continue;
    const v = val(u.value), o = val(u.other_value), g = val(u.goal);
    if ([v, o, g].some((x) => x !== null && !Number.isFinite(x))) throw new HttpError(400, 'Valor inválido.');
    up.run(month, u.unit, v, o, String(u.other_note || '').trim().slice(0, 80) || null, g, user.id);
  }
  if ((body.units || []).some((u) => u.active !== undefined)) {
    const off = unitsOff();
    for (const u of body.units) if (UNITS.some(([k]) => k === u.unit) && u.active !== undefined) { if (u.active) off.delete(u.unit); else off.add(u.unit); }
    if (off.size >= UNITS.length) throw new HttpError(400, 'Mantenha ao menos uma unidade ativa no painel.');
    setSetting('tv_units_off', [...off].join(','));
  }
  if (body.sales_goal !== undefined) setSetting('tv_sales_goal_' + month, val(body.sales_goal) ?? '');
  audit(user, 'tv_metas_alteradas', body, ip);
  return { ok: true };
});

route('PUT', '/api/tv/settings', { roles: TV_EDIT }, ({ body, user, ip }) => {
  if (body.sellers !== undefined) {
    const src = typeof body.sellers === 'object' && body.sellers ? body.sellers : { final: body.sellers };
    for (const g of GROUPS) {
      if (src[g.key] === undefined) continue;
      const list = splitNames(src[g.key]);
      if (!list.length) throw new HttpError(400, `Informe ao menos um vendedor em ${g.label.toLowerCase()}.`);
      setSetting(g.setting, list.join(', '));
    }
  }
  if (body.new_key) setSetting('tv_key', crypto.randomBytes(18).toString('base64url'));
  audit(user, 'tv_configurado', { sellers: body.sellers, nova_chave: !!body.new_key }, ip);
  return { ok: true, key: tvKey() };
});

module.exports = { dashboard, tvSilbeckTick, syncSilbeckTv };
