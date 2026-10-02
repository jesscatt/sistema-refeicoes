'use strict';
// Controle financeiro: controle de faturamento (supervisão / setor de refeições), controle de cada restaurante
// (inclusive para o administrador do restaurante), preços por mês, extras, vouchers, outros lançamentos e histórico.
const { route, HttpError } = require('../http');
const { db, audit, setSetting, notify } = require('../db');
const { MEALS, MEAL_LABEL, isISODate, todayISO, monthRange } = require('../util');
const { buildWorkbook, colName } = require('../xlsx-write');
const fin = require('../finance');
const { parseFile, commitFile } = require('../finance-import');

const FIN_VIEW = ['admin', 'supervisor', 'refeicao'];
const FIN_EDIT = ['admin', 'supervisor', 'refeicao'];
const PRICE_EDIT = ['admin', 'supervisor'];
const REG = ['admin', 'refeicao', 'restaurante']; // quem lança extras e vouchers

const MONTH_NAMES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const monthLabel = (m) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const checkMonth = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? m : todayISO().slice(0, 7));
const MEAL_ROW = { cafe: 'Café', almoco: 'Almoço', janta: 'Jantar' };
const MEAL_QTD = { cafe: 'QUANTIDADE CAFÉ DA MANHÃ', almoco: 'QUANTIDADE ALMOÇO', janta: 'QUANTIDADE JANTAR' };

// Restaurante que o usuário pode ver: restaurante (só o administrador do restaurante) vê apenas o seu
function finRestaurant(user, requested) {
  if (user.role === 'restaurante') {
    if (!user.rest_admin) throw new HttpError(403, 'Somente o administrador do restaurante vê os valores.');
    return user.restaurant_id;
  }
  if (!FIN_VIEW.includes(user.role)) throw new HttpError(403, 'Sem permissão.');
  const id = Number(requested) || (db.prepare('SELECT id FROM restaurants WHERE active = 1 ORDER BY id').get() || {}).id;
  if (!id) throw new HttpError(400, 'Informe o restaurante.');
  return id;
}
const regRestaurant = (user, requested) => {
  if (user.role === 'restaurante') return user.restaurant_id;
  const id = Number(requested);
  if (!id) throw new HttpError(400, 'Informe o restaurante.');
  return id;
};

route('GET', '/api/finance/months', { roles: [...FIN_VIEW, 'restaurante'] }, ({ user }) => {
  if (user.role === 'restaurante' && !user.rest_admin) throw new HttpError(403, 'Sem permissão.');
  return { months: fin.months(), deduction_pct: fin.deductionPct(), week_start: fin.weekStart() };
});

route('GET', '/api/finance/consolidated', { roles: FIN_VIEW }, ({ query }) => fin.consolidated(checkMonth(query.month)));

route('GET', '/api/finance/restaurant', { roles: [...FIN_VIEW, 'restaurante'] }, ({ query, user }) => {
  const r = fin.restaurantMonth(finRestaurant(user, query.restaurant_id), checkMonth(query.month));
  if (!r) throw new HttpError(404, 'Restaurante não encontrado.');
  return r;
});

