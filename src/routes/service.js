'use strict';
const { route, HttpError } = require('../http');
const { db, tx, audit } = require('../db');
const { MEALS, MEAL_LABEL, isISODate, todayISO, toCSV, BOARDS, roomMatch, roomKey, roomSort: roomSortKey, addDays } = require('../util');
const { buildXlsx, colName } = require('../xlsx-write');
const { daySummary, rebalance, isPublished, boardHas, inWindow, isEligible, restaurantsFor, weekday } = require('../meals');
const { publishList, currentMeal } = require('../publish');
const { restMap } = require('./reservations');

const MANAGE = ['admin', 'refeicao'];
const VIEW = ['admin', 'supervisor', 'refeicao', 'recepcao'];
const SERVICE = ['admin', 'refeicao', 'restaurante'];

function dayMeal(query) {
  const cur = currentMeal();
  const date = isISODate(query.date) ? query.date : cur.date;
  const meal = MEALS.includes(query.meal) ? query.meal : cur.meal;
  return { date, meal };
}

function restaurantFor(user, requested) {
  if (user.role === 'restaurante') {
    if (!user.restaurant_id) throw new HttpError(400, 'Seu usuário não está vinculado a um restaurante. Fale com o administrador.');
    return user.restaurant_id;
  }
  const id = Number(requested);
  if (!id) throw new HttpError(400, 'Informe o restaurante.');
  return id;
}

// ---------- Painel ----------
route('GET', '/api/dashboard', ({ query }) => {
  const date = isISODate(query.date) ? query.date : todayISO();
  const meals = db.prepare('SELECT * FROM meal_times ORDER BY sort').all().map((t) => ({
    ...t, published: isPublished(date, t.meal), restaurants: daySummary(date, t.meal),
  }));
  const inhouse = db.prepare(`SELECT COUNT(*) reservas, COALESCE(SUM(adults),0) adults, COALESCE(SUM(children),0) children
    FROM reservations WHERE status = 'ativa' AND checkin <= ? AND checkout >= ?`).get(date, date);
  const arrivals = db.prepare("SELECT COUNT(*) n FROM reservations WHERE status = 'ativa' AND checkin = ?").get(date).n;
  const departures = db.prepare("SELECT COUNT(*) n FROM reservations WHERE status = 'ativa' AND checkout = ?").get(date).n;
  const boards = db.prepare(`SELECT board, COUNT(*) n, SUM(adults + children) pax FROM reservations
    WHERE status = 'ativa' AND checkin <= ? AND checkout >= ? GROUP BY board`).all(date, date);
  const roomChanges = db.prepare(`SELECT c.*, r.guest_name, r.reservation_number FROM room_changes c JOIN reservations r ON r.id = c.reservation_id
    ORDER BY c.id DESC LIMIT 8`).all();
  return { date, current: currentMeal(), meals, inhouse, arrivals, departures, boards, roomChanges };
});

// ---------- Distribuição ----------
route('GET', '/api/distribution', { roles: VIEW }, ({ query }) => {
  const { date, meal } = dayMeal(query);
  const rows = db.prepare(`
    SELECT a.id assignment_id, a.restaurant_id, a.locked, a.origin, r.id reservation_id, r.reservation_number, r.guest_name, r.room,
      r.board, r.adults, r.children, t.restaurant_id att_restaurant_id, t.status att_status
    FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    LEFT JOIN attendance t ON t.reservation_id = a.reservation_id AND t.date = a.date AND t.meal = a.meal
    WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa' ORDER BY room_sort(r.room)`).all(date, meal);
  const pub = db.prepare('SELECT m.*, u.name published_by_name FROM meal_lists m LEFT JOIN users u ON u.id = m.published_by WHERE date = ? AND meal = ?').get(date, meal);
  return { date, meal, published: pub || null, summary: daySummary(date, meal), rows };
});

route('POST', '/api/distribution/rebalance', { roles: MANAGE }, ({ body, user, ip }) => {
  const { date, meal } = dayMeal(body);
  const r = rebalance(date, meal);
  audit(user, 'distribuicao_refeita', { date, meal, movidos: r.moved }, ip);
  return r;
});

