'use strict';
// Regras de pensão e distribuição entre restaurantes.
const { db, tx } = require('./db');
const { BOARDS, MEALS, addDays } = require('./util');

/*
 * Janela de cada refeição dentro da estadia (entrada E, saída S) — conferida com a planilha de divisão do resort:
 *  - Café:   do dia seguinte à entrada até o dia da saída   (E < dia <= S)
 *  - Almoço: do dia seguinte à entrada até o dia da saída   (E < dia <= S)
 *            exceção "almoço na chegada" (grupos que chegam antes do almoço): E <= dia < S
 *  - Jantar: do dia da entrada até a véspera da saída        (E <= dia < S)
 */
function inWindow(res, date, meal) {
  if (meal === 'janta' || (meal === 'almoco' && res.lunch_on_arrival)) return date >= res.checkin && date < res.checkout;
  return date > res.checkin && date <= res.checkout;
}

function boardHas(board, meal) {
  return !!BOARDS[board] && BOARDS[board].meals.includes(meal);
}

function isEligible(res, date, meal) {
  return res.status === 'ativa' && boardHas(res.board, meal) && inWindow(res, date, meal);
}

function mealDates(res, meal) {
  if (!boardHas(res.board, meal) || res.status !== 'ativa') return [];
  const out = [];
  let d = res.checkin, guard = 0;
  while (d <= res.checkout && guard++ < 400) { if (inWindow(res, d, meal)) out.push(d); d = addDays(d, 1); }
  return out;
}

function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Situação de cada restaurante numa refeição/data: serve? aberto? por quê?
function restaurantStatus(meal, date) {
  const wd = String(weekday(date));
  const over = new Map(db.prepare('SELECT * FROM restaurant_days WHERE date = ? AND meal = ?').all(date, meal).map((o) => [o.restaurant_id, o]));
  return db.prepare(`SELECT id, code, name, color, share_${meal} AS share, cap_${meal} AS cap, closed_${meal} AS closed FROM restaurants WHERE active = 1 ORDER BY id`).all().map((r) => {
    const serves = r.share > 0;
    const weekly = String(r.closed || '').split(',').map((x) => x.trim()).includes(wd);
    const o = over.get(r.id);
    let open = serves && !weekly, reason = !serves ? 'nao_serve' : weekly ? 'fechado_semana' : null;
    if (serves && o) { open = !!o.is_open; reason = o.is_open ? (weekly ? 'aberto_excecao' : null) : 'fechado_dia'; }
    return { ...r, serves, open, reason, note: o ? o.note : null };
  });
}

// Restaurantes que servem a refeição (percentual > 0) e estão abertos naquela data
function restaurantsFor(meal, date = null) {
  if (!date) {
    return db.prepare(`SELECT id, code, name, color, share_${meal} AS share, cap_${meal} AS cap, closed_${meal} AS closed
      FROM restaurants WHERE active = 1 AND share_${meal} > 0 ORDER BY share_${meal} DESC, id`).all();
  }
  const open = restaurantStatus(meal, date).filter((r) => r.open).sort((a, b) => b.share - a.share || a.id - b.id);
  // Com apenas dois restaurantes abertos no almoço ou no jantar, a divisão passa a ser 60/40
  // (o de maior percentual fica com 60%). Configurável em settings: two_open_split (padrão 60).
  // Com movimento grande (padrão: 400 pessoas ou mais na refeição), o restaurante principal (Di Giordana,
  // o de menor custo) recebe até 300 pessoas e o restante vai para o outro restaurante aberto.
  if (open.length === 2 && (meal === 'almoco' || meal === 'janta')) {
    const { getSetting } = require('./db');
    let main = Math.min(100, Math.max(0, Number(getSetting('two_open_split', '60')) || 60)) / 100;
    const threshold = Number(getSetting('two_open_threshold', '400')) || 400;
    const mainCap = Number(getSetting('two_open_main_cap', '300')) || 300;
    const total = (db.prepare(`SELECT SUM(r.adults + r.children) n FROM assignments a JOIN reservations r ON r.id = a.reservation_id
      WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa'`).get(date, meal) || {}).n || 0;
    if (total >= threshold) main = Math.max(main, Math.min(1, mainCap / total));
    open[0] = { ...open[0], share: Math.round(main * 1000) / 1000 };
    open[1] = { ...open[1], share: Math.round((1 - main) * 1000) / 1000 };
  }
  return open;
}

function paxLoads(date, meal) {
  const loads = {};
  for (const r of db.prepare(`
    SELECT a.restaurant_id, SUM(r.adults + r.children) pax
    FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa' GROUP BY a.restaurant_id`).all(date, meal)) {
    loads[r.restaurant_id] = r.pax;
  }
  return loads;
}

// Quantas vezes o grupo já foi a cada restaurante nessa refeição, em outros dias (para alternar)
function groupVisits(resNumber, meal, exceptDate) {
  const v = {};
  for (const r of db.prepare(`SELECT a.restaurant_id, COUNT(DISTINCT a.date) n FROM assignments a JOIN reservations r ON r.id = a.reservation_id
      WHERE r.reservation_number = ? AND a.meal = ? AND a.date != ? AND r.status = 'ativa' GROUP BY a.restaurant_id`).all(resNumber, meal, exceptDate)) {
    v[r.restaurant_id] = r.n;
  }
  return v;
}