// ---------- Outros lançamentos (Di Paolo, Botequim, Barril, ajustes) ----------
route('POST', '/api/finance/entries', { roles: FIN_EDIT }, ({ body, user, ip }) => {
  const month = checkMonth(body.month);
  const kind = ['outro', 'extra', 'voucher'].includes(body.kind) ? body.kind : 'outro';
  const outlet = String(body.outlet || '').trim().slice(0, 80);
  if (!outlet) throw new HttpError(400, 'Informe o ponto de venda / descrição (ex.: Di Paolo).');
  const unit = body.unit_price === '' || body.unit_price == null ? null : Number(body.unit_price);
  const qty = body.qty === '' || body.qty == null ? null : Number(body.qty);
  let value = body.value === '' || body.value == null ? null : Number(body.value);
  if (value == null && unit != null && qty != null) value = Math.round(unit * qty * 100) / 100;
  if (value == null || !Number.isFinite(value)) throw new HttpError(400, 'Informe valor unitário e quantidade, ou o valor total.');
  const restId = kind === 'outro' ? (Number(body.restaurant_id) || null) : Number(body.restaurant_id);
  if (kind !== 'outro' && !restId) throw new HttpError(400, 'Informe o restaurante.');
  const r = db.prepare('INSERT INTO finance_entries(month, restaurant_id, kind, outlet, item, unit_price, qty, value, source, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(month, restId, kind, outlet, String(body.item || '').trim().slice(0, 120), unit, qty, value, 'manual', user.id);
  audit(user, 'lancamento_financeiro', { month, kind, outlet, value }, ip);
  return { id: Number(r.lastInsertRowid) };
});

route('DELETE', '/api/finance/entries/:id', { roles: FIN_EDIT }, ({ params, user, ip }) => {
  const e = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(params.id);
  if (!e) throw new HttpError(404, 'Lançamento não encontrado.');
  db.prepare('DELETE FROM finance_entries WHERE id = ?').run(e.id);
  audit(user, 'lancamento_financeiro_removido', { month: e.month, outlet: e.outlet, value: e.value }, ip);
  return { ok: true };
});

// ---------- Preços por mês ----------
route('GET', '/api/finance/prices', { roles: [...FIN_VIEW, 'restaurante'] }, ({ query, user }) => {
  const month = checkMonth(query.month);
  const rests = user.role === 'restaurante' ? [db.prepare('SELECT * FROM restaurants WHERE id = ?').get(finRestaurant(user))] : db.prepare('SELECT * FROM restaurants WHERE active = 1 ORDER BY id').all();
  return {
    month,
    current: rests.map((r) => ({ id: r.id, name: r.name, code: r.code, accepts_voucher: !!r.accepts_voucher, meals: Object.fromEntries(MEALS.map((m) => [m, fin.priceFor(r.id, m, month)])) })),
    history: db.prepare(`SELECT p.*, r.name restaurant_name FROM price_history p JOIN restaurants r ON r.id = p.restaurant_id ${user.role === 'restaurante' ? 'WHERE p.restaurant_id = ' + Number(user.restaurant_id) : ''} ORDER BY p.valid_from DESC, r.id, p.meal`).all(),
  };
});

route('PUT', '/api/finance/prices', { roles: PRICE_EDIT }, ({ body, user, ip }) => {
  const from = checkMonth(body.valid_from);
  const up = db.prepare(`INSERT INTO price_history(restaurant_id, meal, valid_from, price_adult, price_child, extra_adult, extra_child, updated_by) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(restaurant_id, meal, valid_from) DO UPDATE SET price_adult = excluded.price_adult, price_child = excluded.price_child, extra_adult = excluded.extra_adult, extra_child = excluded.extra_child, updated_by = excluded.updated_by, updated_at = datetime('now','localtime')`);
  const n = (v) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
  for (const p of body.prices || []) {
    if (!MEALS.includes(p.meal) || !Number(p.restaurant_id)) continue;
    up.run(Number(p.restaurant_id), p.meal, from, n(p.price_adult), p.price_child === '' || p.price_child == null ? n(p.price_adult) / 2 : n(p.price_child), n(p.extra_adult), p.extra_child === '' || p.extra_child == null ? n(p.extra_adult) / 2 : n(p.extra_child), user.id);
  }
  if (body.vouchers) for (const v of body.vouchers) db.prepare('UPDATE restaurants SET accepts_voucher = ? WHERE id = ?').run(v.accepts ? 1 : 0, Number(v.restaurant_id));
  audit(user, 'precos_alterados', { valid_from: from, prices: body.prices }, ip);
  return { ok: true };
});

route('PUT', '/api/finance/settings', { roles: PRICE_EDIT }, ({ body, user, ip }) => {
  if (body.deduction_pct !== undefined) {
    const p = Number(body.deduction_pct);
    if (!(p >= 0 && p <= 100)) throw new HttpError(400, 'Desconto entre 0 e 100%.');
    setSetting('finance_deduction_pct', p);
  }
  if (body.week_start !== undefined) {
    const w = parseInt(body.week_start, 10);
    if (!(w >= 0 && w <= 6)) throw new HttpError(400, 'Dia de início da semana inválido.');
    setSetting('finance_week_start', w);
  }
  audit(user, 'financeiro_configurado', body, ip);
  return { ok: true };
});

// ---------- Extras e vouchers (lançados na marcação do restaurante) ----------
function regList(table, restId, date, meal) {
  return db.prepare(`SELECT x.*, u.name user_name FROM ${table} x LEFT JOIN users u ON u.id = x.user_id WHERE x.restaurant_id = ? AND x.date = ? AND x.meal = ? ORDER BY x.id DESC`).all(restId, date, meal);
}
const dm = (b) => {
  const date = isISODate(b.date) ? b.date : todayISO();
  const meal = MEALS.includes(b.meal) ? b.meal : null;
  if (!meal) throw new HttpError(400, 'Informe a refeição.');
  return { date, meal };
};
const pax = (b) => {
  const adults = Math.max(0, parseInt(b.adults, 10) || 0), children = Math.max(0, parseInt(b.children, 10) || 0);
  if (adults + children === 0) throw new HttpError(400, 'Informe a quantidade de pessoas.');
  if (adults + children > 500) throw new HttpError(400, 'Quantidade muito alta; confira.');
  return { adults, children };
};

route('GET', '/api/extras', { roles: REG }, ({ query, user }) => {
  const restId = regRestaurant(user, query.restaurant_id);
  const { date, meal } = dm(query);
  return { extras: regList('restaurant_extras', restId, date, meal), vouchers: regList('vouchers', restId, date, meal), price: fin.priceFor(restId, meal, date.slice(0, 7)) };
});

route('POST', '/api/extras', { roles: REG }, ({ body, user, ip }) => {
  const restId = regRestaurant(user, body.restaurant_id);
  const { date, meal } = dm(body);
  const p = pax(body);
  const note = String(body.note || '').trim().slice(0, 200);
  if (note.length < 3) throw new HttpError(400, 'Descreva o extra (ex.: grupo do evento, mesa, quem autorizou).');
  const r = db.prepare('INSERT INTO restaurant_extras(date, meal, restaurant_id, adults, children, note, user_id) VALUES (?,?,?,?,?,?,?)').run(date, meal, restId, p.adults, p.children, note, user.id);
  audit(user, 'extra_lancado', { date, meal, restaurant_id: restId, ...p, note }, ip);
  return { id: Number(r.lastInsertRowid) };
});

route('DELETE', '/api/extras/:id', { roles: REG }, ({ params, user, ip }) => {
  const x = db.prepare('SELECT * FROM restaurant_extras WHERE id = ?').get(params.id);
  if (!x) throw new HttpError(404, 'Extra não encontrado.');
  if (user.role === 'restaurante' && x.restaurant_id !== user.restaurant_id) throw new HttpError(403, 'Sem permissão.');
  db.prepare('DELETE FROM restaurant_extras WHERE id = ?').run(x.id);
  audit(user, 'extra_removido', x, ip);
  return { ok: true };
});

route('POST', '/api/vouchers', { roles: REG }, ({ body, user, ip }) => {
  const restId = regRestaurant(user, body.restaurant_id);
  const rest = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restId);
  if (!rest || !rest.accepts_voucher) throw new HttpError(400, `${rest ? rest.name : 'Este restaurante'} não recebe voucher.`);
  const { date, meal } = dm(body);
  const p = pax(body);
  const code = String(body.code || '').trim().replace(/\s+/g, '').toUpperCase().slice(0, 40);
  if (code.length < 2) throw new HttpError(400, 'Informe o número do voucher.');
  const dup = db.prepare('SELECT date, meal FROM vouchers WHERE restaurant_id = ? AND upper(code) = ?').get(restId, code);
  if (dup) throw new HttpError(409, `O voucher ${code} já foi recebido em ${dup.date.split('-').reverse().join('/')} (${MEAL_LABEL[dup.meal]}).`);
  const r = db.prepare('INSERT INTO vouchers(date, meal, restaurant_id, code, adults, children, note, user_id) VALUES (?,?,?,?,?,?,?,?)').run(date, meal, restId, code, p.adults, p.children, String(body.note || '').trim().slice(0, 200) || null, user.id);
  audit(user, 'voucher_recebido', { date, meal, restaurant_id: restId, code, ...p }, ip);
  return { id: Number(r.lastInsertRowid) };
});

