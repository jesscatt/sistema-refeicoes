'use strict';
// Testes principais das regras de negócio.  npm test
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-test-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ADMIN_PASSWORD = 'admin-teste-1';
process.env.DEV_PASSWORD = 'dev-teste-1';

const { db } = require('../src/db');
const { parseBoard, parseDate, addDays } = require('../src/util');
const { isEligible, mealDates, daySummary, rebalance } = require('../src/meals');
const { upsertReservations, parseRows } = require('../src/importer');
const { readCsv } = require('../src/xlsx');

test('tipos de pensão', () => {
  assert.equal(parseBoard('CM'), 'CM');
  assert.equal(parseBoard('MAP - café e janta'), 'MAP');
  assert.equal(parseBoard('mapa'), 'MAPA');
  assert.equal(parseBoard('FAP'), 'FAP');
  assert.equal(parseBoard('Pensão completa'), 'FAP');
  assert.equal(parseBoard('xyz'), null);
});

test('datas do Excel e brasileiras', () => {
  assert.equal(parseDate('01/10/2026'), '2026-10-01');
  assert.equal(parseDate('2026-10-01'), '2026-10-01');
  assert.equal(parseDate(46296), '2026-10-01');
  assert.equal(parseDate('31/02/2026'), null);
});

test('refeições incluídas por pensão e dia', () => {
  const r = { status: 'ativa', board: 'MAP', checkin: '2026-10-01', checkout: '2026-10-03' };
  assert.deepEqual(mealDates(r, 'cafe'), ['2026-10-02', '2026-10-03']);
  assert.deepEqual(mealDates(r, 'janta'), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(mealDates(r, 'almoco'), []);
  assert.equal(isEligible({ ...r, board: 'CM' }, '2026-10-02', 'janta'), false);
});

test('importação reconhece cabeçalho com títulos antes', () => {
  const rows = readCsv(Buffer.from('Relatório\n\nReserva;Nome;Entrada;Saída;UH;Regime;Pessoas;CHD\n1;Ana;01/10/2026;03/10/2026;101;FAP;3;1\n'));
  const p = parseRows(rows);
  assert.ok(p.ok, p.error);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].adults, 2); // "Pessoas" = total, menos crianças
  assert.equal(p.rows[0].children, 1);
});

test('divisão 60/20/20 e café 60/40', () => {
  const d0 = '2026-11-10';
  const recs = [];
  for (let i = 0; i < 200; i++) recs.push({ reservation_number: 'T' + i, guest_name: 'Hóspede ' + i, checkin: d0, checkout: addDays(d0, 2), room: `${1 + (Math.floor(i / 10) % 6)}${String(1 + (i % 10)).padStart(2, '0')}${'EFGH'[Math.floor(i / 60)]}`, board: 'FAP', adults: 1 + (i % 3), children: i % 2 });
  const r = upsertReservations(recs);
  assert.equal(r.inserted, 200);
  const day = addDays(d0, 1);
  for (const meal of ['almoco', 'janta']) {
    rebalance(day, meal);
    const s = daySummary(day, meal);
    const pct = Object.fromEntries(s.map((x) => [x.code, x.pct]));
    assert.ok(Math.abs(pct.DG - 0.6) < 0.01, `${meal} DG ${pct.DG}`);
    assert.ok(Math.abs(pct.PAR - 0.2) < 0.01, `${meal} PAR ${pct.PAR}`);
    assert.ok(Math.abs(pct.MAE - 0.2) < 0.01, `${meal} MAE ${pct.MAE}`);
  }
  const cafe = Object.fromEntries(daySummary(day, 'cafe').map((x) => [x.code, x]));
  assert.equal(cafe.MAE.pax, 0, 'Maestro não serve café');
  assert.ok(Math.abs(cafe.DG.pct - 0.6) < 0.01);
  assert.ok(Math.abs(cafe.PAR.pct - 0.4) < 0.01);
});

test('troca de quarto na reimportação é registrada', () => {
  const r = upsertReservations([{ reservation_number: 'T1', guest_name: 'Hóspede 1', checkin: '2026-11-10', checkout: '2026-11-12', room: '610H', board: 'FAP', adults: 2, children: 1 }]);
  assert.equal(r.roomChanges.length, 1);
  assert.equal(r.roomChanges[0].old_room, '102E');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'room_change'").get());
});

test('marcação não duplica entre restaurantes', () => {
  const res = db.prepare("SELECT id FROM reservations WHERE reservation_number = 'T5'").get();
  const ins = db.prepare("INSERT INTO attendance(reservation_id, date, meal, restaurant_id, status, adults, children) VALUES (?, '2026-11-11', 'janta', ?, 'presente', 1, 0)");
  ins.run(res.id, 1);
  assert.throws(() => ins.run(res.id, 2), /UNIQUE/);
});

