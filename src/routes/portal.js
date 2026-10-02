'use strict';
/*
 * Portal do Comercial (perfil "agencia" no banco, exibido como "Comercial").
 * Usado pela equipe comercial para validar quartos e trocas de todas as reservas. Pode:
 *  - enviar o ROOMING LIST (planilha ou digitado): nomes dos hóspedes de cada quarto e quantidade de pessoas;
 *  - trocar quarto, ajustar nome, datas e pessoas de um quarto;
 *  - incluir quarto no grupo e remover quarto/hóspede.
 * A pensão não muda por aqui. Toda alteração fica no log e avisa o setor de refeições e a recepção.
 */
const { route, HttpError } = require('../http');
const { db, tx, audit, notify, maxPaxRoom } = require('../db');
const { roomKey, normRoom, normKey, toInt, todayISO, addDays, toCSV, roomError, canonRoom } = require('../util');
const { syncReservation, syncMany } = require('../meals');
const { normalizeRecord, splitReservation } = require('../importer');
const { readSpreadsheet } = require('../xlsx');
const { stayPlan } = require('./reservations');

const PORTAL = ['admin', 'refeicao', 'agencia'];

// O rooming list é só para GRUPOS: reservas com 2 ou mais apartamentos (sem vínculo a uma agência)
const GROUP_SQL = `r.reservation_number IN (SELECT reservation_number FROM reservations GROUP BY reservation_number HAVING COUNT(*) >= 2)`;
function scope() {
  return { sql: GROUP_SQL, args: [] };
}

function getOwn(user, id) {
  const sc = scope(user);
  const r = db.prepare(`SELECT * FROM reservations r WHERE r.id = ? AND ${sc.sql}`).get(id, ...sc.args);
  if (!r) throw new HttpError(404, 'Reserva não encontrada entre os grupos. O rooming list vale apenas para reservas de grupo.');
  return r;
}

const who = (user) => `Comercial (${user.name})`;
const cleanGuests = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n|;/)).map((x) => String(x).trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 20);
const guestsText = (v) => cleanGuests(v).join('\n');

// Reservas ativas (em andamento ou futuras) da agência, com os quartos
function agencyReservations(user) {
  const sc = scope();
  const rows = db.prepare(`SELECT r.* FROM reservations r WHERE ${sc.sql} AND r.checkout >= ? ORDER BY r.checkin, r.reservation_number, room_sort(r.room)`)
    .all(...sc.args, addDays(todayISO(), -1));
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.reservation_number)) map.set(r.reservation_number, { reservation_number: r.reservation_number, name: r.guest_name, rooms: [] });
    map.get(r.reservation_number).rooms.push(r);
  }
  return [...map.values()];
}

function roomTaken(roomTxt, checkin, checkout, exceptId = 0) {
  return db.prepare(`SELECT reservation_number FROM reservations WHERE id != ? AND status = 'ativa' AND room_key(room) = ? AND checkin < ? AND checkout > ?`)
    .get(exceptId, roomKey(roomTxt), checkout, checkin);
}