route('DELETE', '/api/vouchers/:id', { roles: REG }, ({ params, user, ip }) => {
  const x = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(params.id);
  if (!x) throw new HttpError(404, 'Voucher não encontrado.');
  if (user.role === 'restaurante' && x.restaurant_id !== user.restaurant_id) throw new HttpError(403, 'Sem permissão.');
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(x.id);
  audit(user, 'voucher_removido', x, ip);
  return { ok: true };
});

// Lista de vouchers do mês (controle)
route('GET', '/api/vouchers', { roles: [...FIN_VIEW, 'restaurante'] }, ({ query, user }) => {
  const restId = finRestaurant(user, query.restaurant_id);
  const { first, last } = monthRange(checkMonth(query.month));
  return db.prepare('SELECT v.*, u.name user_name FROM vouchers v LEFT JOIN users u ON u.id = v.user_id WHERE v.restaurant_id = ? AND v.date BETWEEN ? AND ? ORDER BY v.date, v.meal, v.id').all(restId, first, last);
});

// ---------- Importação do histórico (planilhas antigas) ----------
route('POST', '/api/finance/import', { roles: FIN_EDIT, raw: 25 * 1024 * 1024 }, ({ body, req, user, ip }) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  const commit = req.headers['x-commit'] === '1';
  let parsed;
  try { parsed = parseFile(body, filename, { restaurant_id: req.headers['x-restaurant'] }); } catch (e) { throw new HttpError(400, e.message); }
  const rests = Object.fromEntries(db.prepare('SELECT id, name FROM restaurants').all().map((r) => [r.id, r.name]));
  const summary = parsed.months.map((m) => {
    if (parsed.type === 'controle') {
      const real = m.lines.filter((l) => l.kind === 'realizado');
      const proj = m.lines.filter((l) => l.kind === 'projecao');
      const v = real.reduce((s, l) => s + l.value, 0) + m.entries.reduce((s, e) => s + e.value, 0);
      return { month: m.month, sheet: m.sheet, realizado_pax: real.reduce((s, l) => s + l.qty, 0), projecao_pax: proj.reduce((s, l) => s + l.qty, 0), entries: m.entries.length, total: Math.round(v * 100) / 100 };
    }
    return { month: m.month, sheet: m.sheet, days: new Set(m.days.map((d) => d.date)).size, pax: m.days.reduce((s, d) => s + d.adults + d.children, 0), extras: m.extras.length };
  });
  const out = { type: parsed.type, restaurant: parsed.restaurant_id ? rests[parsed.restaurant_id] : null, months: summary, warnings: parsed.warnings };
  if (!commit) return out;
  const res = commitFile(parsed, user);
  audit(user, 'historico_importado', { arquivo: filename, tipo: parsed.type, meses: res.months, ...res, months: undefined }, ip);
  notify({ role: 'supervisor', kind: 'finance', title: 'Histórico financeiro importado', body: `${filename}: ${res.months.length} mês(es)`, link: '#/financeiro' });
  return { ...out, saved: res };
});