test('quarto com letra da torre', () => {
  const { roomKey, roomMatch } = require('../src/util');
  for (const v of ['101A', 'A101', 'a-101', 'Torre A 101', '101 a', 'Bloco A - 101']) assert.equal(roomKey(v), '101A', v);
  upsertReservations([
    { reservation_number: 'TW1', guest_name: 'Torre A', checkin: '2026-12-01', checkout: '2026-12-03', room: '101A', board: 'CM', adults: 1, children: 0 },
    { reservation_number: 'TW2', guest_name: 'Torre B', checkin: '2026-12-01', checkout: '2026-12-03', room: 'B101', board: 'CM', adults: 1, children: 0 },
  ]);
  const find = (q) => { const m = roomMatch('room', q); return db.prepare(`SELECT reservation_number n FROM reservations WHERE ${m.sql} AND reservation_number LIKE 'TW%' ORDER BY n`).all(...m.args).map((r) => r.n); };
  assert.deepEqual(find('a101'), ['TW1']);
  assert.deepEqual(find('101 B'), ['TW2']);
  assert.deepEqual(find('101'), ['TW1', 'TW2']);
  // mesma reserva com o quarto escrito de outro jeito não é troca de quarto
  const r = upsertReservations([{ reservation_number: 'TW1', guest_name: 'Torre A', checkin: '2026-12-01', checkout: '2026-12-03', room: 'A-101', board: 'CM', adults: 1, children: 0 }]);
  assert.equal(r.roomChanges.length, 0);
});

test('reserva com nome junto e vários quartos (grupo)', () => {
  const { splitReservation } = require('../src/importer');
  assert.deepEqual(splitReservation('50893 ANR TUR'), { number: '50893', name: 'ANR TUR' });
  assert.deepEqual(splitReservation('59.699 EMANUEL VIAJES'), { number: '59699', name: 'EMANUEL VIAJES' });
  assert.deepEqual(splitReservation(12345), { number: '12345', name: '' });
  const recs = [];
  for (let i = 0; i < 12; i++) recs.push({ reservation_number: '77001 GRUPO TESTE', checkin: '2027-01-10', checkout: '2027-01-13', room: `${i < 10 ? 101 + i : 191 + i}C`, board: 'FAP', pax: 2, children: 0 });
  const r = upsertReservations(recs);
  assert.equal(r.inserted, 12);
  const split = db.prepare(`SELECT COUNT(*) n FROM (SELECT a.date, a.meal, COUNT(DISTINCT a.restaurant_id) k FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE r.reservation_number = '77001' GROUP BY 1, 2 HAVING k > 1)`).get().n;
  assert.equal(split, 0, 'grupo não pode ser dividido entre restaurantes');
  // reimportar com um quarto trocado e um removido
  const again = recs.slice(0, 11).map((x, i) => (i === 0 ? { ...x, room: '610C' } : x));
  const r2 = upsertReservations(again, { cancelMissing: true });
  assert.equal(r2.roomChanges.length, 1);
  assert.equal(r2.cancelled, 1);
});

test('datas com dia/mês trocados pelo Excel', () => {
  const { parseRows } = require('../src/importer');
  // 46022 = 2026-01-01 serial; usamos números para simular datas do Excel
  const serial = (iso) => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
  const rows = [['Reserva', 'Entrada', 'Saída', 'Pensão', 'Apto', 'Pax', 'Chd'],
    ['1 A', '30/09/2026', serial('2026-03-10'), 'FAP', '101A', 2, '-'],   // saída 03/10 gravada como 10/03
    ['2 B', serial('2026-01-10'), serial('2026-04-10'), 'CM', '102A', 3, 1], // 01/10 -> 04/10
    ['3 C', '30/09/2026', '02/10/2026', 'MAP', '103A', 2, '-']];
  const p = parseRows(rows);
  assert.ok(p.ok, p.error);
  assert.equal(p.rows[0].checkout, '2026-10-03');
  assert.equal(p.rows[1].checkin, '2026-10-01');
  assert.equal(p.rows[1].checkout, '2026-10-04');
  assert.equal(p.rows[1].adults, 2); // Pax inclui crianças
  assert.ok(p.rows[0].date_fixed);
});

