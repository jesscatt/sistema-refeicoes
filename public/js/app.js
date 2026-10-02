import { state, esc, get, post, api, toast, fail, icon, mealIcon, MEAL_FULL, ROLE_LABEL, modal, PAGE_ROLES, hasRole } from './ui.js';

const root = document.getElementById('root');

// Menu por perfil (o servidor confere as mesmas permissões em cada rota)
const NAV = [
  { path: 'painel', label: 'Painel geral', icon: 'home', roles: PAGE_ROLES.painel },
  { sep: 'Operação' },
  { path: 'servico', label: 'Registro de refeições', icon: 'checklist', roles: PAGE_ROLES.servico },
  { path: 'distribuicao', label: 'Distribuição de hóspedes', icon: 'split', roles: PAGE_ROLES.distribuicao },
  { path: 'recepcao', label: 'Consulta de refeições', icon: 'card', roles: PAGE_ROLES.recepcao },
  { path: 'reservas', label: 'Reservas', icon: 'book', roles: PAGE_ROLES.reservas },
  { path: 'importar', label: 'Importação de reservas', icon: 'upload', roles: PAGE_ROLES.importar },
  { path: 'minhas', label: 'Rooming list', icon: 'users', roles: PAGE_ROLES.minhas },
  { path: 'trocas', label: 'Trocas de apartamento', icon: 'swap', roles: PAGE_ROLES.trocas },
  { sep: 'Gestão' },
  { path: 'financeiro', label: 'Controle de faturamento', labelFor: { rest_admin: 'Controle do restaurante' }, icon: 'sheet', roles: PAGE_ROLES.financeiro },
  { path: 'semana', label: 'Apuração semanal', icon: 'coin', roles: PAGE_ROLES.semana },
  { path: 'controle', label: 'Previsto x realizado', icon: 'sheet', roles: PAGE_ROLES.controle },
  { path: 'faturamento', label: 'Faturamento', icon: 'coin', roles: PAGE_ROLES.faturamento },
  { path: 'ia', label: 'Assistente de relatórios', icon: 'spark', roles: PAGE_ROLES.ia },
  { sep: 'Administração' },
  { path: 'usuarios', label: 'Usuários', icon: 'users', roles: PAGE_ROLES.usuarios },
  { path: 'config', label: 'Configurações', icon: 'gear', roles: PAGE_ROLES.config },
  { path: 'logs', label: 'Auditoria', icon: 'log', roles: PAGE_ROLES.logs },
];

const PAGES = {
  painel: () => import('./pages/painel.js'),
  minhas: () => import('./pages/minhas.js'),
  servico: () => import('./pages/servico.js'),
  distribuicao: () => import('./pages/distribuicao.js'),
  recepcao: () => import('./pages/recepcao.js'),
  reservas: () => import('./pages/reservas.js'),
  importar: () => import('./pages/importar.js'),
  trocas: () => import('./pages/trocas.js'),
  financeiro: () => import('./pages/financeiro.js'),
  semana: () => import('./pages/semana.js'),
  controle: () => import('./pages/controle.js'),
  faturamento: () => import('./pages/faturamento.js'),
  ia: () => import('./pages/ia.js'),
  usuarios: () => import('./pages/usuarios.js'),
  config: () => import('./pages/config.js'),
  logs: () => import('./pages/logs.js'),
  senha: () => import('./pages/senha.js'),
};

function homeFor() {
  return 'painel'; // todos começam pelo painel (aberturas do dia e avisos)
}