// ---------- Exportação nos formatos das planilhas ----------
const S = { title: 1, head: 2, col: 3, tot: 4, num: 5, money: 7, moneyTot: 8 };
const money = (v) => ({ v: Math.round((Number(v) || 0) * 100) / 100, s: S.money });

// Aba do controle de faturamento (um mês)
function consolidatedSheet(month) {
  const c = fin.consolidated(month);
  const rows = [], merges = [];
  const put = (r, col, v) => { while (rows.length <= r) rows.push([]); rows[r][col] = v; };
  put(0, 0, { v: `VALOR FATURADO · ${monthLabel(month)}`, s: S.title }); merges.push('A1:H1');
  let r = 2;
  const block = (title, pick) => {
    put(r, 0, { v: title, s: S.col }); r++;
    const start = r;
    let maxRR = start;
    c.restaurants.forEach((R, i) => {
      const col = i * 3;
      let rr = start;
      put(rr, col, { v: R.restaurant.name.toUpperCase(), s: S.head }); put(rr, col + 1, { v: '', s: S.head }); rr++;
      for (const who of ['adults', 'children']) {
        put(rr, col, { v: who === 'adults' ? 'Adultos' : 'Crianças', s: S.col }); put(rr, col + 1, { v: 'TOTAL', s: S.col }); rr++;
        const cells = [];
        let sum = 0;
        for (const l of pick(R)) {
          put(rr, col, MEAL_QTD[l.meal]); rr++;
          const q = who === 'adults' ? l.adults : l.children, p = who === 'adults' ? l.price_adult : l.price_child;
          const val = who === 'adults' ? l.value_adults : l.value_children;
          const ref = `${colName(col + 0)}${rr + 1}`;
          put(rr, col, { v: q, s: S.num });
          put(rr, col + 1, Math.abs(q * p - val) < 0.01 ? { f: `${ref}*${p}`, v: val, s: S.money } : money(val));
          cells.push(`${colName(col + 1)}${rr + 1}`); sum += val; rr++;
        }
        put(rr, col, { v: who === 'adults' ? 'TOTAL ADULTOS' : 'TOTAL CRIANÇAS', s: S.tot });
        put(rr, col + 1, { f: cells.length ? cells.join('+') : '0', v: Math.round(sum * 100) / 100, s: S.moneyTot }); rr += 2;
      }
      maxRR = Math.max(maxRR, rr);
    });
    r = maxRR + 1;
  };
  block('REALIZADO (registros dos restaurantes)', (R) => R.realizado);
  // extras, vouchers e outros
  put(r, 0, { v: 'EXTRAS, VOUCHERS E OUTROS PONTOS', s: S.col }); r++;
  ['Restaurante / ponto', 'Descrição', 'Valor unitário', 'Quant.', 'Total'].forEach((h, i) => put(r, i, { v: h, s: S.col })); r++;
  const extraStart = r;
  for (const R of c.restaurants) {
    for (const e of R.extras) { put(r, 0, `${R.restaurant.name} · extra`); put(r, 1, e.meal ? MEAL_ROW[e.meal] : e.item); put(r, 2, e.price_adult != null ? money(e.price_adult) : ''); put(r, 3, e.meal ? `${e.adults} adt${e.children ? ` + ${e.children} chd` : ''}` : (e.adults || '')); put(r, 4, money(e.value)); r++; }
    for (const v of R.vouchers) { put(r, 0, `${R.restaurant.name} · vouchers`); put(r, 1, v.meal ? MEAL_ROW[v.meal] : v.item); put(r, 3, v.count); put(r, 4, money(v.value)); r++; }
  }
  for (const o of c.others) { put(r, 0, o.outlet); put(r, 1, o.item); put(r, 2, o.unit_price != null ? money(o.unit_price) : ''); put(r, 3, o.qty ?? ''); put(r, 4, money(o.value)); r++; }
  if (r === extraStart) { put(r, 0, 'Nenhum lançamento'); r++; }
  r++;
  put(r, 0, { v: 'RESUMO', s: S.col }); r++;
  for (const R of c.restaurants) { put(r, 0, R.restaurant.name); put(r, 4, money(R.totals.total)); r++; }
  put(r, 0, 'Outros pontos'); put(r, 4, money(c.others_total)); r++;
  put(r, 0, { v: 'TOTAL', s: S.tot }); put(r, 4, { v: c.total, s: S.moneyTot }); r++;
  put(r, 0, { v: `TOTAL -${c.deduction_pct}%`, s: S.tot }); put(r, 4, { v: c.total_net, s: S.moneyTot }); r += 2;
  block(`PROJEÇÃO ${monthLabel(month)}`, (R) => R.projecao.lines);
  put(r, 0, { v: 'TOTAL PROJEÇÃO', s: S.tot }); put(r, 4, { v: c.projection_total, s: S.moneyTot }); r++;
  put(r, 0, { v: `PROJEÇÃO -${c.deduction_pct}%`, s: S.tot }); put(r, 4, { v: c.projection_net, s: S.moneyTot });
  return { name: monthLabel(month), rows, merges, cols: [30, 16, 4, 30, 16, 4, 30, 16], freeze: null };
}