test('almoço no dia da chegada e restaurante fechado no dia', () => {
  const { mealDates, restaurantsFor } = require('../src/meals');
  const r = { status: 'ativa', board: 'FAP', checkin: '2026-10-01', checkout: '2026-10-04', lunch_on_arrival: 1 };
  assert.deepEqual(mealDates(r, 'almoco'), ['2026-10-01', '2026-10-02', '2026-10-03']);
  db.prepare("UPDATE restaurants SET closed_janta = '3' WHERE code = 'MAE'").run();
  assert.ok(!restaurantsFor('janta', '2026-09-30').find((x) => x.code === 'MAE'), 'quarta fechado');
  assert.ok(restaurantsFor('janta', '2026-10-01').find((x) => x.code === 'MAE'));
  db.prepare("UPDATE restaurants SET closed_janta = '' WHERE code = 'MAE'").run();
});

test('divisão vinda da planilha é lida e aplicada', () => {
  const { parseRows } = require('../src/importer');
  const rows = [
    ['RESORT', null, null, null, null, null, null, 'JANTAR DI GIORDANA QUARTA-FEIRA 30/09', 'JANTAR PARADISO QUARTA-FEIRA 30/09', 'ALMOÇO CHURRASCARIA QUINTA-FEIRA 01/10'],
    ['Reserva', 'Entrada', 'Saída', 'Pensão', 'Apto', 'Pax', 'Chd'],
    ['88001 PLANILHA', '30/09/2026', '02/10/2026', 'FAP', '501A', 2, '-', null, 2, 2],
  ];
  const p = parseRows(rows);
  assert.ok(p.ok, p.error);
  assert.equal(p.distribution.columns.length, 3);
  assert.equal(p.rows[0].dist.length, 2);
  const r = upsertReservations(p.rows, { useDistribution: true });
  assert.equal(r.distApplied, 2);
  const a = db.prepare(`SELECT x.code FROM assignments a JOIN reservations r ON r.id = a.reservation_id JOIN restaurants x ON x.id = a.restaurant_id
    WHERE r.reservation_number = '88001' AND a.date = '2026-09-30' AND a.meal = 'janta'`).get();
  assert.equal(a.code, 'PAR');
});

