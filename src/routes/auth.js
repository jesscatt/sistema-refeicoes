'use strict';
const { route, HttpError, createSession, destroySession } = require('../http');
const { db, verifyPassword, hashPassword, audit } = require('../db');
const { BOARDS, MEAL_LABEL } = require('../util');

const attempts = new Map(); // ip|user -> {n, until}

route('GET', '/api/health', { auth: false }, () => ({ ok: true }));

// Acha o usuário pelo número de acesso (ou, por compatibilidade, pelo nome de usuário antigo)
function findLogin(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? db.prepare('SELECT * FROM users WHERE login_code = ?').get(s) : db.prepare('SELECT * FROM users WHERE username = ?').get(s);
}

// Passo 1 do login: digita o número e aparece o nome. Limitado por IP para evitar varredura.
const lookups = new Map(); // ip -> {n, from}
route('POST', '/api/login/lookup', { auth: false }, ({ body, ip }) => {
  const now = Date.now();
  const l = lookups.get(ip);
  const cur = l && now - l.from < 5 * 60e3 ? l : { n: 0, from: now };
  cur.n++; lookups.set(ip, cur);
  if (cur.n > 30) throw new HttpError(429, 'Muitas consultas. Aguarde alguns minutos.');
  const u = findLogin(body.code);
  if (!u || !u.active) throw new HttpError(404, 'Login não encontrado.');
  const rest = u.restaurant_id ? db.prepare('SELECT name FROM restaurants WHERE id = ?').get(u.restaurant_id) : null;
  const roles = { admin: 'Administrador', supervisor: 'Supervisão', refeicao: 'Refeição', recepcao: 'Recepção', restaurante: 'Restaurante', agencia: 'Comercial' };
  return { code: u.login_code, name: u.name, role: roles[u.role] + (rest ? ' · ' + rest.name : '') + (u.role === 'restaurante' && u.rest_admin ? ' · administrador' : '') };
});

route('POST', '/api/login', { auth: false }, ({ body, res, ip }) => {
  const username = String(body.code || body.username || '').trim();
  const key = `${ip}|${username.toLowerCase()}`;
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  const u = findLogin(username);
  if (!u || !u.active || !verifyPassword(body.password || '', u.password_hash)) {
    const n = (a && a.until > Date.now() - 15 * 60e3 ? a.n : 0) + 1;
    attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    audit(u || null, 'login_falhou', { username }, ip);
    throw new HttpError(401, 'Login ou senha incorretos.');
  }
  attempts.delete(key);
  createSession(res, u.id);
  db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(u.id);
  audit(u, 'login', null, ip);
  return { ok: true };
});

route('POST', '/api/logout', { allowPwChange: true, portal: true }, ({ req, res, user, ip }) => {
  audit(user, 'logout', null, ip);
  destroySession(req, res);
  return { ok: true };
});

route('GET', '/api/me', { allowPwChange: true, portal: true }, ({ user }) => {
  const rest = user.restaurant_id ? db.prepare('SELECT id, code, name, color FROM restaurants WHERE id = ?').get(user.restaurant_id) : null;
  return { id: user.id, username: user.username, login_code: user.login_code, name: user.name, role: user.role, restaurant: rest, agency: user.agency || null, reservation_number: user.reservation_number || null, must_change_password: !!user.must_change_password, rest_admin: !!(user.role === 'restaurante' && user.rest_admin) };
});

route('POST', '/api/me/password', { allowPwChange: true, portal: true }, ({ user, body, ip }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(body.current || '', u.password_hash)) throw new HttpError(400, 'Senha atual incorreta.');
  const pw = String(body.password || '');
  if (pw.length < 8) throw new HttpError(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(pw), user.id);
  audit(user, 'senha_alterada', null, ip);
  return { ok: true };
});

route('GET', '/api/meta', { allowPwChange: true, portal: true }, () => ({
  restaurants: db.prepare('SELECT * FROM restaurants WHERE active = 1 ORDER BY id').all(),
  meal_times: db.prepare('SELECT * FROM meal_times ORDER BY sort').all(),
  boards: BOARDS,
  meals: MEAL_LABEL,
  max_pax_room: require('../db').maxPaxRoom(),
  roles: {
    admin: 'Administrador', supervisor: 'Supervisão', refeicao: 'Refeição',
    recepcao: 'Recepção', restaurante: 'Restaurante', agencia: 'Comercial',
  },
}));
