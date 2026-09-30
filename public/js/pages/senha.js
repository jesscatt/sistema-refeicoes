import { post, esc, icon, fail, toast, state } from '../ui.js';

export async function render(el) {
  const forced = state.me.must_change_password;
  el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Trocar senha</h1>${forced ? '<p>Por segurança, defina uma senha nova antes de continuar.</p>' : ''}</div></div>
    <div class="card pad" style="max-width:440px">
      <form id="pf" style="display:grid;gap:12px">
        <label class="f">Senha atual<input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="f">Nova senha (mín. 8 caracteres)<input class="input" type="password" name="password" autocomplete="new-password" minlength="8" required></label>
        <label class="f">Repita a nova senha<input class="input" type="password" name="password2" autocomplete="new-password" required></label>
        <button class="btn primary" type="submit">${icon('check')} Salvar nova senha</button>
      </form>
    </div>`;
  el.querySelector('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.password !== f.password2) { toast('As senhas não conferem.', 'err'); return; }
    try {
      await post('/api/me/password', { current: f.current, password: f.password });
      toast('Senha alterada.');
      await window.__mesa.boot();
      location.hash = '#/';
    } catch (err) { fail(err); }
  });
}