test('Comercial: rooming list, trocas e permissões', async () => {
  const http = require('node:http');
  const { hashPassword } = require('../src/db');
  require('../src/routes/auth'); require('../src/routes/reservations'); require('../src/routes/service');
  require('../src/routes/control'); require('../src/routes/admin'); require('../src/routes/portal');
  const { handle } = require('../src/http');
  const { apiKeyAuth } = require('../src/routes/integration');
  const { addDays, todayISO } = require('../src/util');
  const t = todayISO();
  upsertReservations([0, 1, 2].map((i) => ({ reservation_number: '99001 AGENCIA TESTE', checkin: t, checkout: addDays(t, 3), room: `${401 + i}D`, board: 'MAP', pax: 2, children: 0 })));
  upsertReservations([{ reservation_number: '99002', checkin: t, checkout: addDays(t, 3), room: '410D', board: 'MAP', pax: 2, children: 0 }]);
  db.prepare("INSERT INTO users(username, name, password_hash, role) VALUES ('com1', 'Comercial', ?, 'agencia')").run(hashPassword('senha-123'));
  db.prepare("INSERT INTO users(username, name, password_hash, role, restaurant_id) VALUES ('rest1', 'Rest', ?, 'restaurante', 2)").run(hashPassword('senha-123'));
  const srv = http.createServer((q, s2) => handle(q, s2, __dirname, apiKeyAuth)).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (u) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'senha-123' }) }); return r.headers.get('set-cookie').split(';')[0]; };
  const H = (c, extra = {}) => ({ cookie: c, 'x-requested-with': 'fetch', 'content-type': 'application/json', ...extra });
  try {
    // login por número: mostra o nome e depois pede a senha
    db.prepare("UPDATE users SET login_code = '612' WHERE username = 'com1'").run();
    const lk = await (await fetch(base + '/api/login/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '612' }) })).json();
    assert.equal(lk.name, 'Comercial');
    assert.equal((await fetch(base + '/api/login/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '999' }) })).status, 404);
    const byCode = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '612', password: 'senha-123' }) });
    assert.equal(byCode.status, 200);
    assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '612', password: 'errada' }) })).status, 401);
    const c = await login('com1');
    // vê todas as reservas, não acessa o resto do sistema
    const list = await (await fetch(base + '/api/portal/reservations?q=99001', { headers: H(c) })).json();
    assert.equal(list.rows.length, 3);
    // rooming list é só para grupos: reserva de um apartamento não aparece
    const solo = await (await fetch(base + '/api/portal/reservations?q=99002', { headers: H(c) })).json();
    assert.equal(solo.rows.length, 0);
    const gl = await (await fetch(base + '/api/portal/groups', { headers: H(c) })).json();
    assert.ok(gl.some((g) => g.reservation_number === '99001') && !gl.some((g) => g.reservation_number === '99002'));
    assert.equal((await fetch(base + '/api/dashboard', { headers: H(c) })).status, 200, 'todos veem o painel');
    assert.equal((await fetch(base + '/api/reception', { headers: H(c) })).status, 200, 'Comercial vê onde cada hóspede come');
    assert.equal((await fetch(base + '/api/distribution', { headers: H(c) })).status, 403);
    assert.equal((await fetch(base + '/api/billing', { headers: H(c) })).status, 403);
    // rooming list: uma linha por hóspede, quarto mesclado, idade -> criança; 1 quarto novo; 1 quarto fora
    const csv = 'Quarto;Nome do hóspede;Idade\n401D;Maria Silva;40\n;João Silva;42\n;Pedro Silva;7\n402D;Ana Souza;30\n405D;Carlos Lima;50\n405D;Rita Lima;48\n';
    const prev = await (await fetch(base + '/api/portal/rooming/preview', { method: 'POST', headers: H(c, { 'content-type': 'application/octet-stream', 'x-filename': 'rl.csv', 'x-reservation': '99001' }), body: Buffer.from(csv) })).json();
    const byRoom = Object.fromEntries(prev.items.map((i) => [i.room, i]));
    assert.equal(byRoom['401D'].action, 'atualizar');
    assert.deepEqual([byRoom['401D'].adults, byRoom['401D'].children], [2, 1]);
    assert.equal(byRoom['402D'].adults, 1);
    assert.equal(byRoom['405D'].action, 'novo');
    assert.equal(prev.missing.length, 1); // 403D não veio
    const groups = prev.items.map((i) => ({ reservation_number: i.reservation_number, room: i.room, names: i.names, adults: i.adults, children: i.children }));
    const res = await (await fetch(base + '/api/portal/rooming/commit', { method: 'POST', headers: H(c), body: JSON.stringify({ groups, remove_ids: [prev.missing[0].id], reservation_number: '99001' }) })).json();
    assert.deepEqual([res.updated, res.created, res.removed], [2, 1, 1]);
    const r705 = db.prepare("SELECT * FROM reservations WHERE reservation_number = '99001' AND room = '405D'").get();
    assert.equal(r705.board, 'MAP');
    assert.equal(r705.guests, 'Carlos Lima\nRita Lima');
    assert.equal(db.prepare("SELECT status FROM reservations WHERE reservation_number = '99001' AND room = '403D'").get().status, 'cancelada');
    // troca de quarto pelo Comercial, conferência e desfazer
    const r701 = db.prepare("SELECT id FROM reservations WHERE reservation_number = '99001' AND room = '401D'").get();
    const up = await fetch(base + '/api/portal/reservations/' + r701.id, { method: 'PUT', headers: H(c), body: JSON.stringify({ room: '409D', board: 'FAP' }) });
    assert.equal(up.status, 200);
    assert.equal(db.prepare('SELECT board FROM reservations WHERE id = ?').get(r701.id).board, 'MAP', 'pensão não muda pelo Comercial');
    const ch = db.prepare('SELECT id FROM room_changes WHERE reservation_id = ? ORDER BY id DESC').get(r701.id);
    const undo = await fetch(base + `/api/room-changes/${ch.id}/validate`, { method: 'POST', headers: H(c), body: JSON.stringify({ undo: true }) });
    assert.equal(undo.status, 200);
    assert.equal(db.prepare('SELECT room FROM reservations WHERE id = ?').get(r701.id).room, '401D');
    // fora da lista: registrado num restaurante, não marca de novo em lugar nenhum
    const a = db.prepare("SELECT * FROM assignments WHERE reservation_id = ? AND meal = 'janta' AND date = ?").get(r701.id, t);
    const other = db.prepare('SELECT id FROM restaurants WHERE id != ? AND share_janta > 0 LIMIT 1').get(a.restaurant_id).id;
    db.prepare('UPDATE users SET restaurant_id = ? WHERE username = ?').run(other, 'rest1');
    const rc = await login('rest1');
    assert.equal((await fetch(base + '/api/dashboard', { headers: H(rc) })).status, 200);
    assert.equal((await fetch(base + '/api/control/week', { headers: H(rc) })).status, 403, 'restaurante: só painel e marcações');
    assert.equal((await fetch(base + '/api/room-changes/1/validate', { method: 'POST', headers: H(rc), body: '{}' })).status, 403);
    const m1 = await (await fetch(base + '/api/attendance', { method: 'POST', headers: H(rc), body: JSON.stringify({ reservation_id: r701.id, date: t, meal: 'janta' }) })).json();
    assert.equal(m1.status, 'fora_lista');
    assert.ok(m1.assigned_restaurant);
    const m2 = await fetch(base + '/api/attendance', { method: 'POST', headers: H(rc), body: JSON.stringify({ reservation_id: r701.id, date: t, meal: 'janta' }) });
    assert.equal(m2.status, 409);
  } finally { srv.close(); }
});

