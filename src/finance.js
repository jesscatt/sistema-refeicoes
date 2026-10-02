'use strict';
/*
 * Controle financeiro dos restaurantes (substitui as planilhas mensais):
 *  - Controle do restaurante (planilha "CONTROLE DE DIVISÃO"): semanas de quarta a terça dentro do mês,
 *    por dia e refeição: previsão, adultos e crianças; totais da semana e do mês × preço; extras e vouchers.
 *  - Controle de faturamento (planilha "CONTROLE SEMANAL RESTAURANTES / PROJEÇÃO DO MÊS"): os três
 *    restaurantes no mês (realizado e projeção), extras, vouchers, outros pontos (Di Paolo, Botequim, Barril),
 *    total e total com o desconto (padrão 15%).
 * Fonte dos números: registros do sistema (marcações dos restaurantes); para meses anteriores ao sistema,
 * o histórico importado das planilhas.
 */
const { db, getSetting } = require('./db');
const { MEALS, monthRange, addDays, todayISO } = require('./util');
const { weekday } = require('./meals');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const WD = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function weekStart() { const n = parseInt(getSetting('finance_week_start', '3'), 10); return n >= 0 && n <= 6 ? n : 3; }
function deductionPct() { const n = Number(getSetting('finance_deduction_pct', '15')); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 15; }

// Semanas do mês: começam no dia 1 e em cada quarta-feira (configurável); a última termina no fim do mês
function weeksOfMonth(month) {
  const { first, last } = monthRange(month);
  const ws = weekStart();
  const weeks = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!weeks.length || weekday(d) === ws) weeks.push({ n: weeks.length + 1, from: d, to: d, days: [] });
    const w = weeks[weeks.length - 1];
    w.to = d; w.days.push(d);
  }
  return weeks;
}

// Preço vigente no mês (o mais recente com vigência <= mês)
function priceFor(restId, meal, month) {
  const p = db.prepare('SELECT * FROM price_history WHERE restaurant_id = ? AND meal = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1').get(restId, meal, month);
  return p ? { price_adult: p.price_adult, price_child: p.price_child, extra_adult: p.extra_adult, extra_child: p.extra_child, valid_from: p.valid_from }
    : { price_adult: 0, price_child: 0, extra_adult: 0, extra_child: 0, valid_from: null };
}

function restaurants(restId = null) {
  return db.prepare(`SELECT * FROM restaurants WHERE active = 1 ${restId ? 'AND id = ' + Number(restId) : ''} ORDER BY id`).all();
}

// Dados diários de um restaurante: previsão, realizado (sistema ou histórico), extras e vouchers
function dailyData(restId, from, to) {
  const map = new Map();
  const key = (d, m) => `${d}|${m}`;
  const get = (d, m) => {
    if (!map.has(key(d, m))) map.set(key(d, m), { date: d, meal: m, forecast: 0, adults: 0, children: 0, source: null, extra_adults: 0, extra_children: 0, voucher_adults: 0, voucher_children: 0, vouchers: 0, fora_lista: 0 });
    return map.get(key(d, m));
  };
  for (const r of db.prepare(`SELECT a.date, a.meal, SUM(r.adults + r.children) pax FROM assignments a JOIN reservations r ON r.id = a.reservation_id
      WHERE r.status = 'ativa' AND a.restaurant_id = ? AND a.date BETWEEN ? AND ? GROUP BY 1, 2`).all(restId, from, to)) get(r.date, r.meal).forecast = r.pax;
  const sys = new Set();
  for (const r of db.prepare(`SELECT date, meal, SUM(adults) ad, SUM(children) ch, SUM(status = 'fora_lista') fora FROM attendance
      WHERE restaurant_id = ? AND date BETWEEN ? AND ? GROUP BY 1, 2`).all(restId, from, to)) {
    Object.assign(get(r.date, r.meal), { adults: r.ad, children: r.ch, fora_lista: r.fora, source: 'sistema' });
    sys.add(key(r.date, r.meal));
  }
  for (const h of db.prepare('SELECT * FROM hist_daily WHERE restaurant_id = ? AND date BETWEEN ? AND ?').all(restId, from, to)) {
    const x = get(h.date, h.meal);
    if (!x.forecast && h.forecast) x.forecast = h.forecast;
    if (!sys.has(key(h.date, h.meal))) Object.assign(x, { adults: h.adults, children: h.children, source: 'planilha' });
  }
  for (const r of db.prepare('SELECT date, meal, SUM(adults) ad, SUM(children) ch FROM restaurant_extras WHERE restaurant_id = ? AND date BETWEEN ? AND ? GROUP BY 1, 2').all(restId, from, to)) {
    Object.assign(get(r.date, r.meal), { extra_adults: r.ad, extra_children: r.ch });
  }
  for (const r of db.prepare('SELECT date, meal, SUM(adults) ad, SUM(children) ch, SUM(adults + children) n FROM vouchers WHERE restaurant_id = ? AND date BETWEEN ? AND ? GROUP BY 1, 2').all(restId, from, to)) {
    Object.assign(get(r.date, r.meal), { voucher_adults: r.ad, voucher_children: r.ch, vouchers: r.n });
  }
  return map;
}

