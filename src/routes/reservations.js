'use strict';
const { route, HttpError } = require('../http');
const { db, tx, audit, notify } = require('../db');
const { MEALS, BOARDS, addDays, todayISO, isISODate, toCSV, MEAL_LABEL, roomKey, roomMatch } = require('../util');
const { syncReservation, boardHas, inWindow } = require('../meals');
const { parseRows, upsertReservations, normalizeRecord, planImport, checkDistribution } = require('../importer');
const { readSpreadsheet } = require('../xlsx');

const LIST = ['admin', 'refeicao'];                           // página Reservas
const DETAIL = ['admin', 'refeicao', 'recepcao', 'agencia'];  // detalhe/cartão do hóspede
const RECEPTION = ['admin', 'recepcao', 'agencia'];           // onde cada hóspede come
const EDIT = ['admin', 'refeicao'];

function restMap() {
  return Object.fromEntries(db.prepare('SELECT id, code, name, color FROM restaurants').all().map((r) => [r.id, r]));
}

// Plano completo de refeições da estadia
function stayPlan(res) {
  const rm = restMap();
  const asg = db.prepare('SELECT date, meal, restaurant_id, locked FROM assignments WHERE reservation_id = ?').all(res.id);
  const att = db.prepare('SELECT date, meal, restaurant_id, status, created_at FROM attendance WHERE reservation_id = ?').all(res.id);
  const days = [];
  let d = res.checkin, guard = 0;
  while (d <= res.checkout && guard++ < 400) {
    const day = { date: d, meals: {} };
    for (const meal of MEALS) {
      if (!boardHas(res.board, meal)) { day.meals[meal] = { included: false, reason: 'nao_inclui' }; continue; }
      if (!inWindow(res, d, meal)) { day.meals[meal] = { included: false, reason: 'fora_estadia' }; continue; }
      const a = asg.find((x) => x.date === d && x.meal === meal);
      const t = att.find((x) => x.date === d && x.meal === meal);
      day.meals[meal] = {
        included: true,
        restaurant: a ? rm[a.restaurant_id] : null,
        locked: a ? !!a.locked : false,
        attended: t ? { restaurant: rm[t.restaurant_id], status: t.status, at: t.created_at } : null,
      };
    }
    days.push(day);
    d = addDays(d, 1);
  }
  return days;
}

route('GET', '/api/reservations', { roles: LIST }, ({ query }) => {
  const where = [], args = [];
  if (query.q) {
    const rm = roomMatch('r.room', query.q);
    where.push(`(r.reservation_number LIKE ? OR norm_txt(r.guest_name) LIKE '%' || norm_txt(?) || '%' OR norm_txt(r.guests) LIKE '%' || norm_txt(?) || '%' OR ${rm.sql})`);
    args.push(`%${query.q}%`, query.q, query.q, ...rm.args);
  }
  if (query.date && isISODate(query.date)) { where.push('r.checkin <= ? AND r.checkout >= ?'); args.push(query.date, query.date); }
  if (query.status) { where.push('r.status = ?'); args.push(query.status); }
  if (query.board) { where.push('r.board = ?'); args.push(query.board); }
  const limit = Math.min(Number(query.limit) || 200, 1000);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM reservations r ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM room_changes c WHERE c.reservation_id = r.id) room_changes
    FROM reservations r ${w} ORDER BY r.checkin DESC, room_sort(r.room) LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { total, rows };
});

route('GET', '/api/reservations/export.csv', { roles: ['admin', 'supervisor', 'refeicao'] }, ({ query, user, ip }) => {
  const rows = db.prepare('SELECT * FROM reservations ORDER BY checkin, room_sort(room)').all()
    .filter((r) => !query.date || (r.checkin <= query.date && r.checkout >= query.date));
  audit(user, 'exportou_reservas', { total: rows.length }, ip);
  return {
    __raw: toCSV(['Reserva', 'Nome', 'Entrada', 'Saída', 'Quarto', 'Pensão', 'Adultos', 'Crianças', 'Origem', 'Situação'],
      rows.map((r) => [r.reservation_number, r.guest_name, r.checkin, r.checkout, r.room, r.board, r.adults, r.children, r.source, r.status])),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reservas.csv"' },
  };
});