test('fechar restaurante numa data redistribui os hóspedes', async () => {
  const http = require('node:http');
  const { hashPassword } = require('../src/db');
  const { handle } = require('../src/http');
  const { apiKeyAuth } = require('../src/routes/integration');
  const { addDays, todayISO } = require('../src/util');
  const d0 = addDays(todayISO(), 5);
  upsertReservations([0, 1, 2, 3, 4, 5].map((i) => ({ reservation_number: `66${i} DIA`, checkin: d0, checkout: addDays(d0, 2), room: `${601 + i}B`, board: 'FAP', pax: 2, children: 0 })));
  const day = addDays(d0, 1);
  const mae = db.prepare("SELECT id FROM restaurants WHERE code = 'MAE'").get().id;
  db.prepare("INSERT INTO users(username, name, password_hash, role) VALUES ('ref9', 'Ref', ?, 'refeicao')").run(hashPassword('senha-123'));
  db.prepare("INSERT INTO users(username, name, password_hash, role) VALUES ('rec9', 'Rec', ?, 'recepcao')").run(hashPassword('senha-123'));
  const srv = http.createServer((q, s2) => handle(q, s2, __dirname, apiKeyAuth)).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (u) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'senha-123' }) })).headers.get('set-cookie').split(';')[0];
  const H = (c) => ({ cookie: c, 'x-requested-with': 'fetch', 'content-type': 'application/json' });
  try {
    const rec = await login('rec9');
    const view = await (await fetch(base + '/api/restaurants/day?date=' + day, { headers: H(rec) })).json();
    assert.equal(view.restaurants.length, 3, 'todos veem os restaurantes do dia');
    assert.equal((await fetch(base + '/api/restaurants/day', { method: 'PUT', headers: H(rec), body: JSON.stringify({ date: day, meal: 'janta', restaurant_id: mae, open: false }) })).status, 403);
    const ref = await login('ref9');
    const r = await fetch(base + '/api/restaurants/day', { method: 'PUT', headers: H(ref), body: JSON.stringify({ date: day, meal: 'janta', restaurant_id: mae, open: false, note: 'manutenção' }) });
    assert.equal(r.status, 200);
    const left = db.prepare("SELECT COUNT(*) n FROM assignments WHERE date = ? AND meal = 'janta' AND restaurant_id = ?").get(day, mae).n;
    assert.equal(left, 0, 'ninguém fica no restaurante fechado');
    const st = (await (await fetch(base + '/api/restaurants/day?date=' + day, { headers: H(rec) })).json()).restaurants.find((x) => x.id === mae).meals.find((m) => m.meal === 'janta');
    assert.equal(st.open, false); assert.equal(st.note, 'manutenção');
  } finally { srv.close(); }
});

test('semana dos restaurantes no painel', () => {
  const { restaurantStatus } = require('../src/meals');
  const { addDays, todayISO } = require('../src/util');
  const d = addDays(todayISO(), 6);
  const mae = db.prepare("SELECT id FROM restaurants WHERE code = 'MAE'").get().id;
  assert.equal(restaurantStatus('cafe', d).find((r) => r.id === mae).serves, false);
  db.prepare("INSERT OR REPLACE INTO restaurant_days(date, restaurant_id, meal, is_open, note) VALUES (?, ?, 'almoco', 0, 'evento')").run(d, mae);
  const s = restaurantStatus('almoco', d).find((r) => r.id === mae);
  assert.equal(s.open, false); assert.equal(s.reason, 'fechado_dia');
});

test('realizado vem dos registros dos restaurantes e não é editável', () => {
  const { controlRange, weekly } = require('../src/routes/control');
  const r = db.prepare("SELECT r.id, a.date, a.restaurant_id FROM reservations r JOIN assignments a ON a.reservation_id = r.id WHERE r.reservation_number = '660' AND a.meal = 'almoco' LIMIT 1").get();
  db.prepare("INSERT INTO attendance(reservation_id, date, meal, restaurant_id, status, adults, children) VALUES (?, ?, 'almoco', ?, 'presente', 2, 0)").run(r.id, r.date, r.restaurant_id);
  db.prepare("INSERT OR REPLACE INTO control_real(date, restaurant_id, meal, real_adults, real_children) VALUES (?, ?, 'almoco', 999, 0)").run(r.date, r.restaurant_id);
  const row = controlRange(r.date, r.date, r.restaurant_id).find((x) => x.meal === 'almoco');
  assert.equal(row.real_adults, row.checked_adults, 'realizado = registros, ignora número digitado');
  assert.ok(row.real_adults < 999);
  const w = weekly(r.date, r.date, r.restaurant_id);
  assert.equal(w.total.pag_adt, row.checked_adults);
});