// Aba do controle de divisão de um restaurante (um mês): semanas lado a lado
function restaurantSheet(restId, month) {
  const d = fin.restaurantMonth(restId, month);
  const rows = [], merges = [];
  const put = (r, col, v) => { while (rows.length <= r) rows.push([]); rows[r][col] = v; };
  const W = 6; // colunas por semana (5 + espaço)
  let maxRow = 2;
  d.weeks.forEach((w, i) => {
    const c0 = i * W, L = (k) => colName(c0 + k);
    put(0, c0, { v: `SEMANA ${w.n} · ${w.from.slice(8)}/${w.from.slice(5, 7)} a ${w.to.slice(8)}/${w.to.slice(5, 7)}`, s: S.head });
    for (let k = 1; k < 5; k++) put(0, c0 + k, { v: '', s: S.head });
    merges.push(`${L(0)}1:${L(4)}1`);
    ['DATA', 'REFEIÇÃO', 'PREVISÃO', 'ADULTOS', 'CRIANÇAS'].forEach((h, k) => put(1, c0 + k, { v: h, s: S.col }));
    let r = 2;
    for (const day of w.days) {
      const r0 = r;
      for (const x of day.meals) {
        put(r, c0, r === r0 ? `${day.date.split('-').reverse().join('/')} - ${day.weekday}` : '');
        put(r, c0 + 1, MEAL_ROW[x.meal]);
        put(r, c0 + 2, x.forecast ? { v: x.forecast, s: S.num } : '');
        put(r, c0 + 3, x.adults || x.children || x.source ? { v: x.adults, s: S.num } : '');
        put(r, c0 + 4, x.adults || x.children || x.source ? { v: x.children, s: S.num } : '');
        r++;
      }
      if (day.meals.length > 1) merges.push(`${L(0)}${r0 + 1}:${L(0)}${r}`);
    }
    maxRow = Math.max(maxRow, r);
  });
  // totais por semana
  let r = maxRow + 1;
  d.weeks.forEach((w, i) => {
    const c0 = i * W;
    let rr = r;
    for (const who of ['adults', 'children']) {
      put(rr, c0, { v: `Semana ${w.n}${who === 'children' ? ' · CRIANÇAS' : ''}`, s: S.head }); for (let k = 1; k < 4; k++) put(rr, c0 + k, { v: '', s: S.head }); rr++;
      ['Refeição', 'Valor unitário', 'Quantidade', 'Total'].forEach((h, k) => put(rr, c0 + k, { v: h, s: S.col })); rr++;
      const first = rr;
      for (const l of w.lines) {
        const q = who === 'adults' ? l.adults : l.children, p = who === 'adults' ? l.price_adult : l.price_child;
        put(rr, c0, MEAL_ROW[l.meal]); put(rr, c0 + 1, money(p)); put(rr, c0 + 2, { v: q, s: S.num });
        put(rr, c0 + 3, { f: `${colName(c0 + 1)}${rr + 1}*${colName(c0 + 2)}${rr + 1}`, v: q * p, s: S.money }); rr++;
      }
      put(rr, c0, { v: 'Total', s: S.tot }); put(rr, c0 + 2, { f: `SUM(${colName(c0 + 2)}${first + 1}:${colName(c0 + 2)}${rr})`, v: 0, s: S.tot });
      put(rr, c0 + 3, { f: `SUM(${colName(c0 + 3)}${first + 1}:${colName(c0 + 3)}${rr})`, v: 0, s: S.moneyTot }); rr += 2;
    }
  });
  r += 2 * (d.meals.length + 4) + 1;
  // total do mês
  for (const who of ['adults', 'children']) {
    put(r, 0, { v: `Informações total mês${who === 'children' ? ' - CRIANÇAS' : ''}`, s: S.head }); for (let k = 1; k < 4; k++) put(r, k, { v: '', s: S.head }); r++;
    ['Refeição', 'Valor unitário', 'Quantidade', 'Total'].forEach((h, k) => put(r, k, { v: h, s: S.col })); r++;
    for (const l of d.month_lines) {
      const q = who === 'adults' ? l.adults : l.children, p = who === 'adults' ? l.price_adult : l.price_child;
      put(r, 0, MEAL_ROW[l.meal] + (l.price_note ? ` (${l.price_note})` : '')); put(r, 1, money(p)); put(r, 2, { v: q, s: S.num }); put(r, 3, money(who === 'adults' ? l.value_adults : l.value_children)); r++;
    }
    put(r, 0, { v: 'Total', s: S.tot }); put(r, 3, { v: who === 'adults' ? d.totals.adults : d.totals.children, s: S.moneyTot }); r += 2;
  }
  put(r, 0, { v: `EXTRAS ${d.restaurant.name.toUpperCase()}`, s: S.head }); for (let k = 1; k < 4; k++) put(r, k, { v: '', s: S.head }); r++;
  ['Refeição', 'Valor unitário', 'Quantidade', 'Total'].forEach((h, k) => put(r, k, { v: h, s: S.col })); r++;
  for (const e of d.extras) { put(r, 0, e.meal ? MEAL_ROW[e.meal] : e.item); put(r, 1, e.price_adult != null ? money(e.price_adult) : ''); put(r, 2, e.meal ? e.adults + e.children : (e.adults || '')); put(r, 3, money(e.value)); r++; }
  put(r, 0, { v: 'Total', s: S.tot }); put(r, 3, { v: d.totals.extras, s: S.moneyTot }); r += 2;
  if (d.restaurant.accepts_voucher || d.vouchers.length) {
    put(r, 0, { v: 'VOUCHERS RECEBIDOS', s: S.head }); for (let k = 1; k < 4; k++) put(r, k, { v: '', s: S.head }); r++;
    ['Refeição', 'Vouchers', 'Pessoas', 'Total'].forEach((h, k) => put(r, k, { v: h, s: S.col })); r++;
    for (const v of d.vouchers) { put(r, 0, v.meal ? MEAL_ROW[v.meal] : v.item); put(r, 1, v.count); put(r, 2, v.adults + v.children); put(r, 3, money(v.value)); r++; }
    put(r, 0, { v: 'Total', s: S.tot }); put(r, 3, { v: d.totals.vouchers, s: S.moneyTot }); r += 2;
  }
  put(r, 0, { v: 'TOTAL DO MÊS', s: S.tot }); put(r, 3, { v: d.totals.total, s: S.moneyTot });
  return { name: monthLabel(month), rows, merges, cols: Array.from({ length: d.weeks.length * W }, (_, i) => [22, 14, 12, 12, 12, 3][i % W]), freeze: { row: 2, col: 0 } };
}

