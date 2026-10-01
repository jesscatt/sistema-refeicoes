'use strict';
// Planilha de controle unificada (previsão x marcado x real) e faturamento.
const { route, HttpError } = require('../http');
const { db, audit } = require('../db');
const { MEALS, MEAL_LABEL, monthRange, isISODate, toCSV, todayISO, nowLocal, addDays } = require('../util');
const { buildXlsx } = require('../xlsx-write');
const { weekday } = require('../meals');

const BILL_VIEW = ['admin', 'supervisor', 'refeicao'];
const BILL_CLOSE = ['admin', 'supervisor'];

function checkMonth(m) {
  if (!/^\d{4}-\d{2}$/.test(m || '')) return todayISO().slice(0, 7);
  return m;
}

function closure(month) {
  return db.prepare('SELECT c.*, u.name closed_by_name FROM billing_closures c LEFT JOIN users u ON u.id = c.closed_by WHERE month = ?').get(month) || null;
}

// Linhas por dia x refeição x restaurante
function controlRows(month, restId = null) {
  const { first, last } = monthRange(month);
  return controlRange(first, last, restId);
}

function controlRange(first, last, restId = null) {
  const key = (d, m, r) => `${d}|${m}|${r}`;
  const map = new Map();
  const get = (d, m, r) => {
    const k = key(d, m, r);
    if (!map.has(k)) map.set(k, { date: d, meal: m, restaurant_id: r, forecast_adults: 0, forecast_children: 0, checked_adults: 0, checked_children: 0, fora_lista: 0, real_adults: null, real_children: null, walkin_adults: 0, walkin_children: 0, notes: null });
    return map.get(k);
  };
  const rf = restId ? ' AND a.restaurant_id = ' + Number(restId) : '';
  for (const r of db.prepare(`SELECT a.date, a.meal, a.restaurant_id, SUM(r.adults) ad, SUM(r.children) ch FROM assignments a
    JOIN reservations r ON r.id = a.reservation_id WHERE r.status = 'ativa' AND a.date BETWEEN ? AND ? ${rf} GROUP BY 1,2,3`).all(first, last)) {
    Object.assign(get(r.date, r.meal, r.restaurant_id), { forecast_adults: r.ad, forecast_children: r.ch });
  }
  const rf2 = restId ? ' AND restaurant_id = ' + Number(restId) : '';
  for (const r of db.prepare(`SELECT date, meal, restaurant_id, SUM(adults) ad, SUM(children) ch, SUM(status = 'fora_lista') fora FROM attendance
    WHERE date BETWEEN ? AND ? ${rf2} GROUP BY 1,2,3`).all(first, last)) {
    Object.assign(get(r.date, r.meal, r.restaurant_id), { checked_adults: r.ad, checked_children: r.ch, fora_lista: r.fora });
  }
  // Realizado = o que os restaurantes registraram (lista + fora da lista). Não é editável.
  for (const r of map.values()) { r.real_adults = r.checked_adults; r.real_children = r.checked_children; }
  for (const r of db.prepare(`SELECT date, meal, restaurant_id, SUM(adults) ad, SUM(children) ch FROM walkins WHERE date BETWEEN ? AND ? ${rf2} GROUP BY 1,2,3`).all(first, last)) {
    Object.assign(get(r.date, r.meal, r.restaurant_id), { walkin_adults: r.ad, walkin_children: r.ch });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || a.restaurant_id - b.restaurant_id);
}

// Base de cálculo: o REALIZADO, ou seja, os registros feitos pelos restaurantes (lista e fora da lista).
// Refeição prevista sem nenhum registro conta como "sem registro" (valor zero) e aparece em alerta.
function billedPax(row) {
  const n = row.checked_adults + row.checked_children;
  return { adults: row.checked_adults, children: row.checked_children, basis: n > 0 ? 'realizado' : 'sem_registro' };
}

