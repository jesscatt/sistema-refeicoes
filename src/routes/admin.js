'use strict';
const crypto = require('node:crypto');
const { route, HttpError } = require('../http');
const { db, tx, hashPassword, audit, getSetting, setSetting, nextLoginCode } = require('../db');
const { MEALS } = require('../util');

const ADMIN = ['admin'];
const ROLES = ['admin', 'supervisor', 'refeicao', 'recepcao', 'restaurante', 'agencia'];

// ---------- Usuários ----------
route('GET', '/api/users', { roles: ADMIN }, () =>
  db.prepare(`SELECT u.id, u.username, u.login_code, u.name, u.role, u.rest_admin, u.restaurant_id, u.agency, u.reservation_number, u.active, u.must_change_password, u.created_at, u.last_login_at, r.name restaurant_name
    FROM users u LEFT JOIN restaurants r ON r.id = u.restaurant_id ORDER BY u.active DESC, CAST(u.login_code AS INTEGER)`).all());

route('GET', '/api/users/next-code', { roles: ADMIN }, () => ({ code: nextLoginCode() }));

function validCode(v, exceptId = 0) {
  const c = String(v ?? '').trim();
  if (!/^\d{3,8}$/.test(c)) throw new HttpError(400, 'Login: somente números, de 3 a 8 dígitos.');
  if (db.prepare('SELECT 1 FROM users WHERE login_code = ? AND id != ?').get(c, exceptId)) throw new HttpError(409, `O número ${c} já é de outro usuário.`);
  return c;
}

function validUser(body, isNew) {
  const username = String(body.username || '').trim().toLowerCase();
  if (isNew && !/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, 'Usuário: 3 a 30 caracteres (letras, números, ponto, hífen).');
  if (!String(body.name || '').trim()) throw new HttpError(400, 'Informe o nome.');
  if (!ROLES.includes(body.role)) throw new HttpError(400, 'Perfil inválido.');
  const restId = body.role === 'restaurante' ? Number(body.restaurant_id) : null;
  if (body.role === 'restaurante' && !db.prepare('SELECT 1 FROM restaurants WHERE id = ?').get(restId)) throw new HttpError(400, 'Selecione o restaurante do usuário.');
  return { username, name: String(body.name).trim(), role: body.role, restaurant_id: restId, agency: null, reservation_number: null, rest_admin: body.role === 'restaurante' && (body.rest_admin === true || body.rest_admin === 1 || body.rest_admin === '1' || body.rest_admin === 'on') ? 1 : 0 };
}

route('POST', '/api/users', { roles: ADMIN }, ({ body, user, ip }) => {
  const code = validCode(body.login_code || nextLoginCode());
  if (!String(body.username || '').trim()) body.username = 'u' + code; // o login é pelo número; nome de usuário interno
  const u = validUser(body, true);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw new HttpError(409, 'Já existe esse usuário.');
  const pw = body.password && String(body.password).length >= 8 ? String(body.password) : crypto.randomBytes(6).toString('base64url');
  const r = db.prepare('INSERT INTO users(username, login_code, name, password_hash, role, restaurant_id, agency, reservation_number, rest_admin, must_change_password) VALUES (?,?,?,?,?,?,?,?,?,1)')
    .run(u.username, code, u.name, hashPassword(pw), u.role, u.restaurant_id, u.agency, u.reservation_number, u.rest_admin);
  audit(user, 'usuario_criado', { username: u.username, login_code: code, role: u.role }, ip);
  return { id: Number(r.lastInsertRowid), login_code: code, temp_password: body.password ? null : pw };
});

