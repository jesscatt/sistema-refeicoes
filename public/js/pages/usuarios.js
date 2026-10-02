import { get, post, put, esc, icon, fail, toast, modal, state, ROLE_LABEL, confirmBox } from '../ui.js';

const ROLE_HELP = {
  admin: 'Faz tudo: usuários, configurações, logs, reabrir mês.',
  supervisor: 'Vê tudo, cadastra valores, fecha o faturamento e gera os relatórios oficiais.',
  refeicao: 'Importa planilhas, revisa e ajusta a divisão, publica listas, vê faturamento.',
  recepcao: 'Consulta de refeições dos hóspedes e impressão dos cartões (somente leitura).',
  restaurante: 'Marca quem veio comer no seu restaurante e informa o número real.',
  agencia: 'Equipe comercial: envia os rooming lists das agências, confere as trocas de quarto e ajusta quartos, nomes e pessoas de todas as reservas. Não muda a pensão nem a divisão.',
};

export async function render(el) {
  async function load() {
    const users = await get('/api/users');
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Usuários</h1><p>${users.filter((u) => u.active).length} ativos</p></div>
        <button class="btn primary" id="new">${icon('plus')} Novo usuário</button></div>
      <div class="card"><div class="table-wrap"><table class="t">
        <thead><tr><th>Login</th><th>Nome</th><th>Perfil</th><th>Restaurante</th><th>Último acesso</th><th>Situação</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td><b style="font-size:16px;letter-spacing:.06em">${esc(u.login_code || '—')}</b></td><td><b>${esc(u.name)}</b></td><td><span class="badge terra">${ROLE_LABEL[u.role]}</span></td>
          <td>${esc(u.restaurant_name || '')}</td><td class="small muted">${esc(u.last_login_at || 'nunca')}</td>
          <td>${u.active ? '<span class="badge ok">ativo</span>' : '<span class="badge danger">inativo</span>'}${u.must_change_password ? ' <span class="badge warn">trocar senha</span>' : ''}</td>
          <td class="row" style="justify-content:flex-end;gap:6px"><button class="btn sm" data-edit="${u.id}">Editar</button><button class="btn sm" data-reset="${u.id}">Nova senha</button></td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="grid g3" style="margin-top:16px">${Object.entries(ROLE_HELP).map(([k, v]) => `<div class="card pad"><b>${ROLE_LABEL[k]}</b><p class="muted small" style="margin:4px 0 0">${v}</p></div>`).join('')}</div>`;
    el.querySelector('#new').onclick = () => form();
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => form(users.find((u) => u.id === Number(b.dataset.edit)))));
    el.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const u = users.find((x) => x.id === Number(b.dataset.reset));
      if (!(await confirmBox(`Gerar nova senha provisória para ${esc(u.name)}?`, 'Gerar senha'))) return;
      try { const r = await post(`/api/users/${u.id}/reset-password`); showPw(`${u.name} (login ${u.login_code})`, r.temp_password); } catch (e) { fail(e); }
    }));
  }

  function showPw(username, pw) {
    modal({ title: 'Senha provisória', body: `<p>Entregue a <b>${esc(username)}</b>. Para entrar: digite o login, confira o nome e use esta senha. Ela será trocada no primeiro acesso.</p><pre style="font-size:20px;text-align:center">${esc(pw)}</pre>`, foot: '<button class="btn primary" data-close>Pronto</button>' });
  }

  async function form(u = null) {
    let nextCode = '';
    if (!u) { try { nextCode = (await get('/api/users/next-code')).code; } catch {} }
    const rests = state.meta.restaurants;
    const { el: m, close } = modal({
      title: u ? 'Editar usuário' : 'Novo usuário',
      body: `<form class="form-grid" id="uf">
        <label class="f full">Nome<input class="input" name="name" value="${esc(u?.name || '')}" required></label>
        <label class="f">Login (número)<input class="input" name="login_code" inputmode="numeric" pattern="[0-9]{3,8}" value="${esc(u?.login_code || nextCode || '')}" required autocomplete="off" title="Somente números, de 3 a 8 dígitos"></label>
        <label class="f">Perfil<select class="input" name="role">${Object.entries(ROLE_LABEL).filter(([k]) => k !== 'cliente').map(([k, v]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f" id="restf">Restaurante<select class="input" name="restaurant_id">${rests.map((r) => `<option value="${r.id}" ${u?.restaurant_id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>

        ${u ? `<label class="f">Situação<select class="input" name="active"><option value="1" ${u.active ? 'selected' : ''}>Ativo</option><option value="0" ${u.active ? '' : 'selected'}>Inativo</option></select></label>`
          : '<label class="f">Senha inicial (opcional)<input class="input" name="password" type="text" placeholder="em branco = gerar" autocomplete="off"></label>'}
        <p class="muted small full" id="rhelp"></p>
      </form>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Salvar</button>',
    });
    const role = m.querySelector('[name=role]');
    const sync = () => {
      m.querySelector('#restf').style.display = role.value === 'restaurante' ? '' : 'none';
      m.querySelector('#rhelp').textContent = ROLE_HELP[role.value];
    };
    role.addEventListener('change', sync); sync();
    m.querySelector('[data-ok]').onclick = async () => {
      const f = Object.fromEntries(new FormData(m.querySelector('#uf')));
      if (f.active !== undefined) f.active = f.active === '1';
      try {
        if (u) { await put('/api/users/' + u.id, f); toast('Usuário salvo.'); close(); }
        else { const r = await post('/api/users', f); close(); if (r.temp_password) showPw(`${f.name} (login ${r.login_code})`, r.temp_password); else toast(`Usuário criado · login ${r.login_code}.`); }
        load();
      } catch (e) { fail(e); }
    };
  }

  await load();
}