function billing(month) {
  const rows = controlRows(month);
  const rests = db.prepare('SELECT id, code, name, color FROM restaurants ORDER BY id').all();
  const prices = db.prepare('SELECT * FROM prices').all();
  const out = [];
  for (const rest of rests) {
    for (const meal of MEALS) {
      const rr = rows.filter((r) => r.restaurant_id === rest.id && r.meal === meal);
      if (!rr.length && !(db.prepare(`SELECT share_${meal} s FROM restaurants WHERE id = ?`).get(rest.id).s > 0)) continue;
      const p = prices.find((x) => x.restaurant_id === rest.id && x.meal === meal) || { price_adult: 0, price_child: 0 };
      const t = { restaurant: rest, meal, days: rr.length, forecast_adults: 0, forecast_children: 0, checked_adults: 0, checked_children: 0, real_adults: 0, real_children: 0, billed_adults: 0, billed_children: 0, walkin_adults: 0, walkin_children: 0, days_without_real: 0, price_adult: p.price_adult, price_child: p.price_child };
      for (const r of rr) {
        t.forecast_adults += r.forecast_adults; t.forecast_children += r.forecast_children;
        t.checked_adults += r.checked_adults; t.checked_children += r.checked_children;
        t.real_adults += r.real_adults || 0; t.real_children += r.real_children || 0;
        t.walkin_adults += r.walkin_adults; t.walkin_children += r.walkin_children;
        const b = billedPax(r);
        t.billed_adults += b.adults; t.billed_children += b.children;
        if (b.basis === 'sem_registro' && (r.forecast_adults + r.forecast_children) > 0) t.days_without_real++;
      }
      t.value = +(t.billed_adults * t.price_adult + t.billed_children * t.price_child).toFixed(2);
      out.push(t);
    }
  }
  const total = out.reduce((s, t) => s + t.value, 0);
  return { month, lines: out, total: +total.toFixed(2) };
}

route('GET', '/api/control', { roles: ['admin', 'supervisor', 'refeicao'] }, ({ query, user }) => {
  const month = checkMonth(query.month);
  const restId = user.role === 'restaurante' ? user.restaurant_id : (Number(query.restaurant_id) || null);
  return { month, restaurant_id: restId, closed: closure(month), rows: controlRows(month, restId) };
});

// O realizado vem dos registros dos restaurantes e não pode ser digitado.
route('PUT', '/api/control', { roles: ['admin', 'refeicao'] }, () => {
  throw new HttpError(410, 'O realizado é calculado automaticamente pelos registros dos restaurantes e não pode ser editado.');
});

route('GET', '/api/billing', { roles: BILL_VIEW }, ({ query }) => {
  const month = checkMonth(query.month);
  const c = closure(month);
  if (c) return { ...JSON.parse(c.snapshot), closed: { closed_at: c.closed_at, closed_by_name: c.closed_by_name }, live: billing(month) };
  return { ...billing(month), closed: null };
});

route('POST', '/api/billing/close', { roles: BILL_CLOSE }, ({ body, user, ip }) => {
  const month = checkMonth(body.month);
  if (closure(month)) throw new HttpError(409, 'Mês já fechado.');
  const snap = billing(month);
  db.prepare('INSERT INTO billing_closures(month, closed_by, closed_at, snapshot) VALUES (?,?,?,?)').run(month, user.id, nowLocal(), JSON.stringify(snap));
  audit(user, 'faturamento_fechado', { month, total: snap.total }, ip);
  return { ok: true };
});

route('POST', '/api/billing/reopen', { roles: ['admin'] }, ({ body, user, ip }) => {
  const month = checkMonth(body.month);
  db.prepare('DELETE FROM billing_closures WHERE month = ?').run(month);
  audit(user, 'faturamento_reaberto', { month }, ip);
  return { ok: true };
});

// Relatório oficial: só supervisão e administradores
route('GET', '/api/billing/export.csv', { roles: BILL_CLOSE }, ({ query, user, ip }) => {
  const month = checkMonth(query.month);
  const c = closure(month);
  const b = c ? JSON.parse(c.snapshot) : billing(month);
  audit(user, 'faturamento_exportado', { month, fechado: !!c }, ip);
  const rows = b.lines.map((t) => [t.restaurant.name, MEAL_LABEL[t.meal], t.forecast_adults, t.forecast_children, t.billed_adults, t.billed_children,
    t.billed_adults + t.billed_children - t.forecast_adults - t.forecast_children, t.price_adult, t.price_child, t.value, t.walkin_adults + t.walkin_children, t.days_without_real]);
  rows.push(['TOTAL', '', '', '', '', '', '', '', '', b.total, '', '']);
  rows.push([c ? `Fechado em ${c.closed_at}` : 'Prévia (mês não fechado)']);
  return {
    __raw: toCSV(['Restaurante', 'Refeição', 'Previsto ADT', 'Previsto CHD', 'Realizado ADT', 'Realizado CHD', 'Diferença pax', 'Valor ADT', 'Valor CHD', 'Total R$', 'Consumo à parte (pax)', 'Refeições sem registro'], rows),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="faturamento-${month}.csv"` },
  };
});

route('GET', '/api/reports/daily.csv', { roles: BILL_CLOSE }, ({ query, user, ip }) => {
  const month = checkMonth(query.month);
  const rests = Object.fromEntries(db.prepare('SELECT id, name FROM restaurants').all().map((r) => [r.id, r.name]));
  audit(user, 'relatorio_diario_exportado', { month }, ip);
  return {
    __raw: toCSV(['Data', 'Refeição', 'Restaurante', 'Previsto ADT', 'Previsto CHD', 'Realizado ADT', 'Realizado CHD', 'Fora da lista (aptos)', 'Diferença (realizado - previsto)', 'Consumo à parte (pax)'],
      controlRows(month).map((r) => [r.date.split('-').reverse().join('/'), MEAL_LABEL[r.meal], rests[r.restaurant_id], r.forecast_adults, r.forecast_children, r.checked_adults, r.checked_children, r.fora_lista,
        r.checked_adults + r.checked_children - r.forecast_adults - r.forecast_children, r.walkin_adults + r.walkin_children])),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="controle-diario-${month}.csv"` },
  };
});