// Peso do rodízio: quanto o sistema aceita se afastar da meta (em pax do grupo) para o grupo conhecer outro restaurante
const ROTATION_WEIGHT = 0.6;

/*
 * Escolhe o restaurante para um grupo de `pax` pessoas:
 *  1) respeita a capacidade cadastrada;
 *  2) fica com o mais "atrasado" em relação à meta percentual;
 *  3) prefere um restaurante que o grupo ainda não conheceu nessa refeição (rodízio).
 */
function pickRestaurant(rests, loads, pax, visits = {}) {
  const totalShare = rests.reduce((s, r) => s + r.share, 0) || 1;
  const totalAfter = rests.reduce((s, r) => s + (loads[r.id] || 0), 0) + pax;
  let pool = rests.filter((r) => !r.cap || (loads[r.id] || 0) + pax <= r.cap);
  if (!pool.length) pool = rests; // todos cheios: mantém a proporção e sinaliza lotação na tela
  let best = null, bestScore = -Infinity;
  for (const r of pool) {
    const score = (r.share / totalShare) * totalAfter - (loads[r.id] || 0) - ROTATION_WEIGHT * pax * (visits[r.id] || 0);
    if (score > bestScore + 1e-9) { best = r; bestScore = score; }
  }
  return best;
}

function hasAttendance(resId, date, meal) {
  return !!db.prepare('SELECT 1 FROM attendance WHERE reservation_id = ? AND date = ? AND meal = ?').get(resId, date, meal);
}

// Pax do grupo (todos os quartos ativos da reserva que têm essa refeição nesse dia)
function groupPax(resNumber, date, meal) {
  return db.prepare(`SELECT * FROM reservations WHERE reservation_number = ? AND status = 'ativa'`).all(resNumber)
    .filter((r) => isEligible(r, date, meal)).reduce((s, r) => s + r.adults + r.children, 0);
}

// Restaurante onde o grupo já está nesse dia/refeição (outro quarto da mesma reserva)
function groupRestaurant(resNumber, date, meal, exceptResId) {
  const r = db.prepare(`SELECT a.restaurant_id FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE r.reservation_number = ? AND a.date = ? AND a.meal = ? AND r.status = 'ativa' AND r.id != ?
    ORDER BY a.locked DESC, a.id LIMIT 1`).get(resNumber, date, meal, exceptResId);
  return r ? r.restaurant_id : null;
}

// Garante que as atribuições de um quarto batem com a pensão e as datas atuais.
function syncReservation(resId) {
  const res = db.prepare('SELECT * FROM reservations WHERE id = ?').get(resId);
  if (!res) return;
  const pax = res.adults + res.children;
  for (const meal of MEALS) {
    const dates = new Set(mealDates(res, meal));
    const allRests = restaurantsFor(meal);
    const pref = res.pref_restaurant_id && allRests.find((r) => r.id === res.pref_restaurant_id);
    const existing = db.prepare('SELECT * FROM assignments WHERE reservation_id = ? AND meal = ?').all(resId, meal);
    for (const a of existing) {
      const attended = hasAttendance(resId, a.date, meal);
      if (!dates.has(a.date)) {
        if (!attended) db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
        continue;
      }
      dates.delete(a.date);
      if (attended) continue;
      const rests = restaurantsFor(meal, a.date);
      if (pref && a.restaurant_id !== pref.id && !a.locked) {
        db.prepare('UPDATE assignments SET restaurant_id = ?, locked = 1, origin = ? WHERE id = ?').run(pref.id, res.source, a.id);
      } else if (!rests.find((r) => r.id === a.restaurant_id) && rests.length && !a.locked) {
        // restaurante deixou de servir essa refeição nesse dia
        const loads = paxLoads(a.date, meal);
        loads[a.restaurant_id] = Math.max(0, (loads[a.restaurant_id] || 0) - pax);
        db.prepare('UPDATE assignments SET restaurant_id = ? WHERE id = ?').run(pickRestaurant(rests, loads, pax).id, a.id);
      }
    }
    for (const date of dates) {
      let restId, locked = 0, origin = 'auto';
      if (pref) { restId = pref.id; locked = 1; origin = res.source; }
      else {
        restId = groupRestaurant(res.reservation_number, date, meal, res.id);
        if (!restId) {
          const rests = restaurantsFor(meal, date);
          if (!rests.length) continue;
          const gp = Math.max(pax, groupPax(res.reservation_number, date, meal));
          restId = pickRestaurant(rests, paxLoads(date, meal), gp, groupVisits(res.reservation_number, meal, date)).id;
        }
      }
      db.prepare('INSERT INTO assignments(reservation_id, date, meal, restaurant_id, locked, origin) VALUES (?,?,?,?,?,?)')
        .run(resId, date, meal, restId, locked, origin);
    }
  }
}