// ---------- Login ----------
function renderLogin(msg = '') {
  stopPolling();
  root.innerHTML = `
  <div class="login">
    <div class="login-card">
      <div class="login-hero">
        <img class="login-logo" src="/img/logo-branco.png" alt="Termas Romanas · Recanto Maestro">
        <div class="login-title">Controle de refeições</div>
      </div>
      <div class="login-body" id="login-body"></div>
    </div>
  </div>`;
  const body = root.querySelector('#login-body');
  const showMsg = (t) => { const m = body.querySelector('#login-msg'); m.classList.toggle('hidden', !t); m.querySelector('span').textContent = t || ''; };
  const msgHtml = (t) => `<div class="banner danger ${t ? '' : 'hidden'}" id="login-msg">${icon('alert')}<span>${esc(t)}</span></div>`;

  // Um só formulário: ao digitar o número (3+ dígitos) aparece o nome do usuário e o campo de senha
  function step1(code = '', err = '') {
    body.innerHTML = `<form id="login-form" autocomplete="on">
        <label class="f" id="codef">Login<input class="input login-code" name="code" inputmode="numeric" autocomplete="username" placeholder="" value="${esc(code)}" required autofocus></label>
        <div id="who"></div>
        <label class="f hidden" id="pwf">Senha<input class="input" name="password" type="password" autocomplete="current-password"></label>
        ${msgHtml(err)}
        <button class="btn primary lg" type="submit">Continuar</button>
      </form>`;
    const f = body.querySelector('form'), inp = f.querySelector('[name=code]'), pw = f.querySelector('[name=password]');
    const btn = f.querySelector('button[type=submit]'), who = f.querySelector('#who'), pwf = f.querySelector('#pwf'), codef = f.querySelector('#codef');
    let user = null, deb, seq = 0;
    const reset = () => { user = null; who.innerHTML = ''; codef.classList.remove('hidden'); pwf.classList.add('hidden'); pw.required = false; btn.textContent = 'Continuar'; };
    async function lookup(focusPw) {
      const v = inp.value.trim();
      if (v.length < 3) { reset(); return; }
      const my = ++seq;
      try {
        const u = await api('POST', '/api/login/lookup', { code: v });
        if (my !== seq) return;
        user = { ...u, typed: v }; showMsg('');
        const ini = (String(u.name).split(/\s+/).filter((x) => x.length > 2).length ? String(u.name).split(/\s+/).filter((x) => x.length > 2) : [String(u.name)]).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
        who.innerHTML = `<div class="login-who"><span class="av">${esc(ini)}</span><div class="grow"><b>${esc(u.name)}</b><small>${esc(u.role)}</small></div><button type="button" class="btn sm" id="not-me">Alterar usuário</button></div>`;
        who.querySelector('#not-me').onclick = () => { inp.value = ''; reset(); showMsg(''); inp.focus(); };
        codef.classList.add('hidden'); // depois de achar o usuário fica só o nome e a senha
        pwf.classList.remove('hidden'); pw.required = true; btn.textContent = 'Entrar';
        pw.focus();
      } catch (e) {
        if (my !== seq) return;
        reset(); if (e.status !== 404 || focusPw) showMsg(e.message);
      }
    }
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/\s/g, ''); reset(); showMsg(''); clearTimeout(deb); deb = setTimeout(() => lookup(false), 350); });
    if (code) lookup(false);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!user || user.typed !== inp.value.trim()) {
        if (/^\d+$/.test(inp.value.trim()) && inp.value.trim().length < 3) { showMsg('O login tem pelo menos 3 números.'); return; }
        clearTimeout(deb); await lookup(true); return;
      }
      if (!pw.value) { pw.focus(); return; }
      btn.disabled = true;
      try { await api('POST', '/api/login', { code: user.code, password: pw.value }); await boot(); }
      catch (err2) { showMsg(err2.message); btn.disabled = false; pw.value = ''; pw.focus(); }
    });
  }

  step1('', msg);
}