// Move o GRUPO inteiro (todos os quartos da reserva nesse dia/refeição), exceto quem já foi marcado.
// Com body.only_room = true move só aquele quarto.
route('POST', '/api/distribution/move', { roles: MANAGE }, ({ body, user, ip }) => {
  const a = db.prepare('SELECT a.*, r.reservation_number FROM assignments a JOIN reservations r ON r.id = a.reservation_id WHERE a.id = ?').get(body.assignment_id);
  if (!a) throw new HttpError(404, 'Registro não encontrado.');
  const rest = db.prepare(`SELECT * FROM restaurants WHERE id = ? AND active = 1`).get(body.restaurant_id);
  if (!rest) throw new HttpError(400, 'Restaurante inválido.');
  if (!restaurantsFor(a.meal, a.date).find((x) => x.id === rest.id)) throw new HttpError(400, `${rest.name} não serve ${MEAL_LABEL[a.meal].toLowerCase()} nesse dia.`);
  if (db.prepare('SELECT 1 FROM attendance WHERE reservation_id = ? AND date = ? AND meal = ?').get(a.reservation_id, a.date, a.meal)) {
    throw new HttpError(409, 'Este cliente já foi marcado; não é possível mudar o restaurante.');
  }
  const targets = body.only_room ? [a] : db.prepare(`SELECT a.* FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE r.reservation_number = ? AND a.date = ? AND a.meal = ? AND r.status = 'ativa'
    AND NOT EXISTS (SELECT 1 FROM attendance t WHERE t.reservation_id = a.reservation_id AND t.date = a.date AND t.meal = a.meal)`).all(a.reservation_number, a.date, a.meal);
  const up = db.prepare("UPDATE assignments SET restaurant_id = ?, locked = 1, origin = 'manual' WHERE id = ?");
  tx(() => { for (const t of targets) up.run(rest.id, t.id); });
  audit(user, 'cliente_movido', { reserva: a.reservation_number, quartos: targets.length, date: a.date, meal: a.meal, de: a.restaurant_id, para: rest.id }, ip);
  return { ok: true, moved: targets.length };
});

route('POST', '/api/distribution/unlock', { roles: MANAGE }, ({ body }) => {
  const a = db.prepare('SELECT a.*, r.reservation_number FROM assignments a JOIN reservations r ON r.id = a.reservation_id WHERE a.id = ?').get(body.assignment_id);
  if (!a) throw new HttpError(404, 'Registro não encontrado.');
  db.prepare(`UPDATE assignments SET locked = 0 WHERE date = ? AND meal = ? AND reservation_id IN (SELECT id FROM reservations WHERE reservation_number = ?)`).run(a.date, a.meal, a.reservation_number);
  return { ok: true };
});

route('POST', '/api/distribution/publish', { roles: MANAGE }, ({ body, user }) => {
  const { date, meal } = dayMeal(body);
  return publishList(date, meal, user, false);
});

