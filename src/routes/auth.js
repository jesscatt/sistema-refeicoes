'use strict';
const { route, HttpError, createSession, destroySession } = require('../http');
const { db, verifyPassword, hashPassword, audit } = require('../db');
const { BOARDS, MEAL_LABEL } = require('../util');

const attempts = new Map(); // ip|user -> {n, until}

route('GET', '/api/health', { auth: false }, () => ({ ok: true }));

route('POST', '/api/login', { auth: false }, ({ body, res, ip }) => {
  const username = String(body.username || '').trim();
  const key = `${ip}|${username.toLowerCase()}`;
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !u.active || !verifyPassword(body.password || '', u.password_hash)) {
    const n = (a && a.until > Date.now() - 15 * 60e3 ? a.n : 0) + 1;
    attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    audit(u || null, 'login_falhou', { username }, ip);
    throw new HttpError(401, 'Usuário ou senha incorretos.');
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
  return { id: user.id, username: user.username, name: user.name, role: user.role, restaurant: rest, agency: user.agency || null, reservation_number: user.reservation_number || null, must_change_password: !!user.must_change_password };
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
  roles: {
    admin: 'Administrador', supervisor: 'Supervisão', refeicao: 'Refeição',
    recepcao: 'Recepção', restaurante: 'Restaurante', agencia: 'Comercial',
  },
}));
