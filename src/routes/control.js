'use strict';
// Planilha de controle unificada (previsão x marcado x real) e faturamento.
const { route, HttpError } = require('../http');
const { db, audit } = require('../db');
const { MEALS, MEAL_LABEL, monthRange, isISODate, toCSV, todayISO, nowLocal } = require('../util');

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
  for (const r of db.prepare(`SELECT * FROM control_real WHERE date BETWEEN ? AND ? ${rf2}`).all(first, last)) {
    Object.assign(get(r.date, r.meal, r.restaurant_id), { real_adults: r.real_adults, real_children: r.real_children, notes: r.notes });
  }
  for (const r of db.prepare(`SELECT date, meal, restaurant_id, SUM(adults) ad, SUM(children) ch FROM walkins WHERE date BETWEEN ? AND ? ${rf2} GROUP BY 1,2,3`).all(first, last)) {
    Object.assign(get(r.date, r.meal, r.restaurant_id), { walkin_adults: r.ad, walkin_children: r.ch });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || a.restaurant_id - b.restaurant_id);
}

// Base de cálculo: valor real informado pelo restaurante; se não houver, o que foi marcado no sistema
function billedPax(row) {
  const hasReal = row.real_adults !== null || row.real_children !== null;
  return hasReal ? { adults: row.real_adults || 0, children: row.real_children || 0, basis: 'real' } : { adults: row.checked_adults, children: row.checked_children, basis: 'marcado' };
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
        if (b.basis !== 'real' && (r.forecast_adults + r.forecast_children + r.checked_adults + r.checked_children) > 0) t.days_without_real++;
      }
      t.value = +(t.billed_adults * t.price_adult + t.billed_children * t.price_child).toFixed(2);
      out.push(t);
    }
  }
  const total = out.reduce((s, t) => s + t.value, 0);
  return { month, lines: out, total: +total.toFixed(2) };
}

route('GET', '/api/control', { roles: ['admin', 'supervisor', 'refeicao', 'restaurante'] }, ({ query, user }) => {
  const month = checkMonth(query.month);
  const restId = user.role === 'restaurante' ? user.restaurant_id : (Number(query.restaurant_id) || null);
  return { month, restaurant_id: restId, closed: closure(month), rows: controlRows(month, restId) };
});

route('PUT', '/api/control', { roles: ['admin', 'refeicao', 'restaurante'] }, ({ body, user, ip }) => {
  if (!isISODate(body.date) || !MEALS.includes(body.meal)) throw new HttpError(400, 'Data ou refeição inválida.');
  const restId = user.role === 'restaurante' ? user.restaurant_id : Number(body.restaurant_id);
  if (!restId) throw new HttpError(400, 'Informe o restaurante.');
  if (closure(body.date.slice(0, 7))) throw new HttpError(409, 'Este mês já foi fechado pela supervisão. Peça a reabertura ao administrador.');
  const num = (v) => (v === '' || v === null || v === undefined ? null : Math.max(0, parseInt(v, 10) || 0));
  const ra = num(body.real_adults), rc = num(body.real_children);
  const old = db.prepare('SELECT * FROM control_real WHERE date = ? AND restaurant_id = ? AND meal = ?').get(body.date, restId, body.meal);
  db.prepare(`INSERT INTO control_real(date, restaurant_id, meal, real_adults, real_children, notes, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(date, restaurant_id, meal) DO UPDATE SET real_adults = excluded.real_adults, real_children = excluded.real_children,
    notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(body.date, restId, body.meal, ra, rc, body.notes || null, user.id, nowLocal());
  audit(user, 'controle_real_alterado', { date: body.date, meal: body.meal, restaurante: restId, de: old ? [old.real_adults, old.real_children] : null, para: [ra, rc] }, ip);
  return { ok: true };
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
  const rows = b.lines.map((t) => [t.restaurant.name, MEAL_LABEL[t.meal], t.forecast_adults, t.forecast_children, t.checked_adults, t.checked_children,
    t.real_adults, t.real_children, t.billed_adults, t.billed_children, t.price_adult, t.price_child, t.value, t.walkin_adults, t.walkin_children]);
  rows.push(['TOTAL', '', '', '', '', '', '', '', '', '', '', '', b.total, '', '']);
  rows.push([c ? `Fechado em ${c.closed_at}` : 'Prévia (mês não fechado)']);
  return {
    __raw: toCSV(['Restaurante', 'Refeição', 'Previsto ADT', 'Previsto CHD', 'Marcado ADT', 'Marcado CHD', 'Real ADT', 'Real CHD', 'Faturado ADT', 'Faturado CHD', 'Valor ADT', 'Valor CHD', 'Total R$', 'Avulsos ADT', 'Avulsos CHD'], rows),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="faturamento-${month}.csv"` },
  };
});

route('GET', '/api/reports/daily.csv', { roles: BILL_CLOSE }, ({ query, user, ip }) => {
  const month = checkMonth(query.month);
  const rests = Object.fromEntries(db.prepare('SELECT id, name FROM restaurants').all().map((r) => [r.id, r.name]));
  audit(user, 'relatorio_diario_exportado', { month }, ip);
  return {
    __raw: toCSV(['Data', 'Refeição', 'Restaurante', 'Previsto ADT', 'Previsto CHD', 'Marcado ADT', 'Marcado CHD', 'Fora da lista', 'Real ADT', 'Real CHD', 'Diferença (real - previsto)', 'Avulsos', 'Observação'],
      controlRows(month).map((r) => {
        const real = r.real_adults === null && r.real_children === null ? null : (r.real_adults || 0) + (r.real_children || 0);
        return [r.date.split('-').reverse().join('/'), MEAL_LABEL[r.meal], rests[r.restaurant_id], r.forecast_adults, r.forecast_children, r.checked_adults, r.checked_children, r.fora_lista,
          r.real_adults ?? '', r.real_children ?? '', real === null ? '' : real - r.forecast_adults - r.forecast_children, r.walkin_adults + r.walkin_children, r.notes || ''];
      })),
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

module.exports = { billing, controlRows };