route('GET', '/api/prices', { roles: BILL_VIEW }, () => db.prepare('SELECT p.*, r.name, r.code FROM prices p JOIN restaurants r ON r.id = p.restaurant_id ORDER BY r.id').all());

route('PUT', '/api/prices', { roles: BILL_CLOSE }, ({ body, user, ip }) => {
  const up = db.prepare('UPDATE prices SET price_adult = ?, price_child = ? WHERE restaurant_id = ? AND meal = ?');
  for (const p of body.prices || []) up.run(Math.max(0, Number(p.price_adult) || 0), Math.max(0, Number(p.price_child) || 0), p.restaurant_id, p.meal);
  audit(user, 'precos_alterados', body.prices, ip);
  return { ok: true };
});

// ---------- Controle semanal da divisão (pagamento dos restaurantes) ----------
// Por restaurante e refeição: pax previsto (divisão), marcado no restaurante, real informado,
// base de pagamento (real; sem real usa o marcado), adultos e crianças, e valores em R$.
function weekly(from, to, restId = null) {
  const rows = controlRange(from, to, restId);
  const rests = db.prepare(`SELECT id, code, name, color FROM restaurants WHERE active = 1 ${restId ? 'AND id = ' + Number(restId) : ''} ORDER BY id`).all();
  const prices = db.prepare('SELECT * FROM prices').all();
  const price = (r, m) => prices.find((p) => p.restaurant_id === r && p.meal === m) || { price_adult: 0, price_child: 0 };
  const zero = () => ({ prev_adt: 0, prev_chd: 0, marc_adt: 0, marc_chd: 0, real_adt: 0, real_chd: 0, pag_adt: 0, pag_chd: 0, valor_prev: 0, valor: 0, sem_real: 0, so_previsto: 0, fora_lista: 0, avulso: 0 });
  const add = (t, r, pr) => {
    const b = billedPax(r);
    t.prev_adt += r.forecast_adults; t.prev_chd += r.forecast_children;
    t.marc_adt += r.checked_adults; t.marc_chd += r.checked_children;
    t.real_adt += r.real_adults || 0; t.real_chd += r.real_children || 0;
    t.pag_adt += b.adults; t.pag_chd += b.children;
    t.valor_prev += r.forecast_adults * pr.price_adult + r.forecast_children * pr.price_child;
    t.valor += b.adults * pr.price_adult + b.children * pr.price_child;
    if (b.basis === 'sem_registro' && (r.forecast_adults + r.forecast_children) > 0) t.sem_real++;
    t.fora_lista += r.fora_lista || 0; t.avulso += (r.walkin_adults || 0) + (r.walkin_children || 0);
  };
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const out = rests.map((rest) => {
    const meals = MEALS.map((meal) => {
      const pr = price(rest.id, meal);
      const t = { meal, price_adult: pr.price_adult, price_child: pr.price_child, ...zero(), days: {} };
      for (const r of rows.filter((x) => x.restaurant_id === rest.id && x.meal === meal)) {
        add(t, r, pr);
        const dd = (t.days[r.date] = t.days[r.date] || zero()); add(dd, r, pr);
      }
      return t;
    }).filter((t) => t.prev_adt + t.prev_chd + t.marc_adt + t.marc_chd + t.real_adt + t.real_chd > 0 || t.price_adult > 0);
    const tot = zero();
    for (const m of meals) for (const k of Object.keys(tot)) tot[k] += m[k];
    return { restaurant: rest, meals, total: tot };
  });
  const grand = zero();
  for (const r of out) for (const k of Object.keys(grand)) grand[k] += r.total[k];
  const rnd = (o) => { for (const k of ['valor', 'valor_prev']) o[k] = Math.round(o[k] * 100) / 100; };
  for (const r of out) { rnd(r.total); r.meals.forEach((m) => { rnd(m); Object.values(m.days).forEach(rnd); }); }
  rnd(grand);
  return { from, to, days, restaurants: out, total: grand };
}