/*
 * Redistribui um dia/refeição. A unidade é o GRUPO (todos os quartos da mesma reserva vão juntos).
 * Quartos travados ou já marcados ficam onde estão e "puxam" o resto do grupo para lá.
 */
function rebalance(date, meal) {
  const rests = restaurantsFor(meal, date);
  if (!rests.length) return { moved: 0 };
  return tx(() => {
    const rows = db.prepare(`
      SELECT a.id, a.restaurant_id, a.locked, r.reservation_number num, r.adults + r.children pax,
        EXISTS(SELECT 1 FROM attendance t WHERE t.reservation_id = a.reservation_id AND t.date = a.date AND t.meal = a.meal) attended
      FROM assignments a JOIN reservations r ON r.id = a.reservation_id
      WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa'`).all(date, meal);
    const loads = {};
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.num)) groups.set(r.num, { num: r.num, fixed: null, free: [], pax: 0 });
      const g = groups.get(r.num);
      if (r.locked || r.attended) {
        loads[r.restaurant_id] = (loads[r.restaurant_id] || 0) + r.pax;
        if (!g.fixed) g.fixed = r.restaurant_id;
      } else { g.free.push(r); g.pax += r.pax; }
    }
    const upd = db.prepare('UPDATE assignments SET restaurant_id = ? WHERE id = ?');
    let moved = 0;
    const place = (g, restId) => {
      loads[restId] = (loads[restId] || 0) + g.pax;
      for (const r of g.free) if (r.restaurant_id !== restId) { upd.run(restId, r.id); moved++; }
    };
    const list = [...groups.values()].filter((g) => g.free.length);
    // grupos presos a um restaurante primeiro; depois os maiores -> divisão mais equilibrada
    for (const g of list.filter((x) => x.fixed)) place(g, g.fixed);
    const rest = list.filter((x) => !x.fixed).sort((a, b) => b.pax - a.pax || String(a.num).localeCompare(String(b.num)));
    for (const g of rest) place(g, pickRestaurant(rests, loads, g.pax, groupVisits(g.num, meal, date)).id);
    return { moved };
  });
}

function isPublished(date, meal) {
  return !!db.prepare('SELECT 1 FROM meal_lists WHERE date = ? AND meal = ?').get(date, meal);
}

// Após uma importação: sincroniza os quartos. Quem já tinha restaurante continua onde está
// (para não mudar cartões já entregues); só os novos dias/quartos são distribuídos,
// grupos maiores primeiro e todos os quartos do grupo em sequência.
function syncMany(resIds) {
  const info = db.prepare('SELECT reservation_number num, adults + children p FROM reservations WHERE id = ?');
  const items = [...new Set(resIds)].map((id) => ({ id, ...(info.get(id) || { num: '', p: 0 }) }));
  const gp = {};
  for (const it of items) gp[it.num] = (gp[it.num] || 0) + it.p;
  items.sort((a, b) => gp[b.num] - gp[a.num] || String(a.num).localeCompare(String(b.num)) || b.p - a.p);
  tx(() => { for (const { id } of items) syncReservation(id); });
}

// Resumo de um dia/refeição por restaurante
function daySummary(date, meal) {
  const openList = restaurantsFor(meal, date);
  const open = new Set(openList.map((r) => r.id));
  const eff = new Map(openList.map((r) => [r.id, r.share]));
  const rests = db.prepare(`SELECT id, code, name, color, share_${meal} share, cap_${meal} cap FROM restaurants WHERE active = 1 ORDER BY id`).all()
    .map((r) => (eff.has(r.id) ? { ...r, share: eff.get(r.id) } : r));
  const asg = db.prepare(`
    SELECT a.restaurant_id, COUNT(*) reservas, SUM(r.adults) adults, SUM(r.children) children
    FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa' GROUP BY a.restaurant_id`).all(date, meal);
  const att = db.prepare(`
    SELECT restaurant_id, COUNT(*) reservas, SUM(adults) adults, SUM(children) children,
      SUM(CASE WHEN status = 'fora_lista' THEN 1 ELSE 0 END) fora
    FROM attendance WHERE date = ? AND meal = ? GROUP BY restaurant_id`).all(date, meal);
  const total = asg.reduce((s, a) => s + a.adults + a.children, 0);
  return rests.map((r) => {
    const a = asg.find((x) => x.restaurant_id === r.id) || { reservas: 0, adults: 0, children: 0 };
    const t = att.find((x) => x.restaurant_id === r.id) || { reservas: 0, adults: 0, children: 0, fora: 0 };
    const pax = a.adults + a.children;
    return {
      ...r, serves: open.has(r.id), closed_today: r.share > 0 && !open.has(r.id),
      reservas: a.reservas, adults: a.adults, children: a.children, pax,
      pct: total ? pax / total : 0,
      checked_reservas: t.reservas, checked_pax: t.adults + t.children, fora_lista: t.fora,
      full: !!r.cap && pax >= r.cap,
    };
  });
}

module.exports = { restaurantStatus, inWindow, boardHas, isEligible, mealDates, restaurantsFor, pickRestaurant, syncReservation, syncMany, rebalance, isPublished, daySummary, paxLoads, groupVisits, weekday };