const monthsFor = (q) => {
  const all = fin.months();
  if (/^\d{4}-\d{2}$/.test(q.month || '')) return [q.month];
  if (/^\d{4}$/.test(q.year || '')) return all.filter((m) => m.startsWith(q.year)).sort();
  return all.slice().sort();
};
const xlsx = (buf, name) => ({ __raw: buf, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}"` } });

route('GET', '/api/finance/consolidated.xlsx', { roles: FIN_VIEW }, ({ query, user, ip }) => {
  const ms = monthsFor(query);
  audit(user, 'controle_faturamento_exportado', { meses: ms }, ip);
  return xlsx(buildWorkbook(ms.map(consolidatedSheet)), `controle-faturamento-restaurantes_${ms.length === 1 ? ms[0] : (query.year || 'todos-os-meses')}.xlsx`);
});

route('GET', '/api/finance/restaurant.xlsx', { roles: [...FIN_VIEW, 'restaurante'] }, ({ query, user, ip }) => {
  const restId = finRestaurant(user, query.restaurant_id);
  const rest = db.prepare('SELECT name FROM restaurants WHERE id = ?').get(restId);
  const ms = monthsFor(query);
  audit(user, 'controle_restaurante_exportado', { restaurante: rest.name, meses: ms }, ip);
  const slug = rest.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return xlsx(buildWorkbook(ms.map((m) => restaurantSheet(restId, m))), `controle-divisao-${slug}_${ms.length === 1 ? ms[0] : (query.year || 'todos-os-meses')}.xlsx`);
});

module.exports = { consolidatedSheet, restaurantSheet };
