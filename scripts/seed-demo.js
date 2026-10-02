'use strict';
// Popula o banco com dados de demonstração (NÃO usar em produção).
//   npm run demo
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
process.env.DEV_PASSWORD = process.env.DEV_PASSWORD || 'dev12345';

const { db, hashPassword, assignLoginCodes } = require('../src/db');
const { upsertReservations } = require('../src/importer');
const { todayISO, addDays } = require('../src/util');

const users = [
  ['supervisao', 'Supervisão', 'supervisor', null],
  ['refeicao', 'Setor de Refeições', 'refeicao', null],
  ['recepcao', 'Recepção', 'recepcao', null],
  ['digiordana', 'Di Giordana', 'restaurante', 'DG'],
  ['paradiso', 'Paradiso', 'restaurante', 'PAR'],
  ['maestro', 'Churrascaria Maestro', 'restaurante', 'MAE'],
  // administradores dos restaurantes: veem o controle semanal e os valores
  ['adm.digiordana', 'Administração Di Giordana', 'restaurante', 'DG', { rest_admin: 1 }],
  ['adm.paradiso', 'Administração Paradiso', 'restaurante', 'PAR', { rest_admin: 1 }],
  ['adm.maestro', 'Administração Churrascaria', 'restaurante', 'MAE', { rest_admin: 1 }],
  // Comercial: valida quartos, trocas e envia os rooming lists das agências
  ['comercial', 'Comercial', 'agencia', null],
];
for (const [username, name, role, code, link = {}] of users) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) continue;
  const rest = code ? db.prepare('SELECT id FROM restaurants WHERE code = ?').get(code).id : null;
  db.prepare('INSERT INTO users(username, name, password_hash, role, restaurant_id, agency, reservation_number, rest_admin) VALUES (?,?,?,?,?,?,?,?)')
    .run(username, name, hashPassword('demo1234'), role, rest, link.agency || null, link.reservation_number || null, link.rest_admin || 0);
}
assignLoginCodes();
db.prepare("UPDATE users SET must_change_password = 0 WHERE username IN ('admin','dev')").run();

const first = ['Ana', 'Bruno', 'Carla', 'Daniel', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Otávio', 'Paula', 'Rafael', 'Sofia', 'Tiago', 'Vanessa', 'William'];
const last = ['Silva', 'Souza', 'Oliveira', 'Pereira', 'Lima', 'Carvalho', 'Ferreira', 'Rodrigues', 'Almeida', 'Costa', 'Gomes', 'Martins', 'Rocha', 'Ribeiro', 'Mendes'];
const boards = ['CM', 'MAP', 'MAP', 'MAPA', 'FAP', 'FAP', 'FAP'];
let seed = 7;
const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };

const today = todayISO();
const records = [];
// Dados de exemplo só entram em banco vazio (não mistura com reservas reais já importadas)
const hasData = db.prepare('SELECT COUNT(*) n FROM reservations').get().n > 0;
// grupos de exemplo (vários quartos na mesma reserva)
for (let i = 0; i < 8; i++) records.push({ reservation_number: '55778 SAUDADES TUR', checkin: addDays(today, -1), checkout: addDays(today, 2), room: `${201 + i}${'ABC'[i % 3]}`, board: 'FAP', adults: 2, children: i % 3 === 0 ? 1 : 0 });
for (let i = 0; i < 6; i++) records.push({ reservation_number: '50893 ANR TUR', checkin: today, checkout: addDays(today, 3), room: `${301 + i}C`, board: 'FAP', adults: 2, children: 0 });
records.push({ reservation_number: '57834 NELSON LUCAS PEREZ PEREIRA', checkin: addDays(today, -1), checkout: addDays(today, 3), room: '410B', board: 'FAP', adults: 2, children: 0 });
for (let i = 0; i < 90; i++) {
  const start = addDays(today, rnd(9) - 4);
  records.push({
    reservation_number: String(50000 + i),
    guest_name: `${first[rnd(first.length)]} ${last[rnd(last.length)]} ${last[rnd(last.length)]}`,
    checkin: start, checkout: addDays(start, 2 + rnd(5)),
    room: String(100 * (1 + rnd(6)) + 1 + rnd(10)) + 'DEFGH'[rnd(5)], // aptos 101–610, torres A–H
    board: boards[rnd(boards.length)],
    adults: 1 + rnd(3), children: rnd(3),
  });
}
if (hasData) console.log('Demo: banco já tem reservas; só os usuários de teste foram conferidos.');
else { const r = upsertReservations(records, { source: 'excel' }); console.log(`Demo: ${r.inserted} quartos de exemplo criados.`); }
console.log('Logins: 100 admin (admin1234) · 101 dev (dev12345) · 200 supervisão · 300 refeição · 400 recepção · 501 Di Giordana · 502 Paradiso · 503 Maestro · 511/512/513 administradores dos restaurantes · 600 comercial (senha demo1234)');
