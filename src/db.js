'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'refeicoes.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
// Funções SQL para quartos com letra da torre (ver util.roomKey)
{
  const { roomKey, roomSort } = require('./util');
  db.function('room_key', { deterministic: true }, (v) => roomKey(v));
  db.function('room_sort', { deterministic: true }, (v) => roomSort(v));
  // texto sem acento e em maiúsculas (busca de agência pelo nome)
  db.function('norm_txt', { deterministic: true }, (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim());
}

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#00889b',
  share_cafe REAL NOT NULL DEFAULT 0,
  share_almoco REAL NOT NULL DEFAULT 0,
  share_janta REAL NOT NULL DEFAULT 0,
  cap_cafe INTEGER NOT NULL DEFAULT 0,
  cap_almoco INTEGER NOT NULL DEFAULT 0,
  cap_janta INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor','refeicao','recepcao','restaurante','agencia','cliente')),
  restaurant_id INTEGER REFERENCES restaurants(id),
  agency TEXT,
  reservation_number TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meal_times (
  meal TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  notify_before_min INTEGER NOT NULL DEFAULT 40,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  reservation_number TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  checkin TEXT NOT NULL,
  checkout TEXT NOT NULL,
  room TEXT NOT NULL,
  board TEXT NOT NULL CHECK (board IN ('SA','CM','MAP','MAPA','FAP')),
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'excel',
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
  pref_restaurant_id INTEGER REFERENCES restaurants(id),
  lunch_on_arrival INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_res_dates ON reservations(checkin, checkout);
CREATE INDEX IF NOT EXISTS idx_res_room ON reservations(room);
CREATE INDEX IF NOT EXISTS idx_res_number ON reservations(reservation_number);

CREATE TABLE IF NOT EXISTS room_changes (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  old_room TEXT NOT NULL,
  new_room TEXT NOT NULL,
  source TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Em qual restaurante cada reserva faz cada refeição em cada dia
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  locked INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'auto',
  UNIQUE (reservation_id, date, meal)
);
CREATE INDEX IF NOT EXISTS idx_asg_day ON assignments(date, meal, restaurant_id);

-- Presença registrada pelo restaurante. UNIQUE impede duplicidade entre restaurantes.
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  assigned_restaurant_id INTEGER REFERENCES restaurants(id),
  status TEXT NOT NULL CHECK (status IN ('presente','fora_lista')),
  adults INTEGER NOT NULL,
  children INTEGER NOT NULL,
  room TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (reservation_id, date, meal)
);
CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(date, meal, restaurant_id);

-- Registro de clientes que vieram sem ter a refeição na pensão (pagam à parte)
CREATE TABLE IF NOT EXISTS walkins (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  room TEXT,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  adults INTEGER NOT NULL DEFAULT 0,
  children INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS meal_lists (
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by INTEGER REFERENCES users(id),
  auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, meal)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  role TEXT,
  restaurant_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (notification_id, user_id)
);

-- Planilha de controle unificada: valor real informado pelo restaurante (a previsão vem das distribuições)
CREATE TABLE IF NOT EXISTS control_real (
  date TEXT NOT NULL,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  meal TEXT NOT NULL,
  real_adults INTEGER,
  real_children INTEGER,
  notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (date, restaurant_id, meal)
);

CREATE TABLE IF NOT EXISTS prices (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  meal TEXT NOT NULL,
  price_adult REAL NOT NULL DEFAULT 0,
  price_child REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, meal)
);

CREATE TABLE IF NOT EXISTS billing_closures (
  month TEXT PRIMARY KEY,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at);