test('política: no máximo 5 pessoas por quarto', () => {
  const { normalizeRecord } = require('../src/importer');
  const { setSetting } = require('../src/db');
  const base = { reservation_number: '77001', checkin: '2026-10-10', checkout: '2026-10-12', room: '101A', board: 'MAP' };
  assert.equal(normalizeRecord({ ...base, pax: 5, children: 2 }).errors.length, 0, '5 pessoas cabe');
  assert.match(normalizeRecord({ ...base, pax: 6, children: 1 }).errors.join(), /no máximo 5/);
  setSetting('max_pax_room', 6);
  assert.equal(normalizeRecord({ ...base, pax: 6 }).errors.length, 0, 'limite configurável');
  setSetting('max_pax_room', 5);
});

test('controle financeiro: semanas de quarta a terça, preços por mês, extras e vouchers', () => {
  const fin = require('../src/finance');
  // setembro/2026 começa numa terça: semana 1 = dia 1; semana 2 começa na quarta 02/09
  const w = fin.weeksOfMonth('2026-09');
  assert.equal(w[0].from, '2026-09-01'); assert.equal(w[0].to, '2026-09-01');
  assert.equal(w[1].from, '2026-09-02'); assert.equal(w[1].to, '2026-09-08');
  assert.equal(w[w.length - 1].to, '2026-09-30');
  const dg = db.prepare("SELECT id FROM restaurants WHERE code = 'DG'").get().id;
  // preço vigente: padrão 75/37,5 no almoço; nova vigência a partir de 2026-12
  assert.equal(fin.priceFor(dg, 'almoco', '2026-11').price_adult, 75);
  db.prepare("INSERT INTO price_history(restaurant_id, meal, valid_from, price_adult, price_child, extra_adult, extra_child) VALUES (?, 'almoco', '2026-12', 80, 40, 90, 45)").run(dg);
  assert.equal(fin.priceFor(dg, 'almoco', '2026-12').price_adult, 80);
  assert.equal(fin.priceFor(dg, 'almoco', '2026-11').price_adult, 75);
  // realizado do sistema + extra + voucher em dezembro
  const r = upsertReservations([{ reservation_number: '88001', checkin: '2026-12-09', checkout: '2026-12-11', room: '601H', board: 'FAP', pax: 3, children: 1 }]);
  const res = db.prepare("SELECT id FROM reservations WHERE reservation_number = '88001'").get();
  db.prepare("INSERT INTO attendance(reservation_id, date, meal, restaurant_id, status, adults, children) VALUES (?, '2026-12-10', 'almoco', ?, 'presente', 2, 1)").run(res.id, dg);
  db.prepare("INSERT INTO restaurant_extras(date, meal, restaurant_id, adults, children, note) VALUES ('2026-12-10', 'almoco', ?, 2, 0, 'evento')").run(dg);
  db.prepare("INSERT INTO vouchers(date, meal, restaurant_id, code, adults, children) VALUES ('2026-12-10', 'almoco', ?, 'V1', 1, 0)").run(dg);
  const m = fin.restaurantMonth(dg, '2026-12');
  const alm = m.month_lines.find((l) => l.meal === 'almoco');
  assert.equal(alm.adults, 2); assert.equal(alm.children, 1);
  assert.equal(alm.value_adults + alm.value_children, 2 * 80 + 40, 'criança paga a parte dela (meia)');
  assert.equal(m.totals.extras, 2 * 90, 'extra pelo valor de extra');
  assert.equal(m.totals.vouchers, 80, 'voucher pelo valor da refeição');
  assert.equal(m.totals.total, 200 + 180 + 80);
  const wk = m.weeks.find((x) => x.from <= '2026-12-10' && x.to >= '2026-12-10');
  assert.equal(wk.from, '2026-12-09', 'semana começa na quarta');
  assert.equal(wk.value, 200);
  // consolidado com outro ponto e desconto de 15%
  db.prepare("INSERT INTO finance_entries(month, kind, outlet, item, unit_price, qty, value) VALUES ('2026-12', 'outro', 'Di Paolo', 'Almoço', 95, 2, 190)").run();
  const c = fin.consolidated('2026-12');
  assert.equal(c.others_total, 190);
  assert.equal(c.total, 460 + 190);
  assert.equal(c.total_net, Math.round((460 + 190) * 0.85 * 100) / 100);
});

