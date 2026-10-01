'use strict';
/*
 * Portal da Agência e do Cliente final.
 * Só enxergam as próprias reservas e só podem: trocar quarto, alterar dados da reserva
 * (nome, datas, quantidade de pessoas) e remover um quarto/hóspede. A pensão não muda por aqui.
 * Toda alteração fica no log e avisa o setor de refeições e a recepção.
 */
const { route, HttpError } = require('../http');
const { db, tx, audit, notify } = require('../db');
const { roomKey, todayISO, addDays } = require('../util');
const { syncReservation } = require('../meals');
const { normalizeRecord } = require('../importer');
const { stayPlan } = require('./reservations');

const PORTAL = ['agencia', 'cliente'];

// Filtro SQL das reservas que o usuário pode ver
function scope(user, alias = 'r') {
  if (user.role === 'cliente') {
    if (!user.reservation_number) throw new HttpError(400, 'Seu acesso não está vinculado a uma reserva. Fale com o resort.');
    return { sql: `${alias}.reservation_number = ?`, args: [String(user.reservation_number).trim()] };
  }
  const nums = String(user.reservation_number || '').split(/[,;\s]+/).map((x) => x.replace(/\./g, '').trim()).filter(Boolean);
  const name = String(user.agency || '').trim();
  if (!name && !nums.length) throw new HttpError(400, 'Seu acesso de agência não está vinculado a nenhuma reserva. Fale com o resort.');
  const parts = [], args = [];
  if (name) { parts.push(`norm_txt(${alias}.guest_name) LIKE '%' || norm_txt(?) || '%'`); args.push(name); }
  if (nums.length) { parts.push(`${alias}.reservation_number IN (${nums.map(() => '?').join(',')})`); args.push(...nums); }
  return { sql: `(${parts.join(' OR ')})`, args };
}

function getOwn(user, id) {
  const sc = scope(user);
  const r = db.prepare(`SELECT * FROM reservations r WHERE r.id = ? AND ${sc.sql}`).get(id, ...sc.args);
  if (!r) throw new HttpError(404, 'Reserva não encontrada.');
  return r;
}

const who = (user) => (user.role === 'agencia' ? `Agência ${user.agency || user.name}` : `Cliente ${user.name}`);