function weekRange(query) {
  let from = isISODate(query.from) ? query.from : null;
  if (!from) { const t = todayISO(); from = addDays(t, -((weekday(t) + 6) % 7)); } // segunda-feira desta semana
  let to = isISODate(query.to) ? query.to : addDays(from, 6);
  if (to < from) to = from;
  if (to > addDays(from, 62)) to = addDays(from, 62);
  return { from, to };
}

const WEEK_VIEW = ['admin', 'supervisor', 'refeicao'];
route('GET', '/api/control/week', { roles: WEEK_VIEW }, ({ query, user }) => {
  const { from, to } = weekRange(query);
  const restId = user.role === 'restaurante' ? user.restaurant_id : (Number(query.restaurant_id) || null);
  return weekly(from, to, restId);
});

route('GET', '/api/control/week.xlsx', { roles: WEEK_VIEW }, ({ query, user, ip }) => {
  const { from, to } = weekRange(query);
  const restId = user.role === 'restaurante' ? user.restaurant_id : (Number(query.restaurant_id) || null);
  const w = weekly(from, to, restId);
  const br = (iso) => iso.split('-').reverse().join('/');
  const H = (v) => ({ v, s: 3 });
  const n = (v) => ({ v: Math.round((Number(v) || 0) * 100) / 100, s: 5 });
  const rows = [[{ v: `APURAÇÃO SEMANAL · ${br(from)} a ${br(to)}`, s: 1 }], [],
    ['Restaurante', 'Refeição', 'Previsto ADT', 'Previsto CHD', 'Previsto total', 'Realizado ADT', 'Realizado CHD', 'Realizado total', 'Diferença pax', 'R$ ADT', 'R$ CHD', 'Valor previsto', 'Valor a pagar', 'Diferença R$', 'Refeições sem registro'].map(H)];
  for (const r of w.restaurants) {
    for (const m of r.meals) rows.push([r.restaurant.name, MEAL_LABEL[m.meal], n(m.prev_adt), n(m.prev_chd), n(m.prev_adt + m.prev_chd), n(m.pag_adt), n(m.pag_chd), n(m.pag_adt + m.pag_chd), n(m.pag_adt + m.pag_chd - m.prev_adt - m.prev_chd), n(m.price_adult), n(m.price_child), n(m.valor_prev), n(m.valor), n(m.valor - m.valor_prev), n(m.sem_real)]);
    const t = r.total;
    rows.push([{ v: `Total ${r.restaurant.name}`, s: 4 }, { v: '', s: 4 }, ...[t.prev_adt, t.prev_chd, t.prev_adt + t.prev_chd, t.pag_adt, t.pag_chd, t.pag_adt + t.pag_chd, t.pag_adt + t.pag_chd - t.prev_adt - t.prev_chd, '', '', t.valor_prev, t.valor, t.valor - t.valor_prev, t.sem_real].map((v) => ({ v: v === '' ? null : Math.round(v * 100) / 100, s: 4 }))]);
    rows.push([]);
  }
  const g = w.total;
  rows.push([{ v: 'TOTAL GERAL', s: 4 }, { v: '', s: 4 }, ...[g.prev_adt, g.prev_chd, g.prev_adt + g.prev_chd, g.pag_adt, g.pag_chd, g.pag_adt + g.pag_chd, g.pag_adt + g.pag_chd - g.prev_adt - g.prev_chd, '', '', g.valor_prev, g.valor, g.valor - g.valor_prev, g.sem_real].map((v) => ({ v: v === '' ? null : Math.round(v * 100) / 100, s: 4 }))]);
  // detalhe por dia
  rows.push([], [{ v: 'POR DIA (realizado: adultos / crianças)', s: 1 }], [H('Restaurante'), H('Refeição'), ...w.days.map((d) => H(br(d).slice(0, 5))), H('Total')]);
  for (const r of w.restaurants) for (const m of r.meals) {
    rows.push([r.restaurant.name, MEAL_LABEL[m.meal], ...w.days.map((d) => { const x = m.days[d]; return { v: x ? `${x.pag_adt} / ${x.pag_chd}` : '', s: 5 }; }), { v: `${m.pag_adt} / ${m.pag_chd}`, s: 4 }]);
  }
  audit(user, 'controle_semanal_exportado', { from, to }, ip);
  const buf = buildXlsx({ name: 'Controle', rows, merges: [], freeze: { row: 3, col: 2 }, cols: [24, 14, ...Array(16).fill(11)] });
  return { __raw: buf, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="apuracao-semanal_${from}_a_${to}.xlsx"` } };
});

module.exports = { billing, controlRows, controlRange, weekly };