// Modelo do grupo para um quarto novo: pensão, datas e nome mais comuns entre os quartos da reserva
function groupTemplate(rooms) {
  const act = rooms.filter((r) => r.status === 'ativa');
  const base = act.length ? act : rooms;
  const count = (f) => { const m = new Map(); for (const r of base) m.set(f(r), (m.get(f(r)) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
  const dates = count((r) => `${r.checkin}|${r.checkout}`).split('|');
  return { board: count((r) => r.board), checkin: dates[0], checkout: dates[1], guest_name: base[0].guest_name, lunch_on_arrival: base[0].lunch_on_arrival };
}

/*
 * Confere uma lista de quartos (vinda da planilha ou digitada) contra as reservas da agência.
 * groups: [{ reservation_number?, room, names: [], adults?, children? }]
 */
function matchRooming(user, groups, defaultRes = '') {
  const resv = agencyReservations(user);
  const def = defaultRes ? splitReservation(defaultRes).number : '';
  const byNum = new Map(resv.map((r) => [r.reservation_number, r]));
  const items = [];
  const touched = new Set();
  const seen = new Set();
  for (const g of groups) {
    const sheetRes = g.reservation_number ? splitReservation(g.reservation_number).number : '';
    const it = { sheet_reservation: sheetRes, reservation_number: sheetRes || def, room: normRoom(g.room), names: cleanGuests(g.names), adults: g.adults, children: g.children, line: g.line };
    const errs = [];
    const re = roomError(it.room);
    if (re) errs.push(re); else it.room = canonRoom(it.room);
    // pax: o que veio informado; senão, a quantidade de nomes
    const informed = Number.isFinite(it.adults) || Number.isFinite(it.children);
    if (!informed) { it.adults = Math.max(0, it.names.length - (g.childCount || 0)); it.children = g.childCount || 0; }
    it.adults = Math.max(0, toInt(it.adults, 0)); it.children = Math.max(0, toInt(it.children, 0));
    if (it.adults + it.children === 0) errs.push('sem hóspedes nem quantidade de pessoas');
    const max = maxPaxRoom();
    if (it.adults + it.children > max || it.names.length > max) errs.push(`${Math.max(it.adults + it.children, it.names.length)} pessoas no apartamento; a política do resort é de no máximo ${max} por apartamento`);
    // encontra o quarto
    let found = null;
    if (it.reservation_number) {
      const R = byNum.get(it.reservation_number);
      if (!R) errs.push(`a reserva ${it.reservation_number} não é um grupo ativo (não encontrada, encerrada ou com um só apartamento)`);
      else found = R.rooms.find((x) => roomKey(x.room) === roomKey(it.room)) || null;
    } else if (it.room) {
      const all = resv.flatMap((R) => R.rooms.filter((x) => roomKey(x.room) === roomKey(it.room)));
      const act = all.filter((x) => x.status === 'ativa');
      const pick = act.length ? act : all;
      if (pick.length === 1) { found = pick[0]; it.reservation_number = found.reservation_number; }
      else if (pick.length > 1) errs.push('o apartamento consta em mais de uma reserva; selecione a reserva do rooming list');
      else if (resv.length === 1) it.reservation_number = resv[0].reservation_number;
      else it.needs_reservation = true;
    }
    const k = `${it.reservation_number}|${roomKey(it.room)}`;
    if (it.room && seen.has(k)) errs.push('apartamento repetido na lista');
    seen.add(k);
    if (found) {
      it.id = found.id;
      it.old = { adults: found.adults, children: found.children, guests: cleanGuests(found.guests), status: found.status };
      const same = found.status === 'ativa' && found.adults === it.adults && found.children === it.children && guestsText(found.guests) === guestsText(it.names);
      it.action = same ? 'igual' : 'atualizar';
      if (found.status !== 'ativa') it.reactivate = true;
      touched.add(found.reservation_number);
    } else if (!errs.length && !it.needs_reservation) {
      const R = byNum.get(it.reservation_number);
      const t = groupTemplate(R.rooms);
      const taken = roomTaken(it.room, t.checkin, t.checkout);
      if (taken) errs.push(`o apartamento ${it.room} está ocupado nestas datas por outra reserva`);
      it.action = 'novo';
      it.template = t;
      touched.add(it.reservation_number);
    }
    if (errs.length) { it.action = 'erro'; it.errors = errs; }
    items.push(it);
  }
  // quartos ativos das reservas da lista que não vieram nela
  const listed = new Set(items.filter((i) => i.id).map((i) => i.id));
  const missing = resv.filter((R) => touched.has(R.reservation_number))
    .flatMap((R) => R.rooms.filter((x) => x.status === 'ativa' && !listed.has(x.id) && x.checkout >= todayISO()))
    .map((x) => ({ id: x.id, reservation_number: x.reservation_number, room: x.room, adults: x.adults, children: x.children, guests: cleanGuests(x.guests) }));
  return {
    items, missing,
    reservations: resv.map((R) => ({ reservation_number: R.reservation_number, name: R.name, rooms: R.rooms.filter((x) => x.status === 'ativa').length, checkin: groupTemplate(R.rooms).checkin, checkout: groupTemplate(R.rooms).checkout })),
  };
}

// ---------- Leitura da planilha de rooming list ----------
const RL = {
  reservation: ['reserva', 'nreserva', 'numeroreserva', 'numerodareserva', 'localizador', 'codreserva', 'voucher', 'reservation'],
  room: ['quarto', 'apto', 'apartamento', 'uh', 'room', 'nquarto', 'numeroquarto', 'numerodoquarto', 'acomodacao', 'roomnumber'],
  name: ['nome', 'nomecompleto', 'hospede', 'hospedes', 'nomehospede', 'nomedohospede', 'passageiro', 'passageiros', 'nomepassageiro', 'nomedopassageiro', 'cliente', 'guest', 'guestname', 'name', 'nomedopax', 'nomepax', 'paxnome', 'participante'],
  adults: ['adultos', 'adulto', 'adt', 'qtdadultos', 'adults'],
  children: ['criancas', 'crianca', 'chd', 'chds', 'qtdcriancas', 'children'],
  pax: ['pax', 'pessoas', 'qtdpessoas', 'totalpax', 'qtdpax'],
  age: ['idade', 'age', 'anos'],
  type: ['tipo', 'faixa', 'faixaetaria', 'categoria', 'tipopax', 'adtchd'],
};
const CHILD_AGE = 11; // até 11 anos = criança

function parseRooming(rows) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const keys = (rows[i] || []).map((v) => normKey(v));
    const map = {};
    for (const [f, names] of Object.entries(RL)) {
      const idx = keys.findIndex((k, j) => k && names.includes(k) && !Object.values(map).includes(j));
      if (idx >= 0) map[f] = idx;
    }
    // "Nome do hóspede", "Hóspede 1"... por aproximação
    if (map.name === undefined) { const idx = keys.findIndex((k, j) => /^(nome|hospede|passageiro)/.test(k) && !Object.values(map).includes(j)); if (idx >= 0) map.name = idx; }
    if (map.room === undefined) { const idx = keys.findIndex((k, j) => /(quarto|apto|apartamento)/.test(k) && !Object.values(map).includes(j)); if (idx >= 0) map.room = idx; }
    const score = Object.keys(map).length;
    if (map.room !== undefined && (!best || score > best.score)) best = { i, map, score };
  }
  if (!best) throw new HttpError(400, 'Não foi encontrada a coluna do apartamento (Apartamento/Quarto/Apto/UH). Utilize o modelo de rooming list.');
  const { map } = best;
  // coluna "Pax" com nomes em vez de números
  if (map.name === undefined && map.pax !== undefined) {
    const vals = rows.slice(best.i + 1, best.i + 30).map((r) => (r || [])[map.pax]).filter((v) => v !== null && v !== undefined && v !== '');
    if (vals.length && vals.filter((v) => /[a-zA-Z]{2,}/.test(String(v))).length > vals.length / 2) { map.name = map.pax; delete map.pax; }
  }
  if (map.name === undefined && map.adults === undefined && map.pax === undefined) throw new HttpError(400, 'Não encontrei a coluna com o nome dos hóspedes (Nome/Hóspede/Passageiro).');
  const groups = new Map();
  let lastRoom = '', lastRes = '';
  for (let i = best.i + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const get = (f) => (map[f] === undefined ? null : r[map[f]]);
    let room = get('room'), res = get('reservation'), name = get('name');
    const empty = (v) => v === null || v === undefined || String(v).trim() === '';
    if (empty(room) && empty(name) && empty(get('adults')) && empty(get('pax'))) continue;
    // células mescladas: quarto/reserva só na primeira linha do quarto
    if (empty(room)) room = lastRoom; else lastRoom = String(room);
    if (empty(res)) res = lastRes; else lastRes = String(res);
    if (empty(room)) continue;
    const key = `${res ? splitReservation(res).number : ''}|${roomKey(room)}`;
    if (!groups.has(key)) groups.set(key, { reservation_number: res ? String(res) : '', room: String(room), names: [], childCount: 0, line: i + 1, rows: 0, adults: undefined, children: undefined });
    const g = groups.get(key);
    g.rows++;
    if (!empty(name)) {
      g.names.push(String(name));
      const age = get('age'), type = String(get('type') ?? '');
      const ageN = typeof age === 'number' ? age : parseInt(String(age ?? '').replace(/\D/g, ''), 10);
      const chdMark = map.children !== undefined && map.adults === undefined && /^(x|s|sim|1|chd|crianca|criança)$/i.test(String(get('children') ?? '').trim());
      if ((Number.isFinite(ageN) && ageN <= CHILD_AGE) || /chd|crian|child|inf|cnn/i.test(type) || chdMark) g.childCount++;
    }
    // quantidades informadas (somam se o quarto vier em várias linhas)
    const nA = get('adults'), nC = get('children'), nP = get('pax');
    const isNum = (v) => !empty(v) && /^\d+$/.test(String(v).trim());
    if (map.adults !== undefined && isNum(nA)) g.adults = (g.adults || 0) + toInt(nA, 0);
    if (map.adults !== undefined && map.children !== undefined && isNum(nC)) g.children = (g.children || 0) + toInt(nC, 0);
    if (map.adults === undefined && isNum(nP)) { g.paxTotal = (g.paxTotal || 0) + toInt(nP, 0); }
  }
  return [...groups.values()].map((g) => {
    if (g.adults === undefined && g.paxTotal !== undefined && g.rows === 1) { g.adults = Math.max(0, g.paxTotal - g.childCount); g.children = g.childCount; }
    if (g.adults !== undefined && g.children === undefined) g.children = g.childCount;
    return g;
  });
}

// ---------- Rotas ----------
route('GET', '/api/portal/reservations', { roles: PORTAL }, ({ query }) => {
  const where = [], args = [];
  const q = String(query.q || '').trim();
  if (q) {
    const { roomMatch } = require('../util');
    const rm = roomMatch('r.room', q);
    where.push(`(r.reservation_number = ? OR norm_txt(r.guest_name) LIKE '%' || norm_txt(?) || '%' OR norm_txt(r.guests) LIKE '%' || norm_txt(?) || '%' OR ${rm.sql})`);
    args.push(q.replace(/\./g, ''), q, q, ...rm.args);
  }
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDays(todayISO(), -1);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : addDays(todayISO(), 30);
  // reservas com qualquer quarto hospedado no período (traz o grupo inteiro)
  where.push(`r.reservation_number IN (SELECT reservation_number FROM reservations WHERE checkout >= ? AND checkin <= ?)`, GROUP_SQL);
  args.push(from, to);
  if (query.status !== 'todas') where.push("r.status = 'ativa'");
  const rows = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM room_changes c WHERE c.reservation_id = r.id) room_changes,
      (SELECT COUNT(*) FROM room_changes c WHERE c.reservation_id = r.id AND c.validated_at IS NULL) room_changes_pending
    FROM reservations r WHERE ${where.join(' AND ')} ORDER BY r.checkin, r.reservation_number, room_sort(r.room) LIMIT 3000`).all(...args);
  return { rows, today: todayISO(), from, to };
});

route('GET', '/api/portal/reservations/:id', { roles: PORTAL }, ({ user, params }) => {
  const r = getOwn(user, params.id);
  return { reservation: r, plan: stayPlan(r) };
});

route('PUT', '/api/portal/reservations/:id', { roles: PORTAL }, ({ user, params, body, ip }) => {
  const ex = getOwn(user, params.id);
  if (ex.status !== 'ativa') throw new HttpError(409, 'Este apartamento foi removido da reserva. Contate o resort para reativá-lo.');
  if (ex.checkout < todayISO()) throw new HttpError(409, 'Estadia encerrada; não é possível alterar.');
  // campos liberados para a agência (a pensão e o número da reserva não mudam por aqui)
  const allowed = ['room', 'checkin', 'checkout', 'adults', 'children'];
  const patch = Object.fromEntries(allowed.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const { rec, errors } = normalizeRecord({ ...ex, ...patch, reservation_number: ex.reservation_number, board: ex.board });
  if (errors.length) throw new HttpError(400, 'Verifique: ' + errors.join(', '));
  const guests = body.guests === undefined ? ex.guests : guestsText(body.guests);
  if (cleanGuests(guests).length > maxPaxRoom()) throw new HttpError(400, `A política do resort é de no máximo ${maxPaxRoom()} pessoas por apartamento.`);
  if (roomKey(rec.room) !== roomKey(ex.room)) {
    if (roomTaken(rec.room, rec.checkin, rec.checkout, ex.id)) throw new HttpError(409, `O apartamento ${rec.room} já está ocupado nestas datas. Confirme o número com a recepção.`);
  }
  const diff = Object.fromEntries(allowed.filter((k) => (k === 'room' ? roomKey(ex.room) !== roomKey(rec.room) : String(ex[k]) !== String(rec[k]))).map((k) => [k, [ex[k], rec[k]]]));
  if (guests !== ex.guests) diff.guests = [ex.guests, guests];
  if (!Object.keys(diff).length) return { ok: true, changed: false };
  tx(() => {
    if (diff.room) {
      db.prepare('INSERT INTO room_changes(reservation_id, old_room, new_room, source, user_id) VALUES (?,?,?,?,?)').run(ex.id, ex.room, rec.room, 'agencia', user.id);
      for (const role of ['recepcao', 'restaurante', 'refeicao']) {
        notify({ role, kind: 'room_change', title: `Troca de apartamento: ${ex.room} → ${rec.room}`, body: `${ex.guest_name} (reserva ${ex.reservation_number}) · realizada por ${who(user)}`, link: '#/trocas' });
      }
    }
    db.prepare(`UPDATE reservations SET room=?, checkin=?, checkout=?, adults=?, children=?, guests=?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(rec.room, rec.checkin, rec.checkout, rec.adults, rec.children, guests, ex.id);
    syncReservation(ex.id);
    const other = Object.keys(diff).filter((k) => k !== 'room' && k !== 'guests');
    if (other.length) {
      const labels = { checkin: 'entrada', checkout: 'saída', adults: 'adultos', children: 'crianças' };
      for (const role of ['refeicao', 'recepcao']) {
        notify({ role, kind: 'portal_change', title: `${who(user)} alterou a reserva ${ex.reservation_number}`, body: `Apartamento ${rec.room}: ${other.map((k) => `${labels[k]} ${diff[k][0]} → ${diff[k][1]}`).join(' · ')}`, link: '#/reservas' });
      }
    }
  });
  audit(user, 'portal_reserva_alterada', { reserva: ex.reservation_number, quarto: ex.room, diff }, ip);
  return { ok: true, changed: true };
});

