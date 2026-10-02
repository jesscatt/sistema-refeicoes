'use strict';
// Mini framework HTTP (sem dependências): rotas, JSON, sessões por cookie e arquivos estáticos.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 14);
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

const PORTAL_ROLES = ['agencia']; // Comercial: só as rotas marcadas com portal ou que listam o perfil

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Arquivo muito grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    res.writeHead(status, headers);
    res.end(body);
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }
}

function sessionUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const row = db.prepare(`SELECT s.sid, s.expires_at, u.id, u.username, u.name, u.role, u.restaurant_id, u.agency, u.reservation_number, u.active, u.must_change_password, u.rest_admin, u.login_code
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?`).get(sid);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  // sessão deslizante
  if (row.expires_at - Date.now() < (SESSION_HOURS * 3600e3) / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(Date.now() + SESSION_HOURS * 3600e3, sid);
  }
  return row;
}

function createSession(res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(sid, user_id, expires_at) VALUES (?,?,?)').run(sid, userId, Date.now() + SESSION_HOURS * 3600e3);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${COOKIE_SECURE ? '; Secure' : ''}`);
}

function destroySession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, root) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) return send(res, 403, 'Proibido');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA: qualquer rota desconhecida volta para o index
      return fs.readFile(path.join(root, 'index.html'), (e, data) => (e ? send(res, 404, 'Não encontrado') : send(res, 200, data, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })));
    }
    // HTML/JS/CSS sempre da versão publicada (evita tela misturando arquivo novo com antigo após atualização)
    const ext = path.extname(file);
    const cache = ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-store' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

/*
 * opts: { auth: true|false (padrão true), roles: [...], raw: bytes (corpo binário), apiKey: true }
 * handler(ctx) -> objeto (JSON) | { __raw: Buffer|string, headers }
 */
async function handle(req, res, publicDir, apiKeyAuth) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
    return serveStatic(req, res, publicDir);
  }
  const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!match) return send(res, 404, { error: 'Rota não encontrada' });
  const params = {};
  const m = url.pathname.match(match.re);
  match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
  const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), ip: clientIp(req), user: null, body: null };
  try {
    if (match.opts.apiKey) {
      ctx.apiClient = apiKeyAuth(req);
      if (!ctx.apiClient) throw new HttpError(401, 'Chave de API inválida ou ausente (cabeçalho X-API-Key).');
    } else if (match.opts.auth !== false) {
      ctx.user = sessionUser(req);
      if (!ctx.user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
      if (match.opts.roles && !match.opts.roles.includes(ctx.user.role)) throw new HttpError(403, 'Seu perfil não tem acesso a esta função.');
      // Agência e Cliente final só acessam as rotas liberadas para o portal (as próprias reservas)
      if (PORTAL_ROLES.includes(ctx.user.role) && !match.opts.portal && !(match.opts.roles && match.opts.roles.includes(ctx.user.role))) {
        throw new HttpError(403, 'Seu perfil não tem acesso a esta função.');
      }
      // Proteção CSRF: toda alteração exige o cabeçalho enviado pelo próprio app
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Requisição bloqueada.');
      if (ctx.user.must_change_password && !match.opts.allowPwChange) throw new HttpError(428, 'Troque sua senha para continuar.');
    }
    if (req.method !== 'GET') {
      const buf = await readBody(req, match.opts.raw || 2 * 1024 * 1024);
      if (match.opts.raw) ctx.body = buf;
      else if (buf.length) {
        try { ctx.body = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido.'); }
      } else ctx.body = {};
    }
    const out = await match.handler(ctx);
    if (res.headersSent) return;
    if (out && out.__raw !== undefined) return send(res, 200, out.__raw, out.headers || {});
    send(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Erro interno: ' + e.message });
  }
}

module.exports = { route, handle, HttpError, createSession, destroySession, send, PORTAL_ROLES };