`);

// ---------- Migrações ----------
// v2: a mesma reserva pode ter vários quartos (grupos) -> sai o UNIQUE do número da reserva;
//     novos campos: almoço no dia da chegada e dias de fechamento dos restaurantes.
{
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const resSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reservations'").get() || {}).sql || '';
  if (/reservation_number\s+TEXT\s+UNIQUE/i.test(resSql)) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE reservations_v2 (
        id INTEGER PRIMARY KEY,
        reservation_number TEXT NOT NULL,
        guest_name TEXT NOT NULL,
        checkin TEXT NOT NULL,
        checkout TEXT NOT NULL,
        room TEXT NOT NULL,
        board TEXT NOT NULL CHECK (board IN ('SA','CM','MAP','MAPA','FAP')),
        adults INTEGER NOT NULL DEFAULT 1,
        children INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'excel',
        status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
        pref_restaurant_id INTEGER REFERENCES restaurants(id),
        lunch_on_arrival INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`);
      db.exec(`INSERT INTO reservations_v2(id, reservation_number, guest_name, checkin, checkout, room, board, adults, children, source, status, pref_restaurant_id, notes, created_at, updated_at)
        SELECT id, reservation_number, guest_name, checkin, checkout, room, board, adults, children, source, status, pref_restaurant_id, notes, created_at, updated_at FROM reservations`);
      db.exec('DROP TABLE reservations');
      db.exec('ALTER TABLE reservations_v2 RENAME TO reservations');
      db.exec('CREATE INDEX IF NOT EXISTS idx_res_dates ON reservations(checkin, checkout)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_res_room ON reservations(room)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_res_number ON reservations(reservation_number)');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  // v3: perfis Agência e Cliente final (vinculados a um nome de agência ou a um número de reserva)
  const usersSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() || {}).sql || '';
  if (usersSql && !usersSql.includes("'agencia'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE users_v3 (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','supervisor','refeicao','recepcao','restaurante','agencia','cliente')),
        restaurant_id INTEGER REFERENCES restaurants(id),
        agency TEXT,
        reservation_number TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        last_login_at TEXT
      )`);
      db.exec(`INSERT INTO users_v3(id, username, name, password_hash, role, restaurant_id, active, must_change_password, created_at, last_login_at)
        SELECT id, username, name, password_hash, role, restaurant_id, active, must_change_password, created_at, last_login_at FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_v3 RENAME TO users');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  if (!cols('reservations').includes('lunch_on_arrival')) db.exec('ALTER TABLE reservations ADD COLUMN lunch_on_arrival INTEGER NOT NULL DEFAULT 0');
  // Dias da semana em que o restaurante NÃO serve a refeição (0 = domingo ... 6 = sábado), ex.: "3" = fechado na quarta
  for (const m of ['cafe', 'almoco', 'janta']) {
    if (!cols('restaurants').includes(`closed_${m}`)) db.exec(`ALTER TABLE restaurants ADD COLUMN closed_${m} TEXT NOT NULL DEFAULT ''`);
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const ref = Buffer.from(hashHex, 'hex');
  return ref.length === hash.length && crypto.timingSafeEqual(ref, hash);
}

function seed() {
  if (!db.prepare('SELECT COUNT(*) n FROM restaurants').get().n) {
    const ins = db.prepare(`INSERT INTO restaurants(code, name, color, share_cafe, share_almoco, share_janta) VALUES (?,?,?,?,?,?)`);
    // Regra: Di Giordana 60%; Paradiso e Maestro dividem os 40% (20% cada). Café só Di Giordana (60%) e Paradiso (40%).
    ins.run('DG', 'Di Giordana', '#00889b', 0.6, 0.6, 0.6);
    ins.run('PAR', 'Paradiso', '#4f8f2f', 0.4, 0.2, 0.2);
    ins.run('MAE', 'Churrascaria Maestro', '#a4502d', 0, 0.2, 0.2);
  }
  // Cores antigas do primeiro tema -> cores da marca Termas Romanas
  for (const [oldC, newC] of [['#b5532c', '#00889b'], ['#6b7f3a', '#4f8f2f'], ['#8a3b2e', '#a4502d']]) {
    db.prepare('UPDATE restaurants SET color = ? WHERE lower(color) = ?').run(newC, oldC);
  }
  if (!db.prepare('SELECT COUNT(*) n FROM meal_times').get().n) {
    const ins = db.prepare('INSERT INTO meal_times(meal, label, start, end, notify_before_min, sort) VALUES (?,?,?,?,?,?)');
    ins.run('cafe', 'Café da manhã', '07:30', '10:00', 40, 1);
    ins.run('almoco', 'Almoço', '12:00', '14:30', 40, 2);
    ins.run('janta', 'Jantar', '19:00', '22:30', 40, 3);
  }
  const rests = db.prepare('SELECT id FROM restaurants').all();
  const insP = db.prepare('INSERT OR IGNORE INTO prices(restaurant_id, meal, price_adult, price_child) VALUES (?,?,0,0)');
  for (const r of rests) for (const m of ['cafe', 'almoco', 'janta']) insP.run(r.id, m);

  // Dois administradores iniciais (admin e dev). Senhas vêm de variáveis de ambiente ou são geradas.
  if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) {
    const created = [];
    for (const [username, name, envVar] of [['admin', 'Administrador', 'ADMIN_PASSWORD'], ['dev', 'Desenvolvimento', 'DEV_PASSWORD']]) {
      const pw = process.env[envVar] || crypto.randomBytes(6).toString('base64url');
      db.prepare('INSERT INTO users(username, name, password_hash, role, must_change_password) VALUES (?,?,?,?,1)')
        .run(username, name, hashPassword(pw), 'admin');
      created.push({ username, pw, fromEnv: !!process.env[envVar] });
    }
    console.log('\n=== Usuários administradores criados ===');
    for (const c of created) console.log(`  ${c.username} / ${c.fromEnv ? '(senha definida por variável de ambiente)' : c.pw}`);
    console.log('  Troque as senhas no primeiro acesso.\n');
  }
}
seed();

function audit(user, action, details, ip) {
  db.prepare('INSERT INTO audit_log(user_id, username, action, details, ip) VALUES (?,?,?,?,?)')
    .run(user ? user.id : null, user ? user.username : null, action, details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)), ip || null);
}

function notify({ role = null, restaurant_id = null, kind, title, body = null, link = null }) {
  db.prepare('INSERT INTO notifications(role, restaurant_id, kind, title, body, link) VALUES (?,?,?,?,?,?)')
    .run(role, restaurant_id, kind, title, body, link);
}

module.exports = { db, tx, getSetting, setSetting, hashPassword, verifyPassword, audit, notify, DATA_DIR };