function mealsOf(rest, month) {
  return MEALS.filter((m) => rest[`share_${m}`] > 0 || priceFor(rest.id, m, month).price_adult > 0);
}

const zeroQty = () => ({ adults: 0, children: 0 });

// Controle do restaurante no mês (formato da planilha de divisão)
function restaurantMonth(restId, month) {
  const rest = restaurants(restId)[0];
  if (!rest) return null;
  const { first, last } = monthRange(month);
  const data = dailyData(rest.id, first, last);
  let meals = mealsOf(rest, month);
  for (const r of data.values()) if (!meals.includes(r.meal) && (r.adults + r.children + r.forecast > 0)) meals.push(r.meal);
  meals = MEALS.filter((m) => meals.includes(m));
  const prices = Object.fromEntries(meals.map((m) => [m, priceFor(rest.id, m, month)]));
  const value = (q, m) => r2(q.adults * prices[m].price_adult + q.children * prices[m].price_child);

  const weeks = weeksOfMonth(month).map((w) => {
    const days = w.days.map((d) => ({
      date: d, weekday: WD[weekday(d)],
      meals: meals.map((m) => data.get(`${d}|${m}`) || { date: d, meal: m, forecast: 0, adults: 0, children: 0, source: null, extra_adults: 0, extra_children: 0, voucher_adults: 0, voucher_children: 0, vouchers: 0 }),
    }));
    const tot = Object.fromEntries(meals.map((m) => [m, { forecast: 0, adults: 0, children: 0 }]));
    for (const d of days) for (const x of d.meals) { tot[x.meal].forecast += x.forecast; tot[x.meal].adults += x.adults; tot[x.meal].children += x.children; }
    const lines = meals.map((m) => ({ meal: m, ...tot[m], price_adult: prices[m].price_adult, price_child: prices[m].price_child,
      value_adults: r2(tot[m].adults * prices[m].price_adult), value_children: r2(tot[m].children * prices[m].price_child) }));
    return { n: w.n, from: w.from, to: w.to, days, lines, value: r2(lines.reduce((s, l) => s + l.value_adults + l.value_children, 0)) };
  });

  // Totais do mês. Mês sem nenhum registro do sistema e com fechamento importado: usa o número faturado da planilha.
  const sysCount = [...data.values()].filter((x) => x.source === 'sistema').length;
  const hist = db.prepare("SELECT * FROM hist_month WHERE month = ? AND restaurant_id = ? AND kind = 'realizado'").all(month, rest.id);
  const useHist = !sysCount && hist.length > 0;
  const month_lines = meals.map((m) => {
    let q = { forecast: 0, ...zeroQty() };
    for (const w of weeks) { const l = w.lines.find((x) => x.meal === m); q.forecast += l.forecast; q.adults += l.adults; q.children += l.children; }
    let pa = prices[m].price_adult, pc = prices[m].price_child, va = null, vc = null, note = null;
    if (useHist) {
      const h = hist.find((x) => x.meal === m);
      q = { forecast: q.forecast, adults: h ? h.adults : 0, children: h ? h.children : 0 };
      if (h && h.price_adult != null) { pa = h.price_adult; pc = h.price_child ?? pa / 2; }
      if (h) { va = h.value_adults; vc = h.value_children; note = h.price_note; }
    }
    return { meal: m, ...q, price_adult: pa, price_child: pc, price_note: note,
      value_adults: va != null ? r2(va) : r2(q.adults * pa), value_children: vc != null ? r2(vc) : r2(q.children * pc) };
  });
  // Extras: lançados no sistema (valor de extra) + extras importados das planilhas
  const ex = Object.fromEntries(meals.map((m) => [m, zeroQty()]));
  for (const x of data.values()) if (ex[x.meal]) { ex[x.meal].adults += x.extra_adults; ex[x.meal].children += x.extra_children; }
  const extras = meals.filter((m) => ex[m].adults + ex[m].children > 0).map((m) => ({
    meal: m, adults: ex[m].adults, children: ex[m].children, price_adult: prices[m].extra_adult, price_child: prices[m].extra_child,
    value: r2(ex[m].adults * prices[m].extra_adult + ex[m].children * prices[m].extra_child), source: 'sistema',
  }));
  for (const e of db.prepare("SELECT * FROM finance_entries WHERE month = ? AND restaurant_id = ? AND kind = 'extra' ORDER BY id").all(month, rest.id)) {
    extras.push({ id: e.id, meal: null, item: e.item, adults: e.qty || 0, children: 0, price_adult: e.unit_price, price_child: null, value: r2(e.value), source: e.source });
  }
  // Vouchers: cobrados pelo valor normal da refeição
  const vq = Object.fromEntries(meals.map((m) => [m, { ...zeroQty(), n: 0 }]));
  for (const x of data.values()) if (vq[x.meal]) { vq[x.meal].adults += x.voucher_adults; vq[x.meal].children += x.voucher_children; vq[x.meal].n += x.vouchers; }
  const vouchers = meals.filter((m) => vq[m].n > 0).map((m) => ({ meal: m, count: vq[m].n, adults: vq[m].adults, children: vq[m].children, value: value(vq[m], m) }));
  for (const e of db.prepare("SELECT * FROM finance_entries WHERE month = ? AND restaurant_id = ? AND kind = 'voucher' ORDER BY id").all(month, rest.id)) {
    vouchers.push({ id: e.id, meal: null, item: e.item, count: e.qty || 0, adults: e.qty || 0, children: 0, value: r2(e.value), source: e.source });
  }
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));
  const totals = {
    adults: sum(month_lines, (l) => l.value_adults),
    children: sum(month_lines, (l) => l.value_children),
    extras: sum(extras, (e) => e.value),
    vouchers: sum(vouchers, (v) => v.value),
  };
  totals.total = r2(totals.adults + totals.children + totals.extras + totals.vouchers);
  return {
    month, restaurant: { id: rest.id, code: rest.code, name: rest.name, color: rest.color, accepts_voucher: !!rest.accepts_voucher },
    meals, prices, weeks, month_lines, extras, vouchers, totals,
    source: useHist ? 'planilha' : sysCount ? 'sistema' : [...data.values()].some((x) => x.source === 'planilha') ? 'planilha' : 'sem_dados',
  };
}