route('GET', '/api/reservations/:id', { roles: DETAIL }, ({ params }) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
  if (!r) throw new HttpError(404, 'Reserva não encontrada.');
  return {
    reservation: r,
    plan: stayPlan(r),
    room_changes: db.prepare(`SELECT c.*, u.name user_name FROM room_changes c LEFT JOIN users u ON u.id = c.user_id WHERE reservation_id = ? ORDER BY c.id DESC`).all(r.id),
    group: db.prepare(`SELECT id, room, adults, children, board, checkin, checkout, status, guests FROM reservations WHERE reservation_number = ? ORDER BY room_sort(room)`).all(r.reservation_number),
  };
});

function guestsWithinPolicy(g) {
  const { maxPaxRoom } = require('../db');
  const n = String(g ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).length;
  if (n > maxPaxRoom()) throw new HttpError(400, `${n} hóspedes informados; a política do resort é de no máximo ${maxPaxRoom()} pessoas por quarto.`);
}

function readReservationBody(body) {
  const { rec, errors } = normalizeRecord(body);
  if (errors.length) throw new HttpError(400, 'Verifique: ' + errors.join(', '));
  return rec;
}

route('POST', '/api/reservations', { roles: EDIT }, ({ body, user, ip }) => {
  const rec = readReservationBody(body);
  if (db.prepare("SELECT 1 FROM reservations WHERE reservation_number = ? AND room_key(room) = ? AND status = 'ativa'").get(rec.reservation_number, roomKey(rec.room))) throw new HttpError(409, 'Essa reserva já tem esse quarto cadastrado.');
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO reservations(reservation_number, guest_name, checkin, checkout, room, board, adults, children, source, notes, lunch_on_arrival)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(rec.reservation_number, rec.guest_name, rec.checkin, rec.checkout, rec.room, rec.board, rec.adults, rec.children, 'manual', body.notes || null, body.lunch_on_arrival ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    syncReservation(id);
    return id;
  });
  audit(user, 'reserva_criada', { id, ...rec }, ip);
  return { id };
});

