'use strict';
// Regras de pensão e distribuição entre restaurantes.
const { db, tx } = require('./db');
const { BOARDS, MEALS, addDays, todayISO } = require('./util');

/*
 * Janela de cada refeição dentro da estadia (entrada E, saída S):
 *  - Café:   do dia seguinte à entrada até o dia da saída   (E < dia <= S)
 *  - Almoço: do dia seguinte à entrada até o dia da saída   (E < dia <= S)
 *  - Jantar: do dia da entrada até a véspera da saída        (E <= dia < S)
 * Pode ser ajustado aqui se a regra do hotel for diferente.
 */
function inWindow(res, date, meal) {
  if (meal === 'janta') return date >= res.checkin && date < res.checkout;
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
  let d = meal === 'janta' ? res.checkin : addDays(res.checkin, 1);
  const last = meal === 'janta' ? addDays(res.checkout, -1) : res.checkout;
  let guard = 0;
  while (d <= last && guard++ < 400) { out.push(d); d = addDays(d, 1); }
  return out;
}

function restaurantsFor(meal) {
  return db.prepare(`SELECT id, code, name, color, share_${meal} AS share, cap_${meal} AS cap FROM restaurants WHERE active = 1 AND share_${meal} > 0 ORDER BY share_${meal} DESC, id`).all();
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

// Escolhe o restaurante mais "atrasado" em relação à sua meta percentual, respeitando capacidade.
function pickRestaurant(rests, loads, pax) {
  const totalShare = rests.reduce((s, r) => s + r.share, 0) || 1;
  const totalAfter = rests.reduce((s, r) => s + (loads[r.id] || 0), 0) + pax;
  let pool = rests.filter((r) => !r.cap || (loads[r.id] || 0) + pax <= r.cap);
  if (!pool.length) pool = rests; // todos cheios: mantém a proporção e sinaliza lotação na tela
  let best = null, bestScore = -Infinity;
  for (const r of pool) {
    const score = (r.share / totalShare) * totalAfter - (loads[r.id] || 0);
    if (score > bestScore + 1e-9) { best = r; bestScore = score; }
  }
  return best;
}

function hasAttendance(resId, date, meal) {
  return !!db.prepare('SELECT 1 FROM attendance WHERE reservation_id = ? AND date = ? AND meal = ?').get(resId, date, meal);
}

// Garante que as atribuições de uma reserva batem com a pensão e as datas atuais.
function syncReservation(resId) {
  const res = db.prepare('SELECT * FROM reservations WHERE id = ?').get(resId);
  if (!res) return;
  const pax = res.adults + res.children;
  for (const meal of MEALS) {
    const dates = new Set(mealDates(res, meal));
    const rests = restaurantsFor(meal);
    const pref = res.pref_restaurant_id && rests.find((r) => r.id === res.pref_restaurant_id);
    const existing = db.prepare('SELECT * FROM assignments WHERE reservation_id = ? AND meal = ?').all(resId, meal);
    for (const a of existing) {
      const attended = hasAttendance(resId, a.date, meal);
      if (!dates.has(a.date)) {
        if (!attended) db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
        continue;
      }
      dates.delete(a.date);
      if (attended) continue;
      if (pref && a.restaurant_id !== pref.id && !a.locked) {
        db.prepare('UPDATE assignments SET restaurant_id = ?, locked = 1, origin = ? WHERE id = ?').run(pref.id, res.source, a.id);
      } else if (!rests.find((r) => r.id === a.restaurant_id) && rests.length) {
        // restaurante deixou de servir essa refeição
        const loads = paxLoads(a.date, meal);
        loads[a.restaurant_id] = Math.max(0, (loads[a.restaurant_id] || 0) - pax);
        db.prepare('UPDATE assignments SET restaurant_id = ?, locked = 0 WHERE id = ?').run(pickRestaurant(rests, loads, pax).id, a.id);
      }
    }
    for (const date of dates) {
      let rest, locked = 0, origin = 'auto';
      if (pref) { rest = pref; locked = 1; origin = res.source; }
      else {
        if (!rests.length) continue;
        rest = pickRestaurant(rests, paxLoads(date, meal), pax);
      }
      db.prepare('INSERT INTO assignments(reservation_id, date, meal, restaurant_id, locked, origin) VALUES (?,?,?,?,?,?)')
        .run(resId, date, meal, rest.id, locked, origin);
    }
  }
}

// Redistribui (para o dia/refeição) quem não está travado e ainda não foi marcado.
function rebalance(date, meal) {
  const rests = restaurantsFor(meal);
  if (!rests.length) return { moved: 0 };
  return tx(() => {
    const rows = db.prepare(`
      SELECT a.id, a.restaurant_id, a.locked, r.adults + r.children pax,
        EXISTS(SELECT 1 FROM attendance t WHERE t.reservation_id = a.reservation_id AND t.date = a.date AND t.meal = a.meal) attended
      FROM assignments a JOIN reservations r ON r.id = a.reservation_id
      WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa'`).all(date, meal);
    const loads = {};
    const free = [];
    for (const r of rows) {
      if (r.locked || r.attended) loads[r.restaurant_id] = (loads[r.restaurant_id] || 0) + r.pax;
      else free.push(r);
    }
    // grupos maiores primeiro -> divisão mais equilibrada
    free.sort((a, b) => b.pax - a.pax || a.id - b.id);
    let moved = 0;
    const upd = db.prepare('UPDATE assignments SET restaurant_id = ? WHERE id = ?');
    for (const r of free) {
      const best = pickRestaurant(rests, loads, r.pax);
      loads[best.id] = (loads[best.id] || 0) + r.pax;
      if (best.id !== r.restaurant_id) { upd.run(best.id, r.id); moved++; }
    }
    return { moved };
  });
}

function isPublished(date, meal) {
  return !!db.prepare('SELECT 1 FROM meal_lists WHERE date = ? AND meal = ?').get(date, meal);
}

// Após uma importação: sincroniza as reservas. Quem já tinha restaurante continua onde está
// (para não mudar cartões já entregues); só os novos dias/reservas são distribuídos,
// grupos maiores primeiro. Para refazer a divisão de um dia use rebalance().
function syncMany(resIds) {
  const pax = db.prepare('SELECT adults + children p FROM reservations WHERE id = ?');
  const ordered = [...new Set(resIds)].map((id) => ({ id, p: (pax.get(id) || { p: 0 }).p })).sort((a, b) => b.p - a.p);
  tx(() => { for (const { id } of ordered) syncReservation(id); });
}

// Resumo de um dia/refeição por restaurante
function daySummary(date, meal) {
  const rests = db.prepare(`SELECT id, code, name, color, share_${meal} share, cap_${meal} cap FROM restaurants WHERE active = 1 ORDER BY id`).all();
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
      ...r, serves: r.share > 0,
      reservas: a.reservas, adults: a.adults, children: a.children, pax,
      pct: total ? pax / total : 0,
      checked_reservas: t.reservas, checked_pax: t.adults + t.children, fora_lista: t.fora,
      full: !!r.cap && pax >= r.cap,
    };
  });
}

module.exports = { inWindow, boardHas, isEligible, mealDates, restaurantsFor, pickRestaurant, syncReservation, syncMany, rebalance, isPublished, daySummary, paxLoads };