// Projeção do mês para um restaurante: distribuição do sistema; sem ela, a projeção importada da planilha
function projection(rest, month, meals, prices) {
  const { first, last } = monthRange(month);
  const rows = db.prepare(`SELECT a.meal, SUM(r.adults) ad, SUM(r.children) ch FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE r.status = 'ativa' AND a.restaurant_id = ? AND a.date BETWEEN ? AND ? GROUP BY 1`).all(rest.id, first, last);
  const hist = db.prepare("SELECT * FROM hist_month WHERE month = ? AND restaurant_id = ? AND kind = 'projecao'").all(month, rest.id);
  // a projeção importada (planilha) vale para o mês dela; meses sem planilha usam a distribuição do sistema
  const fromSys = !hist.length && rows.some((x) => x.ad + x.ch > 0);
  return {
    source: fromSys ? 'sistema' : hist.length ? 'planilha' : 'sem_dados',
    lines: meals.map((m) => {
      const s = rows.find((x) => x.meal === m), h = hist.find((x) => x.meal === m);
      const q = fromSys ? { adults: s ? s.ad : 0, children: s ? s.ch : 0 } : { adults: h ? h.adults : 0, children: h ? h.children : 0 };
      const pa = !fromSys && h && h.price_adult != null ? h.price_adult : prices[m].price_adult;
      const pc = !fromSys && h && h.price_child != null ? h.price_child : prices[m].price_child;
      const va = !fromSys && h && h.value_adults != null ? h.value_adults : q.adults * pa;
      const vc = !fromSys && h && h.value_children != null ? h.value_children : q.children * pc;
      return { meal: m, ...q, price_adult: pa, price_child: pc, price_note: !fromSys && h ? h.price_note : null, value_adults: r2(va), value_children: r2(vc) };
    }),
  };
}