// Remover quarto/hóspede (ex.: troca em que o quarto sai do grupo)
route('POST', '/api/portal/reservations/:id/remove', { roles: PORTAL }, ({ user, params, body, ip }) => {
  const ex = getOwn(user, params.id);
  if (ex.status !== 'ativa') return { ok: true };
  if (ex.checkout < todayISO()) throw new HttpError(409, 'Estadia encerrada; não é possível remover.');
  removeRoom(user, ex, body && body.reason);
  audit(user, 'portal_quarto_removido', { reserva: ex.reservation_number, quarto: ex.room, motivo: body && body.reason }, ip);
  return { ok: true };
});

function removeRoom(user, ex, reason, quiet = false) {
  tx(() => {
    db.prepare("UPDATE reservations SET status = 'cancelada', notes = trim(coalesce(notes, '') || ' ' || ?), updated_at = datetime('now','localtime') WHERE id = ?")
      .run(`[removido por ${who(user)}${reason ? ': ' + String(reason).slice(0, 200) : ''}]`, ex.id);
    syncReservation(ex.id);
    if (!quiet) for (const role of ['refeicao', 'recepcao', 'restaurante']) {
      notify({ role, kind: 'portal_remove', title: `Apartamento ${ex.room} removido da reserva ${ex.reservation_number}`, body: `${ex.guest_name} · ${ex.adults + ex.children} pessoa(s) · realizado por ${who(user)}${reason ? ` · motivo: ${String(reason).slice(0, 120)}` : ''}`, link: '#/reservas' });
    }
  });
}