route('PUT', '/api/users/:id', { roles: ADMIN }, ({ params, body, user, ip }) => {
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!ex) throw new HttpError(404, 'Usuário não encontrado.');
  const u = validUser({ ...ex, ...body }, false);
  const active = body.active === undefined ? ex.active : (body.active ? 1 : 0);
  if (ex.role === 'admin' && (u.role !== 'admin' || !active)) {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
  }
  const code = body.login_code === undefined ? ex.login_code : validCode(body.login_code, ex.id);
  db.prepare('UPDATE users SET name = ?, role = ?, restaurant_id = ?, agency = ?, reservation_number = ?, active = ?, login_code = ?, rest_admin = ? WHERE id = ?').run(u.name, u.role, u.restaurant_id, u.agency, u.reservation_number, active, code, body.rest_admin === undefined && u.role === 'restaurante' ? ex.rest_admin : u.rest_admin, ex.id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(ex.id);
  audit(user, 'usuario_alterado', { username: ex.username, role: u.role, active }, ip);
  return { ok: true };
});

route('POST', '/api/users/:id/reset-password', { roles: ADMIN }, ({ params, user, ip }) => {
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!ex) throw new HttpError(404, 'Usuário não encontrado.');
  const pw = crypto.randomBytes(6).toString('base64url');
  // admin e dev não são obrigados a trocar a senha provisória
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(hashPassword(pw), ['admin', 'dev'].includes(String(ex.username).toLowerCase()) ? 0 : 1, ex.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(ex.id);
  audit(user, 'senha_resetada', { username: ex.username }, ip);
  return { temp_password: pw };
});

// ---------- Restaurantes e horários ----------
route('PUT', '/api/restaurants/:id', { roles: ADMIN }, ({ params, body, user, ip }) => {
  const ex = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(params.id);
  if (!ex) throw new HttpError(404, 'Restaurante não encontrado.');
  const pct = (v, d) => (v === undefined ? d : Math.max(0, Math.min(1, Number(v) || 0)));
  const cap = (v, d) => (v === undefined ? d : Math.max(0, parseInt(v, 10) || 0));
  const n = {
    name: String(body.name ?? ex.name).trim() || ex.name,
    color: /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : ex.color,
    share_cafe: pct(body.share_cafe, ex.share_cafe), share_almoco: pct(body.share_almoco, ex.share_almoco), share_janta: pct(body.share_janta, ex.share_janta),
    cap_cafe: cap(body.cap_cafe, ex.cap_cafe), cap_almoco: cap(body.cap_almoco, ex.cap_almoco), cap_janta: cap(body.cap_janta, ex.cap_janta),
  };
  // dias da semana fechados (0 = domingo ... 6 = sábado)
  const days = (v, d) => (v === undefined ? d : [...new Set((Array.isArray(v) ? v : String(v).split(',')).map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x <= 6))].sort().join(','));
  for (const m of MEALS) n[`closed_${m}`] = days(body[`closed_${m}`], ex[`closed_${m}`] || '');
  db.prepare(`UPDATE restaurants SET name=?, color=?, share_cafe=?, share_almoco=?, share_janta=?, cap_cafe=?, cap_almoco=?, cap_janta=?,
    closed_cafe=?, closed_almoco=?, closed_janta=? WHERE id = ?`)
    .run(n.name, n.color, n.share_cafe, n.share_almoco, n.share_janta, n.cap_cafe, n.cap_almoco, n.cap_janta, n.closed_cafe, n.closed_almoco, n.closed_janta, ex.id);
  audit(user, 'restaurante_alterado', { code: ex.code, ...n }, ip);
  return { ok: true };
});

route('PUT', '/api/meal-times', { roles: ADMIN }, ({ body, user, ip }) => {
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const t of body.meal_times || []) {
    if (!MEALS.includes(t.meal) || !hm.test(t.start) || !hm.test(t.end)) throw new HttpError(400, 'Horário inválido (use HH:MM).');
    db.prepare('UPDATE meal_times SET start = ?, end = ?, notify_before_min = ? WHERE meal = ?')
      .run(t.start, t.end, Math.max(0, Math.min(240, parseInt(t.notify_before_min, 10) || 40)), t.meal);
  }
  audit(user, 'horarios_alterados', body.meal_times, ip);
  return { ok: true };
});

