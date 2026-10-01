// Utilidades de interface compartilhadas
export const state = { me: null, meta: null };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class ApiError extends Error { constructor(status, msg, data) { super(msg); this.status = status; this.data = data; } }

export async function api(method, url, body, opts = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  let payload;
  if (body instanceof ArrayBuffer || body instanceof Blob) { payload = body; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  Object.assign(headers, opts.headers || {});
  const r = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !url.endsWith('/login')) { window.dispatchEvent(new Event('logout')); }
    if (r.status === 428) { location.hash = '#/senha'; }
    throw new ApiError(r.status, (data && data.error) || 'Erro ' + r.status, data);
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const put = (u, b) => api('PUT', u, b ?? {});
export const del = (u) => api('DELETE', u);

export function toast(msg, type = 'ok', title = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = (title ? `<b>${esc(title)}</b>` : '') + `<span>${esc(msg)}</span>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 4500);
  return el;
}
export const fail = (e) => toast(e.message || String(e), 'err');

export function modal({ title, body, foot = '', wide = false, onMount }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2 class="grow">${title}</h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  const m = bg.querySelector('.modal');
  if (onMount) onMount(m, close);
  return { el: m, close };
}

export function confirmBox(text, okLabel = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    const { el, close } = modal({
      title: 'Confirmar', body: `<p style="margin:0">${text}</p>`,
      foot: `<button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>`,
    });
    el.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

// ---------- Formatação ----------
export const pad = (n) => String(n).padStart(2, '0');
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
export const br = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const weekday = (iso) => { const [y, m, d] = iso.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
export const dayLabel = (iso) => `${weekday(iso)}, ${br(iso).slice(0, 5)}`;
export const money = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const pct = (v) => `${Math.round((v || 0) * 1000) / 10}%`.replace('.', ',');
export const MEALS = ['cafe', 'almoco', 'janta'];
export const MEAL_LABEL = { cafe: 'Café', almoco: 'Almoço', janta: 'Jantar' };
export const MEAL_FULL = { cafe: 'Café da manhã', almoco: 'Almoço', janta: 'Jantar' };
export const ROLE_LABEL = { admin: 'Administrador', supervisor: 'Supervisão', refeicao: 'Refeição', recepcao: 'Recepção', restaurante: 'Restaurante', agencia: 'Comercial', cliente: 'Cliente final (desativado)' };

export function restTag(r) {
  if (!r) return '<span class="rest-tag none">—</span>';
  return `<span class="rest-tag" style="background:${esc(r.color || '#888')}">${esc(r.name)}</span>`;
}
// Quarto com letra da torre: "A101", "101a", "Torre A 101" -> chave "101A"
const ROOM_WORDS = /\b(TORRE|TOR|BLOCO|BL|APTO|APT|AP|UH|QUARTO|QTO|QT|NUMERO|NUM)\b|\bN\s*[º°]/g;
export function roomKey(v) {
  const s = String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(ROOM_WORDS, ' ');
  return (s.match(/\d/g) || []).join('').replace(/^0+(?=\d)/, '') + (s.match(/[A-Z]/g) || []).join('');
}
// Busca: "101" acha 101A e 101B; "101A" / "A101" acha só a torre A
export function roomMatches(room, q) {
  if (!/\d/.test(q)) return false;
  const k = roomKey(q), r = roomKey(room);
  return /^\d+$/.test(k) ? r === k || new RegExp('^' + k + '[A-Z]+$').test(r) : r === k;
}
// Número em destaque + selo com a letra da torre
export function roomHtml(room) {
  const k = roomKey(room), m = k.match(/^(\d+)([A-Z]+)$/);
  if (!m) return esc(room);
  return `${esc(m[1])}<span class="tower" title="Torre ${esc(m[2])}">${esc(m[2])}</span>`;
}
export const restDot = (r) => `<span class="dot" style="background:${esc(r.color)}"></span>`;
export const boardTag = (b) => `<span class="board" title="${esc((state.meta?.boards?.[b] || {}).label || '')}">${esc(b)}</span>`;
export const paxTxt = (a, c) => `${a} adt${c ? ` + ${c} chd` : ''}`;

export function mealIcon(meal) { return icon(meal === 'cafe' ? 'cup' : meal === 'almoco' ? 'plate' : 'moon'); }

export function hashParams() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}
export function setHashParams(params, page) {
  const base = location.hash.split('?')[0];
  if (page && base.replace(/^#\/?/, '') !== page) return; // página que já não está aberta não mexe no endereço
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  history.replaceState(null, '', base + (q ? '?' + q : ''));
}

export function can(...roles) { return state.me && roles.includes(state.me.role); }

// Quem acessa cada página (o servidor confere as mesmas permissões em cada rota)
const ALL = ['admin', 'supervisor', 'refeicao', 'recepcao', 'restaurante', 'agencia'];
export const PAGE_ROLES = {
  painel: ALL,
  servico: ['admin', 'refeicao', 'restaurante'],
  distribuicao: ['admin', 'supervisor', 'refeicao'],
  recepcao: ['admin', 'recepcao', 'agencia'],
  reservas: ['admin', 'refeicao'],
  importar: ['admin', 'refeicao'],
  minhas: ['admin', 'refeicao', 'agencia'],
  trocas: ['admin', 'refeicao', 'agencia'],
  semana: ['admin', 'supervisor', 'refeicao'],
  controle: ['admin', 'supervisor', 'refeicao'],
  faturamento: ['admin', 'supervisor', 'refeicao'],
  ia: ['admin', 'supervisor', 'refeicao'],
  usuarios: ['admin'],
  config: ['admin'],
  logs: ['admin', 'supervisor', 'refeicao'],
};
export const canSee = (page) => !!state.me && (PAGE_ROLES[page] || []).includes(state.me.role);

export function download(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- Ícones (traço) ----------
const P = {
  cup: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 2.5c-.6 1 .6 1.8 0 3M12 2.5c-.6 1 .6 1.8 0 3"/>',
  plate: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="3"/><path d="M2.5 4v5a1.5 1.5 0 0 0 3 0V4M4 9v11M21.5 4c-1.6 0-2.5 2.2-2.5 5h2.5v11"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/><path d="M16 3v3M14.5 4.5h3"/>',
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  split: '<path d="M12 3v7M12 10l-7 5v6M12 10l7 5v6M12 10v11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checklist: '<path d="m4 7 2 2 3.5-3.5M4 15l2 2 3.5-3.5"/><path d="M13 8h7M13 16h7"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M19 19v2H6"/><path d="M9 7h6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  sheet: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9h17M3.5 14.5h17M9.5 9v11.5"/>',
  coin: '<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/><path d="M4.5 6.5v5c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-5M4.5 11.5v5c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M15 8l2 2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// Markdown simples para respostas da IA (títulos, negrito, listas, tabelas)
export function markdown(md) {
  const lines = String(md).split('\n');
  let html = '', i = 0;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:\-|]+\|\s*$/.test(lines[i + 1])) {
      const cells = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      html += '<table><thead><tr>' + cells(l).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { html += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      html += '</tbody></table>';
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`;
    else if (/^\s*[-*]\s+/.test(l)) {
      html += '<ul>';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++; }
      html += '</ul>'; continue;
    } else if (/^\s*\d+\.\s+/.test(l)) {
      html += '<ol>';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`; i++; }
      html += '</ol>'; continue;
    } else if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}