route('GET', '/api/distribution/export.csv', { roles: [...VIEW, 'restaurante'] }, ({ query, user }) => {
  const { date, meal } = dayMeal(query);
  let restId = query.restaurant_id ? Number(query.restaurant_id) : null;
  if (user.role === 'restaurante') restId = user.restaurant_id;
  const rm = restMap();
  const rows = db.prepare(`SELECT a.restaurant_id, r.* FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE a.date = ? AND a.meal = ? AND r.status = 'ativa' ${restId ? 'AND a.restaurant_id = ' + restId : ''}
    ORDER BY a.restaurant_id, room_sort(r.room)`).all(date, meal);
  return {
    __raw: toCSV(['Restaurante', 'Quarto', 'Nome', 'Reserva', 'Pensão', 'Adultos', 'Crianças', 'Pax'],
      rows.map((r) => [rm[r.restaurant_id].name, r.room, r.guest_name, r.reservation_number, r.board, r.adults, r.children, r.adults + r.children])),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="lista-${meal}-${date}.csv"` },
  };
});

// Planilha de divisão no formato usado pelo resort (uma coluna por refeição/restaurante/dia)
const WEEKDAY = ['DOMINGO', 'SEGUNDA-FEIRA', 'TERÇA-FEIRA', 'QUARTA-FEIRA', 'QUINTA-FEIRA', 'SEXTA-FEIRA', 'SÁBADO'];
const MEAL_UP = { cafe: 'CAFÉ DA MANHÃ', almoco: 'ALMOÇO', janta: 'JANTAR' };
route('GET', '/api/distribution/export.xlsx', { roles: [...VIEW] }, ({ query, user, ip }) => {
  const from = isISODate(query.from) ? query.from : todayISO();
  let to = isISODate(query.to) ? query.to : addDays(from, 4);
  if (to < from) to = from;
  if (to > addDays(from, 31)) to = addDays(from, 31);
  const rests = db.prepare('SELECT * FROM restaurants WHERE active = 1 ORDER BY id').all();
  const asg = db.prepare(`SELECT a.reservation_id, a.date, a.meal, a.restaurant_id, r.adults + r.children pax FROM assignments a
    JOIN reservations r ON r.id = a.reservation_id WHERE r.status = 'ativa' AND a.date BETWEEN ? AND ?`).all(from, to);
  const cell = new Map(); const slotTot = new Map(); const colTot = new Map();
  for (const a of asg) {
    cell.set(`${a.reservation_id}|${a.date}|${a.meal}`, a);
    slotTot.set(`${a.date}|${a.meal}`, (slotTot.get(`${a.date}|${a.meal}`) || 0) + a.pax);
    colTot.set(`${a.date}|${a.meal}|${a.restaurant_id}`, (colTot.get(`${a.date}|${a.meal}|${a.restaurant_id}`) || 0) + a.pax);
  }
  const cols = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const meal of MEALS) {
      if (!slotTot.get(`${d}|${meal}`)) continue;
      const open = restaurantsFor(meal, d);
      const shareSum = open.reduce((s, r) => s + r.share, 0) || 1;
      for (const r of rests) {
        const isOpen = open.find((x) => x.id === r.id);
        if (!isOpen && !colTot.get(`${d}|${meal}|${r.id}`)) continue;
        const [, mm, dd] = d.split('-');
        cols.push({ date: d, meal, rest: r, title: `${MEAL_UP[meal]} ${r.name.toUpperCase()} ${WEEKDAY[weekday(d)]} ${dd}/${mm}`,
          meta: isOpen ? Math.round(slotTot.get(`${d}|${meal}`) * isOpen.share / shareSum) : null });
      }
    }
  }
  const resIds = [...new Set(asg.map((a) => a.reservation_id))];
  const resv = resIds.length ? db.prepare(`SELECT * FROM reservations WHERE id IN (${resIds.map(() => '?').join(',')})`).all(...resIds) : [];
  resv.sort((a, b) => a.checkin.localeCompare(b.checkin) || String(a.reservation_number).localeCompare(String(b.reservation_number), 'pt-BR', { numeric: true }) || roomSortKey(a.room).localeCompare(roomSortKey(b.room)));
  const brd = (iso) => iso.split('-').reverse().join('/');
  const FIRST = 7, HEAD = 3;
  const rows = [];
  rows[0] = [{ v: 'RESORT TERMAS ROMANAS', s: 1 }, null, null, null, null, null, null, ...cols.map((c) => ({ v: c.title, s: 2 }))];
  rows[1] = [null, null, null, null, null, null, null, ...cols.map((c) => (c.meta === null ? { v: null, s: 6 } : { v: c.meta, s: 6 }))];
  const last = HEAD + resv.length;
  rows[2] = [...['Reserva', 'Entrada', 'Saída', 'Pensão', 'Apto', 'Pax', 'Chd'].map((v) => ({ v, s: 3 })),
    ...cols.map((c, i) => ({ f: `SUM(${colName(FIRST + i)}${HEAD + 1}:${colName(FIRST + i)}${Math.max(last, HEAD + 1)})`, v: colTot.get(`${c.date}|${c.meal}|${c.rest.id}`) || 0, s: 4 }))];
  for (const r of resv) {
    const label = /^Reserva \d/.test(r.guest_name) ? r.reservation_number : `${r.reservation_number} ${r.guest_name}`;
    rows.push([label, brd(r.checkin), brd(r.checkout), { v: r.board, s: 5 }, { v: r.room, s: 5 }, { v: r.adults + r.children, s: 5 }, { v: r.children || '-', s: 5 },
      ...cols.map((c) => { const a = cell.get(`${r.id}|${c.date}|${c.meal}`); return a && a.restaurant_id === c.rest.id ? { v: a.pax, s: 5 } : { v: null, s: 5 }; })]);
  }
  const buf = buildXlsx({
    name: `${brd(from).slice(0, 5)} a ${brd(to).slice(0, 5)}`.replace(/\//g, '-'),
    rows, merges: ['A1:G2'], freeze: { row: 3, col: 7 }, heights: { 0: 58 },
    cols: [30, 11, 11, 7, 7, 5, 5, ...cols.map(() => 12)],
  });
  audit(user, 'planilha_divisao_exportada', { from, to, quartos: resv.length }, ip);
  const fname = `DIVISAO_${brd(from).slice(0, 5).replace('/', '-')}_a_${brd(to).slice(0, 5).replace('/', '-')}.xlsx`;
  return { __raw: buf, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fname}"` } };
});