route('GET', '/api/portal/reservations', { roles: PORTAL }, ({ user, query }) => {
  const sc = scope(user);
  const past = query.past === '1';
  const rows = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM room_changes c WHERE c.reservation_id = r.id) room_changes
    FROM reservations r WHERE ${sc.sql} AND (${past ? '1' : 'r.checkout >= ?'})
    ORDER BY r.checkin, r.reservation_number, room_sort(r.room) LIMIT 2000`).all(...sc.args, ...(past ? [] : [addDays(todayISO(), -1)]));
  return { rows, today: todayISO() };
});

route('GET', '/api/portal/reservations/:id', { roles: PORTAL }, ({ user, params }) => {
  const r = getOwn(user, params.id);
  return { reservation: r, plan: stayPlan(r) };
});

route('PUT', '/api/portal/reservations/:id', { roles: PORTAL }, ({ user, params, body, ip }) => {
  const ex = getOwn(user, params.id);
  if (ex.status !== 'ativa') throw new HttpError(409, 'Este quarto foi removido. Fale com o resort para reativar.');
  if (ex.checkout < todayISO()) throw new HttpError(409, 'Estadia encerrada; não é possível alterar.');
  // campos liberados para o portal (a pensão e o número da reserva não mudam por aqui)
  const allowed = ['guest_name', 'room', 'checkin', 'checkout', 'adults', 'children'];
  const patch = Object.fromEntries(allowed.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const { rec, errors } = normalizeRecord({ ...ex, ...patch, reservation_number: ex.reservation_number, board: ex.board });
  if (errors.length) throw new HttpError(400, 'Verifique: ' + errors.join(', '));
  if (roomKey(rec.room) !== roomKey(ex.room)) {
    const taken = db.prepare(`SELECT 1 FROM reservations WHERE id != ? AND status = 'ativa' AND room_key(room) = ? AND checkin < ? AND checkout > ?`)
      .get(ex.id, roomKey(rec.room), rec.checkout, rec.checkin);
    if (taken) throw new HttpError(409, `O quarto ${rec.room} já está ocupado nessas datas. Confirme o número com a recepção.`);
  }
  const diff = Object.fromEntries(allowed.filter((k) => (k === 'room' ? roomKey(ex.room) !== roomKey(rec.room) : String(ex[k]) !== String(rec[k]))).map((k) => [k, [ex[k], rec[k]]]));
  if (!Object.keys(diff).length) return { ok: true, changed: false };
  tx(() => {
    if (diff.room) {
      db.prepare('INSERT INTO room_changes(reservation_id, old_room, new_room, source, user_id) VALUES (?,?,?,?,?)').run(ex.id, ex.room, rec.room, user.role, user.id);
      for (const role of ['recepcao', 'restaurante', 'refeicao']) {
        notify({ role, kind: 'room_change', title: `Troca de quarto: ${ex.room} → ${rec.room}`, body: `${rec.guest_name} (reserva ${ex.reservation_number}) · feita por ${who(user)}`, link: '#/trocas' });
      }
    }
    db.prepare(`UPDATE reservations SET guest_name=?, room=?, checkin=?, checkout=?, adults=?, children=?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(rec.guest_name, rec.room, rec.checkin, rec.checkout, rec.adults, rec.children, ex.id);
    syncReservation(ex.id);
    const other = Object.keys(diff).filter((k) => k !== 'room');
    if (other.length) {
      const labels = { guest_name: 'nome', checkin: 'entrada', checkout: 'saída', adults: 'adultos', children: 'crianças' };
      for (const role of ['refeicao', 'recepcao']) {
        notify({ role, kind: 'portal_change', title: `${who(user)} alterou a reserva ${ex.reservation_number}`, body: `Quarto ${rec.room}: ${other.map((k) => `${labels[k]} ${diff[k][0]} → ${diff[k][1]}`).join(' · ')}`, link: '#/reservas' });
      }
    }
  });
  audit(user, 'portal_reserva_alterada', { reserva: ex.reservation_number, quarto: ex.room, diff }, ip);
  return { ok: true, changed: true };
});

// Remover hóspede/quarto (ex.: troca em que o quarto sai do grupo)
route('POST', '/api/portal/reservations/:id/remove', { roles: PORTAL }, ({ user, params, body, ip }) => {
  const ex = getOwn(user, params.id);
  if (ex.status !== 'ativa') return { ok: true };
  if (ex.checkout < todayISO()) throw new HttpError(409, 'Estadia encerrada; não é possível remover.');
  tx(() => {
    db.prepare("UPDATE reservations SET status = 'cancelada', notes = trim(coalesce(notes, '') || ' ' || ?), updated_at = datetime('now','localtime') WHERE id = ?")
      .run(`[removido por ${who(user)}${body && body.reason ? ': ' + String(body.reason).slice(0, 200) : ''}]`, ex.id);
    syncReservation(ex.id);
    for (const role of ['refeicao', 'recepcao', 'restaurante']) {
      notify({ role, kind: 'portal_remove', title: `Quarto ${ex.room} removido da reserva ${ex.reservation_number}`, body: `${ex.guest_name} · ${ex.adults + ex.children} pax · feito por ${who(user)}${body && body.reason ? ` · motivo: ${String(body.reason).slice(0, 120)}` : ''}`, link: '#/reservas' });
    }
  });
  audit(user, 'portal_quarto_removido', { reserva: ex.reservation_number, quarto: ex.room, motivo: body && body.reason }, ip);
  return { ok: true };
});

module.exports = { scope };
