'use strict';
// Popula o banco com dados de demonstração (NÃO usar em produção).
//   npm run demo
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
process.env.DEV_PASSWORD = process.env.DEV_PASSWORD || 'dev12345';

const { db, hashPassword } = require('../src/db');
const { upsertReservations } = require('../src/importer');
const { todayISO, addDays } = require('../src/util');

const users = [
  ['supervisao', 'Supervisão', 'supervisor', null],
  ['refeicao', 'Setor de Refeições', 'refeicao', null],
  ['recepcao', 'Recepção', 'recepcao', null],
  ['digiordana', 'Di Giordana', 'restaurante', 'DG'],
  ['paradiso', 'Paradiso', 'restaurante', 'PAR'],
  ['maestro', 'Churrascaria Maestro', 'restaurante', 'MAE'],
];
for (const [username, name, role, code] of users) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) continue;
  const rest = code ? db.prepare('SELECT id FROM restaurants WHERE code = ?').get(code).id : null;
  db.prepare('INSERT INTO users(username, name, password_hash, role, restaurant_id) VALUES (?,?,?,?,?)').run(username, name, hashPassword('demo1234'), role, rest);
}
db.prepare("UPDATE users SET must_change_password = 0 WHERE username IN ('admin','dev')").run();

const first = ['Ana', 'Bruno', 'Carla', 'Daniel', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Otávio', 'Paula', 'Rafael', 'Sofia', 'Tiago', 'Vanessa', 'William'];
const last = ['Silva', 'Souza', 'Oliveira', 'Pereira', 'Lima', 'Carvalho', 'Ferreira', 'Rodrigues', 'Almeida', 'Costa', 'Gomes', 'Martins', 'Rocha', 'Ribeiro', 'Mendes'];
const boards = ['CM', 'MAP', 'MAP', 'MAPA', 'FAP', 'FAP', 'FAP'];
let seed = 7;
const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };

const today = todayISO();
const records = [];
for (let i = 0; i < 90; i++) {
  const start = addDays(today, rnd(9) - 4);
  records.push({
    reservation_number: String(50000 + i),
    guest_name: `${first[rnd(first.length)]} ${last[rnd(last.length)]} ${last[rnd(last.length)]}`,
    checkin: start, checkout: addDays(start, 2 + rnd(5)),
    room: String(100 * (1 + rnd(4)) + 1 + rnd(30)) + ['A', 'B', 'C'][rnd(3)],
    board: boards[rnd(boards.length)],
    adults: 1 + rnd(3), children: rnd(3),
  });
}
const r = upsertReservations(records, { source: 'excel' });
console.log(`Demo: ${r.inserted} reservas novas, ${r.updated} atualizadas.`);
console.log('Usuários: admin/admin1234 · dev/dev12345 · supervisao, refeicao, recepcao, digiordana, paradiso, maestro (senha demo1234)');