// ---------- Estrutura ----------
function renderShell() {
  const role = state.me.role;
  const items = NAV.filter((n) => !n.roles || hasRole(n.roles));
  // remove separadores sem itens depois
  const nav = items.filter((n, i) => !n.sep || (items[i + 1] && !items[i + 1].sep));
  root.innerHTML = `
  <div class="app" id="app">
    <aside class="side">
      <div class="brand"><img src="/img/emblema-branco.png" alt=""><div><div class="t">Termas Romanas</div><div class="s">Controle de refeições</div></div></div>
      <div class="meander"></div>
      <nav class="nav">${nav.map((n) => (n.sep ? `<div class="sep">${n.sep}</div>` : `<a href="#/${n.path}" data-path="${n.path}">${icon(n.icon)}<span>${(n.labelFor && Object.entries(n.labelFor).find(([k]) => hasRole([k]) && !hasRole(n.roles.filter((x) => x !== k)))?.[1]) || n.label}</span></a>`)).join('')}</nav>
      <div class="me">
        <b>${esc(state.me.name)}</b>
        <span class="role">${ROLE_LABEL[role]}${state.me.restaurant ? ' · ' + esc(state.me.restaurant.name) : ''}${state.me.rest_admin ? ' · administrador' : ''}</span>
        <div class="row"><button id="btn-pw">Senha</button><button id="btn-out">Sair</button></div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn burger" id="burger" aria-label="Menu">${icon('menu')}</button>
        <div class="now-meal" id="now-meal"></div>
        <div class="grow"></div>
        <span class="clock" id="clock"></span>
        <button class="icon-btn bell" id="bell" aria-label="Avisos">${icon('bell')}<span class="count hidden" id="bell-count"></span></button>
      </header>
      <div id="notif-panel" class="notif-panel hidden"></div>
      <main class="content" id="page"></main>
    </div>
  </div>
  <div class="print-cards" id="print-area"></div>`;
  root.querySelector('#btn-out').onclick = async () => { try { await post('/api/logout'); } catch {} renderLogin(); };
  root.querySelector('#btn-pw').onclick = () => { location.hash = '#/senha'; };
  root.querySelector('#burger').onclick = () => root.querySelector('#app').classList.toggle('menu-open');
  root.querySelector('#bell').onclick = toggleNotifPanel;
  root.querySelector('.side').addEventListener('click', (e) => { if (e.target.closest('a')) root.querySelector('#app').classList.remove('menu-open'); });
  tickClock();
  startPolling();
}

function tickClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const d = new Date();
  el.textContent = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const now = d.getHours() * 60 + d.getMinutes();
  const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  let txt = '';
  for (const t of state.meta.meal_times) {
    if (now >= toMin(t.start) && now <= toMin(t.end)) { txt = `${mealIcon(t.meal)} ${MEAL_FULL[t.meal]} em serviço até as ${t.end}`; break; }
    if (now < toMin(t.start)) {
      const open = toMin(t.start) - t.notify_before_min;
      txt = `${mealIcon(t.meal)} Próxima refeição: ${MEAL_FULL[t.meal]} às ${t.start}` + (now >= open ? ' · lista oficial liberada' : ` · liberação da lista às ${String(Math.floor(open / 60)).padStart(2, '0')}:${String(open % 60).padStart(2, '0')}`);
      break;
    }
  }
  if (!txt) txt = `${mealIcon('cafe')} Próxima refeição: café da manhã de amanhã às ${state.meta.meal_times[0].start}`;
  const nm = document.getElementById('now-meal');
  if (nm.dataset.t !== txt) { nm.innerHTML = txt; nm.dataset.t = txt; nm.querySelector('svg').setAttribute('style', 'width:20px;height:20px;color:var(--primary)'); }
}
setInterval(tickClock, 15000);

// ---------- Avisos ----------
let pollTimer = null, lastNotifId = 0, notifs = [], firstPoll = true;
function stopPolling() { clearInterval(pollTimer); pollTimer = null; firstPoll = true; lastNotifId = 0; notifs = []; }
function startPolling() { stopPolling(); pollNotifs(); pollTimer = setInterval(pollNotifs, 30000); }

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.2);
    });
  } catch {}
}

// Só navega pelo aviso se o perfil puder abrir a página (senão ficava indo para o Painel geral)
function goLink(link) {
  if (!link) return;
  const p = link.replace(/^#\/?/, '').split('?')[0];
  if ((PAGE_ROLES[p] || []).includes(state.me.role)) location.hash = link;
}

async function pollNotifs() {
  try {
    const rows = await get('/api/notifications?since=' + lastNotifId);
    if (rows.length) {
      const fresh = rows.filter((r) => r.id > lastNotifId);
      lastNotifId = Math.max(lastNotifId, ...rows.map((r) => r.id));
      notifs = [...fresh, ...notifs].slice(0, 40);
      if (!firstPoll) {
        for (const n of fresh.filter((x) => !x.read).slice(0, 3)) {
          const t = toast(n.body || '', 'notif', n.title);
          t.onclick = () => { goLink(n.link); markRead([n.id]); t.remove(); };
          if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification(n.title, { body: n.body || '', icon: '/img/favicon.png', tag: 'refeicoes-' + n.id }); } catch {}
          }
        }
        if (fresh.some((x) => !x.read)) beep();
      }
    }
    firstPoll = false;
    updateBell();
  } catch {}
}