// Grava a lista conferida: atualiza nomes/pax, inclui quartos novos no grupo e remove os marcados
function applyRooming(user, groups, removeIds, ip, source, defaultRes = '') {
  const m = matchRooming(user, groups, defaultRes);
  const bad = m.items.filter((i) => i.action === 'erro' || i.needs_reservation);
  if (bad.length) throw new HttpError(400, `Corrija ${bad.length} apartamento(s) com erro antes do envio.`, { items: m.items });
  const result = { updated: 0, created: 0, unchanged: 0, removed: 0, paxChanges: [] };
  const ids = [];
  tx(() => {
    for (const it of m.items) {
      const guests = guestsText(it.names);
      if (it.action === 'igual') { result.unchanged++; continue; }
      if (it.action === 'atualizar') {
        db.prepare(`UPDATE reservations SET guests = ?, adults = ?, children = ?, status = 'ativa', updated_at = datetime('now','localtime') WHERE id = ?`).run(guests, it.adults, it.children, it.id);
        if (it.old.adults !== it.adults || it.old.children !== it.children || it.reactivate) result.paxChanges.push(`${it.room}: ${it.old.adults}+${it.old.children} → ${it.adults}+${it.children}`);
        result.updated++; ids.push(it.id);
      } else if (it.action === 'novo') {
        const t = it.template;
        const r = db.prepare(`INSERT INTO reservations(reservation_number, guest_name, checkin, checkout, room, board, adults, children, source, lunch_on_arrival, guests)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(it.reservation_number, t.guest_name, t.checkin, t.checkout, it.room, t.board, it.adults, it.children, 'agencia', t.lunch_on_arrival ? 1 : 0, guests);
        result.created++; ids.push(Number(r.lastInsertRowid));
        result.paxChanges.push(`${it.room}: apartamento incluído (${it.adults} adulto(s) e ${it.children} criança(s))`);
      }
    }
  });
  const allowedRemove = new Set(m.missing.map((x) => x.id));
  for (const id of removeIds || []) {
    if (!allowedRemove.has(Number(id))) continue;
    const ex = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    removeRoom(user, ex, 'não veio no rooming list', true);
    result.removed++; result.paxChanges.push(`${ex.room}: removido`);
  }
  if (ids.length) syncMany(ids);
  if (result.updated || result.created || result.removed) {
    const nums = [...new Set(m.items.map((i) => i.reservation_number))].join(', ');
    const body = `${result.updated} atualizado(s), ${result.created} novo(s), ${result.removed} removido(s)` + (result.paxChanges.length ? ` · ${result.paxChanges.slice(0, 8).join(' · ')}${result.paxChanges.length > 8 ? ' …' : ''}` : '');
    for (const role of ['refeicao', 'recepcao']) notify({ role, kind: 'rooming', title: `${who(user)} enviou rooming list (reserva ${nums})`, body, link: '#/reservas' });
    if (result.created || result.removed || result.paxChanges.length) notify({ role: 'restaurante', kind: 'rooming', title: `Rooming list atualizado: reserva ${nums}`, body, link: '#/servico' });
  }
  audit(user, 'portal_rooming_list', { origem: source, quartos: m.items.length, ...result }, ip);
  return result;
}

route('POST', '/api/portal/rooming/preview', { roles: PORTAL, raw: 10 * 1024 * 1024 }, ({ user, body, req }) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  let rows;
  try { rows = readSpreadsheet(body, filename); } catch (e) { throw new HttpError(400, e.message); }
  const groups = parseRooming(rows);
  if (!groups.length) throw new HttpError(400, 'Nenhum apartamento foi encontrado na planilha.');
  return { filename, ...matchRooming(user, groups, req.headers['x-reservation'] ? decodeURIComponent(req.headers['x-reservation']) : '') };
});

// Conferência de uma lista digitada/ajustada na tela
route('POST', '/api/portal/rooming/check', { roles: PORTAL }, ({ user, body }) => matchRooming(user, Array.isArray(body.groups) ? body.groups : [], body.reservation_number || ''));

route('POST', '/api/portal/rooming/commit', { roles: PORTAL, raw: 5 * 1024 * 1024 }, ({ user, body, ip }) => {
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido.'); }
  const groups = (data.groups || []).map((g) => ({ reservation_number: g.reservation_number, room: g.room, names: g.names, adults: g.adults, children: g.children }));
  if (!groups.length && !(data.remove_ids || []).length) throw new HttpError(400, 'Nada para enviar.');
  return applyRooming(user, groups, data.remove_ids, ip, data.filename ? 'planilha' : 'digitado', data.reservation_number || '');
});

// Incluir um quarto no grupo (digitado)
route('POST', '/api/portal/rooms', { roles: PORTAL }, ({ user, body, ip }) => {
  const g = { reservation_number: body.reservation_number, room: body.room, names: body.guests, adults: body.adults === '' ? undefined : Number(body.adults), children: body.children === '' ? undefined : Number(body.children) };
  const m = matchRooming(user, [g]);
  const it = m.items[0];
  if (it.action === 'erro') throw new HttpError(400, it.errors.join('; '));
  if (it.action !== 'novo') throw new HttpError(409, 'Este apartamento já consta na reserva. Utilize “Alterar” para modificar os hóspedes.');
  return applyRooming(user, [g], [], ip, 'digitado');
});

route('GET', '/api/portal/groups', { roles: PORTAL }, ({ user }) => agencyReservations(user).map((R) => ({
  reservation_number: R.reservation_number, name: R.name, rooms: R.rooms.filter((x) => x.status === 'ativa').length,
  checkin: groupTemplate(R.rooms).checkin, checkout: groupTemplate(R.rooms).checkout,
})));

route('GET', '/api/portal/rooming/modelo.csv', { roles: PORTAL }, () => ({
  __raw: toCSV(['Reserva', 'Apartamento', 'Nome do hóspede', 'Idade'], [
    ['55778', '201A', 'Maria da Silva', ''],
    ['55778', '201A', 'João da Silva', ''],
    ['55778', '201A', 'Pedro da Silva', 8],
    ['55778', '202B', 'Ana Souza', ''],
    ['55778', '202B', 'Carla Souza', ''],
  ]),
  headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="modelo-rooming-list.csv"' },
}));

module.exports = { scope, parseRooming, matchRooming };
