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
  for (let i = 0; i < 200; i++) recs.push({ reservation_number: 'T' + i, guest_name: 'Hóspede ' + i, checkin: d0, checkout: addDays(d0, 2), room: String(100 + i), board: 'FAP', adults: 1 + (i % 3), children: i % 2 });
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
  const r = upsertReservations([{ reservation_number: 'T1', guest_name: 'Hóspede 1', checkin: '2026-11-10', checkout: '2026-11-12', room: '999', board: 'FAP', adults: 2, children: 1 }]);
  assert.equal(r.roomChanges.length, 1);
  assert.equal(r.roomChanges[0].old_room, '101');
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
  const find = (q) => { const m = roomMatch('room', q); return db.prepare(`SELECT reservation_number n FROM reservations WHERE ${m.sql} ORDER BY n`).all(...m.args).map((r) => r.n); };
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
  for (let i = 0; i < 12; i++) recs.push({ reservation_number: '77001 GRUPO TESTE', checkin: '2027-01-10', checkout: '2027-01-13', room: `${101 + i}A`, board: 'FAP', pax: 2, children: 0 });
  const r = upsertReservations(recs);
  assert.equal(r.inserted, 12);
  const split = db.prepare(`SELECT COUNT(*) n FROM (SELECT a.date, a.meal, COUNT(DISTINCT a.restaurant_id) k FROM assignments a JOIN reservations r ON r.id = a.reservation_id
    WHERE r.reservation_number = '77001' GROUP BY 1, 2 HAVING k > 1)`).get().n;
  assert.equal(split, 0, 'grupo não pode ser dividido entre restaurantes');
  // reimportar com um quarto trocado e um removido
  const again = recs.slice(0, 11).map((x, i) => (i === 0 ? { ...x, room: '999A' } : x));
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

test('portal: agência e cliente só veem e mexem nas próprias reservas', async () => {
  const http = require('node:http');
  const { hashPassword } = require('../src/db');
  require('../src/routes/auth'); require('../src/routes/reservations'); require('../src/routes/service');
  require('../src/routes/control'); require('../src/routes/admin'); require('../src/routes/portal');
  const { handle } = require('../src/http');
  const { apiKeyAuth } = require('../src/routes/integration');
  db.prepare("INSERT INTO users(username, name, password_hash, role, agency) VALUES ('ag1', 'Agência', ?, 'agencia', 'grupo teste')").run(hashPassword('senha-123'));
  db.prepare("INSERT INTO users(username, name, password_hash, role, reservation_number) VALUES ('cl1', 'Cliente', ?, 'cliente', '88001')").run(hashPassword('senha-123'));
  const srv = http.createServer((q, s) => handle(q, s, __dirname, apiKeyAuth)).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (u) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'senha-123' }) }); return r.headers.get('set-cookie').split(';')[0]; };
  const H = (c) => ({ cookie: c, 'x-requested-with': 'fetch', 'content-type': 'application/json' });
  try {
    const ag = await login('ag1');
    const list = await (await fetch(base + '/api/portal/reservations?past=1', { headers: H(ag) })).json();
    assert.ok(list.rows.length >= 10 && list.rows.every((r) => r.reservation_number === '77001'), 'agência vê só o grupo dela');
    assert.equal((await fetch(base + '/api/dashboard', { headers: H(ag) })).status, 403);
    assert.equal((await fetch(base + '/api/reservations', { headers: H(ag) })).status, 403);
    const cl = await login('cl1');
    const mine = await (await fetch(base + '/api/portal/reservations?past=1', { headers: H(cl) })).json();
    assert.equal(mine.rows.length, 1);
    // cliente não acessa reserva de outro
    assert.equal((await fetch(base + '/api/portal/reservations/' + list.rows[0].id, { headers: H(cl) })).status, 404);
    // pensão não muda pelo portal
    const id = mine.rows[0].id;
    await fetch(base + '/api/portal/reservations/' + id, { method: 'PUT', headers: H(cl), body: JSON.stringify({ board: 'CM', adults: 1 }) });
    const after = db.prepare('SELECT board, adults FROM reservations WHERE id = ?').get(id);
    assert.equal(after.board, 'FAP');
    assert.equal(after.adults, 1);
  } finally { srv.close(); }
});