function updateBell() {
  const unread = notifs.filter((n) => !n.read).length;
  const c = document.getElementById('bell-count');
  if (!c) return;
  c.textContent = unread > 9 ? '9+' : unread;
  c.classList.toggle('hidden', !unread);
}

async function markRead(ids) {
  notifs.forEach((n) => { if (ids.includes(n.id)) n.read = 1; });
  updateBell();
  try { await post('/api/notifications/read', { ids }); } catch {}
}

function toggleNotifPanel() {
  const p = document.getElementById('notif-panel');
  if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
  const perm = 'Notification' in window && Notification.permission === 'default';
  p.innerHTML = `<div class="card-head"><h3 class="grow">Avisos</h3>${notifs.some((n) => !n.read) ? '<button class="btn sm" id="n-all">Marcar como lidos</button>' : ''}</div>
    ${perm ? `<div class="n" id="n-perm"><b>Ativar avisos na tela do computador</b><small>Recomendado para os restaurantes: aparece mesmo com o sistema minimizado.</small></div>` : ''}
    ${notifs.length ? notifs.map((n) => `<div class="n ${n.read ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link || '')}"><b>${esc(n.title)}</b>${n.body ? `<div>${esc(n.body)}</div>` : ''}<small>${esc(n.created_at.slice(8, 10) + '/' + n.created_at.slice(5, 7) + ' ' + n.created_at.slice(11, 16))}</small></div>`).join('') : '<div class="empty">Nenhum aviso nos últimos dias.</div>'}`;
  p.classList.remove('hidden');
  p.querySelector('#n-all')?.addEventListener('click', () => { markRead(notifs.map((n) => n.id)); p.classList.add('hidden'); });
  p.querySelector('#n-perm')?.addEventListener('click', async () => { await Notification.requestPermission(); p.classList.add('hidden'); });
  p.querySelectorAll('.n[data-id]').forEach((el) => el.addEventListener('click', () => {
    markRead([Number(el.dataset.id)]);
    goLink(el.dataset.link);
    p.classList.add('hidden');
  }));
}
document.addEventListener('click', (e) => {
  const p = document.getElementById('notif-panel');
  if (p && !p.classList.contains('hidden') && !e.target.closest('#notif-panel') && !e.target.closest('#bell')) p.classList.add('hidden');
});

// ---------- Rotas ----------
let cleanup = null, routeSeq = 0;
async function route() {
  if (!state.me) return;
  let path = (location.hash.replace(/^#\/?/, '').split('?')[0]) || '';
  if (state.me.must_change_password) path = 'senha';
  const allowed = (p) => p === 'senha' || NAV.some((n) => n.path === p && hasRole(n.roles));
  if (!PAGES[path] || !allowed(path)) { location.replace('#/' + homeFor(state.me.role)); return; }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === path));
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  // Cada navegação tem seu próprio contêiner: uma página antiga que termine de carregar
  // (ou cujo temporizador dispare) depois da troca não sobrescreve a página atual.
  const seq = ++routeSeq;
  const page = document.getElementById('page');
  const view = document.createElement('div');
  view.innerHTML = '<div class="empty">Carregando…</div>';
  page.replaceChildren(view);
  try {
    const mod = await PAGES[path]();
    if (seq !== routeSeq) return;
    const done = (await mod.render(view)) || null;
    if (seq !== routeSeq) { if (done) try { done(); } catch {} return; }
    cleanup = done;
  } catch (e) {
    if (seq === routeSeq) view.innerHTML = `<div class="banner danger">${icon('alert')}<span>${esc(e.message)}</span></div>`;
  }
  if (seq === routeSeq) window.scrollTo(0, 0);
}
// (setHashParams usa replaceState, que não dispara hashchange; então todo hashchange é navegação)
window.addEventListener('hashchange', route);
window.addEventListener('logout', () => { state.me = null; renderLogin('Sua sessão expirou. Entre novamente.'); });

async function boot() {
  try {
    state.me = await get('/api/me');
    state.meta = await get('/api/meta');
  } catch { renderLogin(); return; }
  renderShell();
  route();
}
export function refreshMe() { return get('/api/me').then((m) => { state.me = m; }); }
window.__mesa = { route, refreshMe, boot };
boot();