// ---------- Serviço no restaurante ----------
route('GET', '/api/service', { roles: SERVICE }, ({ query, user }) => {
  const { date, meal } = dayMeal(query);
  const restId = restaurantFor(user, query.restaurant_id);
  const rest = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restId);
  if (!rest) throw new HttpError(404, 'Restaurante não encontrado.');
  const rm = restMap();
  const list = db.prepare(`
    SELECT r.id reservation_id, r.reservation_number, r.guest_name, r.room, r.board, r.adults, r.children,
      t.id attendance_id, t.restaurant_id att_restaurant_id, t.status att_status, t.created_at att_at, t.adults att_adults, t.children att_children
    FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    LEFT JOIN attendance t ON t.reservation_id = a.reservation_id AND t.date = a.date AND t.meal = a.meal
    WHERE a.date = ? AND a.meal = ? AND a.restaurant_id = ? AND r.status = 'ativa'
    ORDER BY room_sort(r.room)`).all(date, meal, restId)
    .map((x) => ({ ...x, att_restaurant: x.att_restaurant_id ? rm[x.att_restaurant_id] : null }));
  const extras = db.prepare(`
    SELECT t.id attendance_id, t.created_at att_at, t.adults att_adults, t.children att_children, t.assigned_restaurant_id,
      r.id reservation_id, r.reservation_number, r.guest_name, r.room, r.board
    FROM attendance t JOIN reservations r ON r.id = t.reservation_id
    WHERE t.date = ? AND t.meal = ? AND t.restaurant_id = ? AND t.status = 'fora_lista' ORDER BY t.id DESC`).all(date, meal, restId)
    .map((x) => ({ ...x, assigned_restaurant: x.assigned_restaurant_id ? rm[x.assigned_restaurant_id] : null }));
  const walkins = db.prepare('SELECT * FROM walkins WHERE date = ? AND meal = ? AND restaurant_id = ? ORDER BY id DESC').all(date, meal, restId);
  const mt = db.prepare('SELECT * FROM meal_times WHERE meal = ?').get(meal);
  const pub = db.prepare('SELECT * FROM meal_lists WHERE date = ? AND meal = ?').get(date, meal);
  return { date, meal, meal_time: mt, restaurant: rest, serves: !!restaurantsFor(meal, date).find((x) => x.id === rest.id), published: pub || null, list, extras, walkins };
});