// Controle de faturamento do mês (os três restaurantes + outros pontos)
function consolidated(month) {
  const out = restaurants().map((rest) => {
    const rm = restaurantMonth(rest.id, month);
    const proj = projection(rest, month, rm.meals, rm.prices);
    const pt = r2(proj.lines.reduce((s, l) => s + l.value_adults + l.value_children, 0));
    return {
      restaurant: rm.restaurant, meals: rm.meals, source: rm.source,
      realizado: rm.month_lines, extras: rm.extras, vouchers: rm.vouchers, totals: rm.totals,
      projecao: { ...proj, total: r2(pt + rm.totals.extras + rm.totals.vouchers) },
    };
  });
  const others = db.prepare("SELECT * FROM finance_entries WHERE month = ? AND kind = 'outro' ORDER BY outlet, id").all(month)
    .map((e) => ({ id: e.id, outlet: e.outlet, item: e.item, unit_price: e.unit_price, qty: e.qty, value: r2(e.value), source: e.source }));
  const othersTotal = r2(others.reduce((s, e) => s + e.value, 0));
  const pct = deductionPct();
  const total = r2(out.reduce((s, r) => s + r.totals.total, 0) + othersTotal);
  const ptotal = r2(out.reduce((s, r) => s + r.projecao.total, 0) + othersTotal);
  return {
    month, restaurants: out, others, others_total: othersTotal, deduction_pct: pct,
    total, total_net: r2(total * (1 - pct / 100)),
    projection_total: ptotal, projection_net: r2(ptotal * (1 - pct / 100)),
  };
}

// Meses com algum dado (sistema ou histórico), mais recente primeiro
function months() {
  const set = new Set([todayISO().slice(0, 7)]);
  const add = (sql) => { for (const r of db.prepare(sql).all()) if (r.m) set.add(r.m); };
  add('SELECT DISTINCT month m FROM hist_month');
  add('SELECT DISTINCT substr(date, 1, 7) m FROM hist_daily');
  add('SELECT DISTINCT substr(date, 1, 7) m FROM attendance');
  add('SELECT DISTINCT month m FROM finance_entries');
  add('SELECT DISTINCT substr(date, 1, 7) m FROM assignments');
  return [...set].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort().reverse();
}

module.exports = { weeksOfMonth, priceFor, restaurantMonth, consolidated, months, deductionPct, weekStart, dailyData, r2 };