// ---------- Começar do zero: apaga reservas e tudo ligado a elas (mantém usuários, restaurantes e valores) ----------
route('POST', '/api/admin/reset-reservations', { roles: ADMIN }, ({ body, user, ip }) => {
  if (String(body.confirm || '').trim().toUpperCase() !== 'APAGAR') throw new HttpError(400, 'Digite APAGAR para confirmar.');
  const n = db.prepare('SELECT COUNT(*) n FROM reservations').get().n;
  tx(() => {
    for (const t of ['attendance', 'assignments', 'room_changes', 'walkins', 'meal_lists', 'control_real', 'billing_closures', 'reservations']) db.exec(`DELETE FROM ${t}`);
  });
  audit(user, 'reservas_apagadas', { quartos: n }, ip);
  return { deleted: n };
});

// ---------- Logs ----------
route('GET', '/api/audit', { roles: ['admin', 'supervisor', 'refeicao'] }, ({ query }) => {
  const where = [], args = [];
  if (query.q) { where.push('(action LIKE ? OR details LIKE ? OR username LIKE ?)'); args.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
  if (query.from) { where.push('created_at >= ?'); args.push(query.from); }
  if (query.to) { where.push('created_at <= ?'); args.push(query.to + ' 23:59:59'); }
  return db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...args);
});

// ---------- Chaves de API (site / Silbeck) ----------
route('GET', '/api/api-keys', { roles: ADMIN }, () => db.prepare('SELECT id, name, source, prefix, active, created_at, last_used_at FROM api_keys ORDER BY id DESC').all());

route('POST', '/api/api-keys', { roles: ADMIN }, ({ body, user, ip }) => {
  const name = String(body.name || '').trim();
  const source = ['site', 'silbeck', 'outro'].includes(body.source) ? body.source : 'outro';
  if (!name) throw new HttpError(400, 'Dê um nome para a chave.');
  const key = 'rf_' + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO api_keys(name, source, prefix, key_hash) VALUES (?,?,?,?)').run(name, source, key.slice(0, 8), crypto.createHash('sha256').update(key).digest('hex'));
  audit(user, 'chave_api_criada', { name, source }, ip);
  return { key };
});

route('DELETE', '/api/api-keys/:id', { roles: ADMIN }, ({ params, user, ip }) => {
  db.prepare('UPDATE api_keys SET active = 0 WHERE id = ?').run(params.id);
  audit(user, 'chave_api_revogada', { id: params.id }, ip);
  return { ok: true };
});

route('PUT', '/api/settings/policy', { roles: ADMIN }, ({ body, user, ip }) => {
  const n = parseInt(body.max_pax_room, 10);
  if (!(n >= 1 && n <= 20)) throw new HttpError(400, 'Informe um número entre 1 e 20.');
  setSetting('max_pax_room', n);
  audit(user, 'politica_alterada', { max_pax_room: n }, ip);
  return { ok: true };
});

route('GET', '/api/settings/integration', { roles: ADMIN }, () => ({
  silbeck_url: getSetting('silbeck_url', ''),
  silbeck_token_set: !!getSetting('silbeck_token'),
  silbeck_interval_min: Number(getSetting('silbeck_interval_min', '5')),
  silbeck_last_sync: getSetting('silbeck_last_sync'),
  silbeck_last_result: getSetting('silbeck_last_result'),
  ai_enabled: !!process.env.ANTHROPIC_API_KEY,
}));

route('PUT', '/api/settings/integration', { roles: ADMIN }, ({ body, user, ip }) => {
  if (body.silbeck_url !== undefined) {
    const u = String(body.silbeck_url).trim();
    if (u && !/^https:\/\//.test(u)) throw new HttpError(400, 'A URL precisa começar com https://');
    setSetting('silbeck_url', u);
  }
  if (body.silbeck_token) setSetting('silbeck_token', String(body.silbeck_token));
  if (body.silbeck_interval_min !== undefined) setSetting('silbeck_interval_min', Math.max(1, Math.min(120, parseInt(body.silbeck_interval_min, 10) || 5)));
  audit(user, 'integracao_configurada', { silbeck_url: body.silbeck_url }, ip);
  return { ok: true };
});