route('GET', '/api/service/search', { roles: SERVICE }, ({ query, user }) => {
  const { date, meal } = dayMeal(query);
  const restId = restaurantFor(user, query.restaurant_id);
  const q = String(query.q || '').trim();
  if (q.length < 1) return { results: [], moved: [] };
  const rm = restMap();
  const match = roomMatch('room', q);
  const rows = db.prepare(`SELECT * FROM reservations WHERE checkin <= ? AND checkout >= ?
    AND (${match.sql} OR reservation_number = ? OR guest_name LIKE ?) ORDER BY status, room_sort(room) LIMIT 30`).all(date, date, ...match.args, q, `%${q}%`);
  const results = rows.map((r) => {
    const a = db.prepare('SELECT * FROM assignments WHERE reservation_id = ? AND date = ? AND meal = ?').get(r.id, date, meal);
    const t = db.prepare('SELECT * FROM attendance WHERE reservation_id = ? AND date = ? AND meal = ?').get(r.id, date, meal);
    let state, message;
    if (r.status !== 'ativa') { state = 'cancelada'; message = 'Reserva cancelada.'; }
    else if (!boardHas(r.board, meal)) { state = 'sem_refeicao'; message = `A pensão ${r.board} (${BOARDS[r.board].label}) não inclui ${MEAL_LABEL[meal].toLowerCase()}. Cobrar à parte.`; }
    else if (!inWindow(r, date, meal)) { state = 'sem_refeicao'; message = `${MEAL_LABEL[meal]} não incluído neste dia da estadia (entrada ${r.checkin}, saída ${r.checkout}). Cobrar à parte.`; }
    else if (t) { state = 'ja_marcado'; message = `Já registrado em ${rm[t.restaurant_id].name} às ${t.created_at.slice(11, 16)}.`; }
    else if (a && a.restaurant_id === restId) { state = 'na_lista'; message = 'Está na lista deste restaurante.'; }
    else { state = 'outro_restaurante'; message = `Lista de ${a ? rm[a.restaurant_id].name : 'nenhum restaurante'}. Se marcar aqui fica como FORA DA LISTA.`; }
    return {
      reservation_id: r.id, reservation_number: r.reservation_number, guest_name: r.guest_name, room: r.room, board: r.board,
      adults: r.adults, children: r.children, state, message,
      assigned_restaurant: a ? rm[a.restaurant_id] : null, attendance: t ? { ...t, restaurant: rm[t.restaurant_id] } : null,
    };
  });
  // Trocas de quarto recentes: avisa se o número digitado era o quarto antigo
  const moved = db.prepare(`SELECT c.old_room, c.new_room, c.created_at, r.guest_name FROM room_changes c JOIN reservations r ON r.id = c.reservation_id
    WHERE room_key(c.old_room) = ? AND room_key(r.room) != ? AND r.checkout >= ? AND r.status = 'ativa' ORDER BY c.id DESC LIMIT 5`).all(roomKey(q), roomKey(q), date);
  if (!results.length && !moved.length) {
    return { results, moved, notFound: `Nenhum hóspede hospedado com "${q}" em ${date.split('-').reverse().join('/')}.` };
  }
  return { results, moved };
});

