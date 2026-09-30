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