test('importação da planilha de controle de faturamento (formato antigo)', () => {
  const { buildWorkbook } = require('../src/xlsx-write');
  const { parseFile } = require('../src/finance-import');
  // aba no formato da planilha: blocos DG / Paradiso / Churrascaria, preço na fórmula, extras e Di Paolo
  const rows = [
    ['VALOR FATURADO ATÉ 30/11'],
    ['DI GIORDANA', null, null, 'PARADISO', null, null, 'CHURRASCARIA'],
    ['Adultos', null, null, 'Adultos', null, null, 'Adultos'],
    ['QUANTIDADE CAFÉ DA MANHÃ ', 'TOTAL', null, 'QUANTIDADE CAFÉ DA MANHÃ ', 'TOTAL', null, null, 'TOTAL'],
    [100, { f: 'A5*40', v: 4000 }, null, 50, { f: 'D5*35.5', v: 1775 }, null, 'QUANTIDADE ALMOÇO'],
    [10, { f: 'A6*43', v: 430 }, null, null, null, null, 20, { f: 'G6*85.5', v: 1710 }],
    ['Crianças', null, null, 'Crianças', null, null, 'Crianças'],
    ['QUANTIDADE CAFÉ DA MANHÃ ', null, null, 'QUANTIDADE CAFÉ DA MANHÃ ', null, null, 'QUANTIDADE ALMOÇO'],
    [4, { f: 'A9*20', v: 80 }, null, 2, { f: 'D9*17.75', v: 35.5 }, null, 2, { f: 'G9*42.75', v: 85.5 }],
    [],
    ['EXTRAS DI GIORDANA:'],
    ['Refeição', 'Valor Unitário', 'Quantidade de pessoas', 'Total'],
    ['Almoço', 82, 3, { f: 'B13*C13', v: 246 }],
    ['Total'],
    ['Di Paolo'],
    ['Refeição', 'Valor Unitário', 'Quant.', 'Total'],
    ['Almoço', 95, '2', { f: 'B17*C17', v: 190 }],
    ['Total'],
    ['Total', 8552],
    ['Projeção Novembro'],
  ];
  const buf = buildWorkbook([{ name: 'Novembro 2026', rows }]);
  const p = parseFile(buf, 'controle.xlsx');
  assert.equal(p.type, 'controle');
  const m = p.months[0];
  assert.equal(m.month, '2026-11');
  const cafe = m.lines.find((l) => l.meal === 'cafe' && l.who === 'adults' && l.restaurant_id === 1);
  assert.equal(cafe.qty, 110, 'duas linhas de café (troca de preço no mês)');
  assert.equal(cafe.value, 4430);
  const total = m.lines.reduce((s, l) => s + l.value, 0) + m.entries.reduce((s, e) => s + e.value, 0);
  assert.equal(total, 8552, 'bate com o total da planilha');
  assert.ok(m.entries.some((e) => e.outlet === 'Di Paolo' && e.value === 190));
  assert.ok(m.entries.some((e) => e.kind === 'extra' && e.value === 246));
});

test('apartamentos: 3 números e a torre (A a H), 101 a 610, torre A sem 105 e 106', () => {
  const { roomError, canonRoom } = require('../src/util');
  for (const ok of ['101A', '610H', '107A', '105B', '101 a', '310-c']) assert.equal(roomError(ok), null, ok);
  for (const bad of ['sss', '101', 'A', '1010A', '101I', '611A', '700B', '100A', '105A', '106A', '']) assert.ok(roomError(bad), bad);
  assert.equal(canonRoom('101 a'), '101A');
  const { normalizeRecord } = require('../src/importer');
  assert.match(normalizeRecord({ reservation_number: '1', checkin: '2026-10-10', checkout: '2026-10-11', room: '105A', board: 'CM', pax: 1 }).errors.join(), /torre A não tem/);
});

test('com dois restaurantes abertos no almoço/jantar a divisão é 60/40', () => {
  const { restaurantsFor, rebalance, daySummary } = require('../src/meals');
  const d = '2027-03-10';
  const mae = db.prepare("SELECT id FROM restaurants WHERE code = 'MAE'").get().id;
  db.prepare("INSERT OR REPLACE INTO restaurant_days(date, restaurant_id, meal, is_open, note) VALUES (?, ?, 'almoco', 0, 'teste')").run(d, mae);
  const rs = restaurantsFor('almoco', d);
  assert.deepEqual(rs.map((r) => r.share), [0.6, 0.4]);
  assert.deepEqual(restaurantsFor('janta', d).map((r) => r.share), [0.6, 0.2, 0.2], 'jantar com os três abertos continua 60/20/20');
  upsertReservations(Array.from({ length: 50 }, (_, i) => ({ reservation_number: `6040${i}`, checkin: '2027-03-09', checkout: '2027-03-11', room: `${1 + (i % 6)}${String(1 + Math.floor(i / 6) % 10).padStart(2, '0')}${'AB'[Math.floor(i / 60)] || 'A'}`.replace(/^(\\d)(05|06)A$/, '$1$2B'), board: 'FAP', pax: 2, children: 0 })));
  rebalance(d, 'almoco');
  const sum = daySummary(d, 'almoco').filter((r) => r.serves);
  const tot = sum.reduce((s, r) => s + r.pax, 0);
  const dg = sum.find((r) => r.code === 'DG');
  assert.ok(Math.abs(dg.pax / tot - 0.6) < 0.06, `DG ${dg.pax}/${tot}`);
  assert.equal(dg.share, 0.6);
});