route('POST', '/api/attendance', { roles: SERVICE }, ({ body, user, ip }) => {
  const { date, meal } = dayMeal(body);
  const restId = restaurantFor(user, body.restaurant_id);
  const rest = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restId);
  if (!rest || !restaurantsFor(meal, date).find((x) => x.id === rest.id)) throw new HttpError(400, `${rest ? rest.name : 'Este restaurante'} não serve ${MEAL_LABEL[meal].toLowerCase()}.`);
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(body.reservation_id);
  if (!r) throw new HttpError(404, 'Reserva não encontrada.');
  if (!isEligible(r, date, meal)) {
    throw new HttpError(400, `Cliente não possui ${MEAL_LABEL[meal].toLowerCase()} na pensão (${r.board}). Deve ser cobrado à parte.`, { state: 'sem_refeicao' });
  }
  const adults = body.adults !== undefined ? Math.max(0, Math.min(Number(body.adults) || 0, r.adults)) : r.adults;
  const children = body.children !== undefined ? Math.max(0, Math.min(Number(body.children) || 0, r.children)) : r.children;
  if (adults + children === 0) throw new HttpError(400, 'Informe ao menos uma pessoa.');
  const a = db.prepare('SELECT * FROM assignments WHERE reservation_id = ? AND date = ? AND meal = ?').get(r.id, date, meal);
  const status = a && a.restaurant_id === restId ? 'presente' : 'fora_lista';
  try {
    const ins = db.prepare(`INSERT INTO attendance(reservation_id, date, meal, restaurant_id, assigned_restaurant_id, status, adults, children, room, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(r.id, date, meal, restId, a ? a.restaurant_id : null, status, adults, children, r.room, user.id);
    audit(user, 'refeicao_marcada', { reserva: r.reservation_number, quarto: r.room, date, meal, restaurante: rest.code, status }, ip);
    return { id: Number(ins.lastInsertRowid), status };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      const t = db.prepare('SELECT t.*, x.name FROM attendance t JOIN restaurants x ON x.id = t.restaurant_id WHERE reservation_id = ? AND date = ? AND meal = ?').get(r.id, date, meal);
      throw new HttpError(409, `Já registrado em ${t.name} às ${t.created_at.slice(11, 16)}. Não é possível marcar de novo.`);
    }
    throw e;
  }
});

route('DELETE', '/api/attendance/:id', { roles: SERVICE }, ({ params, user, ip }) => {
  const t = db.prepare('SELECT t.*, r.reservation_number FROM attendance t JOIN reservations r ON r.id = t.reservation_id WHERE t.id = ?').get(params.id);
  if (!t) throw new HttpError(404, 'Registro não encontrado.');
  if (user.role === 'restaurante') {
    if (t.restaurant_id !== user.restaurant_id) throw new HttpError(403, 'Só é possível desfazer marcações do seu restaurante.');
    if (t.date !== todayISO()) throw new HttpError(403, 'Só é possível desfazer marcações de hoje.');
  }
  db.prepare('DELETE FROM attendance WHERE id = ?').run(t.id);
  audit(user, 'marcacao_desfeita', { reserva: t.reservation_number, date: t.date, meal: t.meal }, ip);
  return { ok: true };
});

// Cliente sem a refeição na pensão que consumiu e pagou à parte (registro de controle)
route('POST', '/api/walkins', { roles: SERVICE }, ({ body, user, ip }) => {
  const { date, meal } = dayMeal(body);
  const restId = restaurantFor(user, body.restaurant_id);
  const adults = Math.max(0, Number(body.adults) || 0), children = Math.max(0, Number(body.children) || 0);
  if (adults + children === 0) throw new HttpError(400, 'Informe a quantidade de pessoas.');
  db.prepare('INSERT INTO walkins(date, meal, restaurant_id, room, reservation_id, adults, children, note, user_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(date, meal, restId, body.room || null, body.reservation_id || null, adults, children, body.note || null, user.id);
  audit(user, 'avulso_registrado', { date, meal, quarto: body.room, adults, children }, ip);
  return { ok: true };
});

route('DELETE', '/api/walkins/:id', { roles: SERVICE }, ({ params, user }) => {
  const w = db.prepare('SELECT * FROM walkins WHERE id = ?').get(params.id);
  if (!w) throw new HttpError(404, 'Registro não encontrado.');
  if (user.role === 'restaurante' && w.restaurant_id !== user.restaurant_id) throw new HttpError(403, 'Sem permissão.');
  db.prepare('DELETE FROM walkins WHERE id = ?').run(w.id);
  return { ok: true };
});

// ---------- Notificações ----------
function notifFilter(user) {
  return { sql: '(n.role IS NULL OR n.role = ? OR ? = \'admin\') AND (n.restaurant_id IS NULL OR n.restaurant_id = ? OR ? != \'restaurante\')', args: [user.role, user.role, user.restaurant_id, user.role] };
}

route('GET', '/api/notifications', { allowPwChange: true, portal: true }, ({ user, query }) => {
  const f = notifFilter(user);
  const since = Number(query.since) || 0;
  const rows = db.prepare(`SELECT n.*, EXISTS(SELECT 1 FROM notification_reads x WHERE x.notification_id = n.id AND x.user_id = ?) read
    FROM notifications n WHERE ${f.sql} AND n.id > ? AND n.created_at >= datetime('now','localtime','-3 days') ORDER BY n.id DESC LIMIT 40`)
    .all(user.id, ...f.args, since);
  return rows;
});

route('POST', '/api/notifications/read', { portal: true }, ({ user, body }) => {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
  const ins = db.prepare('INSERT OR IGNORE INTO notification_reads(notification_id, user_id) VALUES (?,?)');
  tx(() => { for (const id of ids) ins.run(id, user.id); });
  return { ok: true };
});