route('PUT', '/api/reservations/:id', { roles: EDIT }, ({ params, body, user, ip }) => {
  const ex = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
  if (!ex) throw new HttpError(404, 'Reserva não encontrada.');
  const rec = readReservationBody({ ...ex, ...body, reservation_number: ex.reservation_number });
  tx(() => {
    if (roomKey(rec.room) !== roomKey(ex.room)) {
      db.prepare('INSERT INTO room_changes(reservation_id, old_room, new_room, source, user_id) VALUES (?,?,?,?,?)').run(ex.id, ex.room, rec.room, 'manual', user.id);
      const title = `Troca de apartamento: ${ex.room} → ${rec.room}`;
      const bodyTxt = `${rec.guest_name} (reserva ${ex.reservation_number})`;
      for (const role of ['recepcao', 'restaurante', 'refeicao']) notify({ role, kind: 'room_change', title, body: bodyTxt, link: '#/trocas' });
    }
    const loa = body.lunch_on_arrival === undefined ? ex.lunch_on_arrival : (body.lunch_on_arrival ? 1 : 0);
    if (body.guests !== undefined) guestsWithinPolicy(body.guests);
    if (body.guests !== undefined) db.prepare('UPDATE reservations SET guests = ? WHERE id = ?').run(String(body.guests).split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20).join('\n'), ex.id);
    db.prepare(`UPDATE reservations SET guest_name=?, checkin=?, checkout=?, room=?, board=?, adults=?, children=?, notes=?, lunch_on_arrival=?,
      updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(rec.guest_name, rec.checkin, rec.checkout, rec.room, rec.board, rec.adults, rec.children, body.notes ?? ex.notes, loa, ex.id);
    syncReservation(ex.id);
    // "almoço na chegada" vale para o grupo inteiro (todos os quartos da reserva)
    if (loa !== ex.lunch_on_arrival) {
      for (const o of db.prepare('SELECT id FROM reservations WHERE reservation_number = ? AND id != ?').all(ex.reservation_number, ex.id)) {
        db.prepare('UPDATE reservations SET lunch_on_arrival = ? WHERE id = ?').run(loa, o.id);
        syncReservation(o.id);
      }
    }
  });
  const diff = Object.fromEntries(['guest_name', 'checkin', 'checkout', 'room', 'board', 'adults', 'children'].filter((k) => (k === 'room' ? roomKey(ex.room) !== roomKey(rec.room) : String(ex[k]) !== String(rec[k]))).map((k) => [k, [ex[k], rec[k]]]));
  audit(user, 'reserva_alterada', { reserva: ex.reservation_number, diff }, ip);
  return { ok: true };
});

route('POST', '/api/reservations/:id/cancel', { roles: EDIT }, ({ params, user, ip }) => {
  const ex = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
  if (!ex) throw new HttpError(404, 'Reserva não encontrada.');
  tx(() => {
    db.prepare("UPDATE reservations SET status = 'cancelada', updated_at = datetime('now','localtime') WHERE id = ?").run(ex.id);
    syncReservation(ex.id);
  });
  audit(user, 'reserva_cancelada', { reserva: ex.reservation_number }, ip);
  return { ok: true };
});

route('POST', '/api/reservations/:id/reactivate', { roles: EDIT }, ({ params, user, ip }) => {
  const ex = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
  if (!ex) throw new HttpError(404, 'Reserva não encontrada.');
  tx(() => {
    db.prepare("UPDATE reservations SET status = 'ativa', updated_at = datetime('now','localtime') WHERE id = ?").run(ex.id);
    syncReservation(ex.id);
  });
  audit(user, 'reserva_reativada', { reserva: ex.reservation_number }, ip);
  return { ok: true };
});

// ---------- Importação ----------
route('POST', '/api/import/preview', { roles: EDIT, raw: 25 * 1024 * 1024 }, ({ body, req }) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  let rows;
  try { rows = readSpreadsheet(body, filename); } catch (e) { throw new HttpError(400, e.message); }
  const parsed = parseRows(rows);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  checkDistribution(parsed.rows, parsed.distribution && parsed.distribution.slots);
  // marca o que é novo / alterado / troca de quarto (mesma lógica da gravação)
  const plan = planImport(parsed.rows.map((r) => ({ ...r })), { cancelMissing: true });
  plan.items.forEach((it, i) => {
    const r = parsed.rows[i];
    r.action = it.action;
    if (it.old_room) r.old_room = it.old_room;
    if (it.rec.warning) r.warning = it.rec.warning;
  });
  const groups = new Set(parsed.rows.filter((r) => !r.errors.length).map((r) => r.reservation_number));
  return {
    filename, headerRow: parsed.headerRow, mapping: parsed.mapping, rows: parsed.rows,
    groups: groups.size,
    removed: plan.removed.map((e) => ({ id: e.id, reservation_number: e.reservation_number, guest_name: e.guest_name, room: e.room, checkin: e.checkin, checkout: e.checkout })),
    distribution: parsed.distribution,
  };
});

route('POST', '/api/import/commit', { roles: EDIT, raw: 25 * 1024 * 1024 }, ({ body, user, ip }) => {
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido.'); }
  const rows = (data.rows || []).filter((r) => !r.errors || !r.errors.length).map((r) => ({ ...r, errors: undefined }));
  if (!rows.length) throw new HttpError(400, 'Nenhuma linha válida para importar.');
  const result = upsertReservations(rows, { source: 'excel', user, cancelMissing: !!data.cancel_missing, useDistribution: !!data.use_distribution });
  audit(user, 'importacao_planilha', { arquivo: data.filename, inseridas: result.inserted, alteradas: result.updated, iguais: result.unchanged, canceladas: result.cancelled, trocas_quarto: result.roomChanges.length, divisao_planilha: result.distApplied, erros: result.errors.length }, ip);
  return { inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, cancelled: result.cancelled, roomChanges: result.roomChanges, errors: result.errors, distApplied: result.distApplied, distSkipped: result.distSkipped };
});

route('GET', '/api/import/modelo.csv', { roles: EDIT }, () => ({
  __raw: toCSV(['Nº Reserva', 'Nome completo', 'Entrada', 'Saída', 'Quarto', 'Pensão', 'Adultos', 'Crianças'], [
    ['12345', 'Maria da Silva', '01/10/2026', '05/10/2026', '101', 'FAP', 2, 1],
    ['12346', 'João Pereira', '02/10/2026', '04/10/2026', '215', 'MAP', 2, 0],
  ]),
  headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="modelo-importacao.csv"' },
}));

// ---------- Trocas de quarto ----------
route('GET', '/api/room-changes', { portal: true }, ({ query }) => {
  const days = Math.min(Number(query.days) || 7, 90);
  const pend = query.pending === '1' ? 'AND c.validated_at IS NULL' : '';
  return db.prepare(`SELECT c.*, r.reservation_number, r.guest_name, r.guests, r.room current_room, r.status, u.name user_name, v.name validated_by_name FROM room_changes c
    JOIN reservations r ON r.id = c.reservation_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users v ON v.id = c.validated_by
    WHERE c.created_at >= datetime('now','localtime', ?) ${pend} ORDER BY c.id DESC`).all(`-${days} days`);
});

// Comercial confere a troca (ok) ou desfaz (volta o quarto antigo)
const VALIDATE = ['admin', 'refeicao', 'agencia'];
route('POST', '/api/room-changes/:id/validate', { roles: VALIDATE }, ({ params, body, user, ip }) => {
  const c = db.prepare('SELECT c.*, r.room current_room, r.reservation_number, r.guest_name FROM room_changes c JOIN reservations r ON r.id = c.reservation_id WHERE c.id = ?').get(params.id);
  if (!c) throw new HttpError(404, 'Troca não encontrada.');
  const note = body.note ? String(body.note).slice(0, 300) : null;
  if (body.undo) {
    if (roomKey(c.current_room) !== roomKey(c.new_room)) throw new HttpError(409, 'O quarto já mudou de novo depois desta troca; ajuste pela reserva.');
    tx(() => {
      db.prepare("UPDATE reservations SET room = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(c.old_room, c.reservation_id);
      db.prepare('INSERT INTO room_changes(reservation_id, old_room, new_room, source, user_id, validated_at, validated_by, validation_note) VALUES (?,?,?,?,?,datetime(\'now\',\'localtime\'),?,?)')
        .run(c.reservation_id, c.new_room, c.old_room, 'desfeita', user.id, user.id, note || 'troca desfeita');
      db.prepare("UPDATE room_changes SET validated_at = datetime('now','localtime'), validated_by = ?, validation_note = ? WHERE id = ?").run(user.id, 'desfeita' + (note ? ': ' + note : ''), c.id);
      for (const role of ['recepcao', 'restaurante', 'refeicao']) notify({ role, kind: 'room_change', title: `Troca de apartamento desfeita: ${c.new_room} → ${c.old_room}`, body: `${c.guest_name} (reserva ${c.reservation_number}) retorna ao apto ${c.old_room}`, link: '#/trocas' });
    });
    audit(user, 'troca_quarto_desfeita', { reserva: c.reservation_number, de: c.new_room, para: c.old_room, obs: note }, ip);
    return { ok: true, undone: true };
  }
  db.prepare("UPDATE room_changes SET validated_at = datetime('now','localtime'), validated_by = ?, validation_note = ? WHERE id = ?").run(user.id, note, c.id);
  audit(user, 'troca_quarto_conferida', { reserva: c.reservation_number, de: c.old_room, para: c.new_room, obs: note }, ip);
  return { ok: true };
});

// ---------- Recepção: onde cada hóspede come em cada dia ----------
route('GET', '/api/reception', { roles: RECEPTION }, ({ query }) => {
  const date = isISODate(query.date) ? query.date : todayISO();
  const rm = restMap();
  const res = db.prepare(`SELECT * FROM reservations WHERE status = 'ativa' AND checkin <= ? AND checkout >= ?
    ORDER BY room_sort(room)`).all(date, date);
  const asg = db.prepare('SELECT reservation_id, meal, restaurant_id FROM assignments WHERE date = ?').all(date);
  const recent = db.prepare(`SELECT reservation_id, old_room FROM room_changes WHERE created_at >= datetime('now','localtime','-3 days')`).all();
  return {
    date,
    rows: res.map((r) => ({
      id: r.id, reservation_number: r.reservation_number, guest_name: r.guest_name, guests: r.guests, room: r.room, board: r.board,
      adults: r.adults, children: r.children, checkin: r.checkin, checkout: r.checkout,
      arriving: r.checkin === date, leaving: r.checkout === date,
      old_room: (recent.find((c) => c.reservation_id === r.id) || {}).old_room || null,
      meals: Object.fromEntries(MEALS.map((m) => {
        if (!boardHas(r.board, m) || !inWindow(r, date, m)) return [m, null];
        const a = asg.find((x) => x.reservation_id === r.id && x.meal === m);
        return [m, a ? rm[a.restaurant_id] : { code: '?', name: 'Sem restaurante' }];
      })),
    })),
  };
});

module.exports = { stayPlan, restMap };