test('dois abertos e 400 pessoas ou mais: Di Giordana recebe até 300', () => {
  const { restaurantsFor, rebalance, daySummary } = require('../src/meals');
  const d = '2027-04-14';
  const mae = db.prepare("SELECT id FROM restaurants WHERE code = 'MAE'").get().id;
  db.prepare("INSERT OR REPLACE INTO restaurant_days(date, restaurant_id, meal, is_open, note) VALUES (?, ?, 'janta', 0, 'teste')").run(d, mae);
  const rooms = [];
  for (const t of 'CDEFGH') for (let f = 1; f <= 6; f++) for (let u = 1; u <= 10; u++) rooms.push(`${f}${String(u).padStart(2, '0')}${t}`);
  upsertReservations(rooms.slice(0, 220).map((room, i) => ({ reservation_number: `4000${i}`, checkin: '2027-04-14', checkout: '2027-04-16', room, board: 'FAP', pax: 2, children: 0 })));
  rebalance(d, 'janta');
  const sum = daySummary(d, 'janta').filter((r) => r.serves);
  const tot = sum.reduce((s, r) => s + r.pax, 0);
  assert.ok(tot >= 400, 'movimento de ' + tot);
  const dg = sum.find((r) => r.code === 'DG');
  assert.ok(Math.abs(dg.pax - 300) <= 4, `DG ${dg.pax} de ${tot}`);
  assert.ok(restaurantsFor('janta', d)[0].share > 0.6);
});

test('relatórios do Silbeck (texto do PDF): previsão de faturamento e vendas por funcionário', () => {
  const { parseForecast, parseSales } = require('../src/silbeck-pdf');
  const prev = `RESORT TERMAS ROMANAS
                                 Previsão de Faturamento/Ocupação (01/10/2026 à 31/10/2026)
 01/10   QUI          716        505    70,53     211         360,82    358     242   67,60    116      752,95        182.216,24
Total              22196     12838      57,84   9358          343,03   11098   6123   55,17   4975      719,23      4.403.818,85
* Permanência Média: 2,10 dias
Gerado por: Silbeck - SB Hotel em 02/10/2026 13:20:36 Usuário: X`;
  const f = parseForecast(prev);
  assert.equal(f.month, '2026-10'); assert.equal(f.revenue, 4403818.85); assert.equal(f.apts_pct, 55.17); assert.equal(f.beds_pct, 57.84);
  assert.equal(f.apts_occ, 6123); assert.equal(f.days.length, 1); assert.equal(f.generated_at, '2026-10-02 13:20');
  const vend = `Lista de Walk-ins/Reservas por Funcionário (02/10/2026 à 02/10/2026)
TISSIANO BERTOLDO ZASSO      0       0       0     0       0       0        0,00    11       0       8    22       0      16   9.627,00    11       0       8    22        0     16    9.627,00
FLAVIO LOPES                 0       0       0     0       0       0        0,00  600        0     200 1200        0     400 165.000,00  600        0     200 1200         0    400 165.000,00
                 Totais:     0       0       0     0       0       0        0,00  611        0     208 1222        0     416 174.627,00  611        0     208 1222         0    416 174.627,00
                                                                                                                                                                Total Líquido:      174.627,00`;
  const v = parseSales(vend);
  assert.equal(v.sellers.length, 2);
  assert.deepEqual([v.sellers[1].name, v.sellers[1].room_nights, v.sellers[1].value], ['FLAVIO LOPES', 600, 165000]);
  assert.equal(v.total, 174627);
});

test('planilha .xls (Excel 97–2003) é lida como a .xlsx', () => {
  const { readSpreadsheet } = require('../src/xlsx');
  const rows = readSpreadsheet(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'amostra.xls')), 'amostra.xls');
  assert.deepEqual(rows[0], ['Apartamento', 'Nome', 'Valor', 'Observação']);
  assert.deepEqual(rows[1].slice(0, 2), ['101B', 'João Ávila']);
  assert.equal(rows[2][2], 1000);
});
