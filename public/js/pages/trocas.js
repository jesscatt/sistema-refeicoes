import { get, post, esc, icon, fail, toast, can, modal, roomHtml } from '../ui.js';
import { readParams, syncParams } from './common.js';

export async function render(el) {
  const st = readParams({ days: '7', pending: can('agencia') ? '1' : '' });
  const canValidate = can('admin', 'refeicao', 'agencia');
  async function load() {
    syncParams(st, ['days', 'pending']);
    const rows = await get(`/api/room-changes?days=${st.days}&pending=${st.pending}`);
    const pend = rows.filter((c) => !c.validated_at).length;
    const fmt = (t) => t ? t.slice(8, 10) + '/' + t.slice(5, 7) + ' ' + t.slice(11, 16) : '';
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Trocas de apartamento</h1><p>Hóspedes que mudaram de apartamento. ${canValidate ? 'Cada troca deve ser conferida pelo Comercial, que pode confirmá-la ou desfazê-la. ' : ''}No registro de refeições, a consulta pelo apartamento anterior indica o apartamento atual.</p></div>
        <div class="seg" id="p">${[['1', `A conferir${st.pending ? ` (${pend})` : ''}`], ['', 'Todas']].map(([v, l]) => `<button data-v="${v}" class="${st.pending === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" id="d">${[['1', 'Hoje'], ['7', '7 dias'], ['30', '30 dias']].map(([v, l]) => `<button data-v="${v}" class="${st.days === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="card"><div class="table-wrap"><table class="t">
        <thead><tr><th>Quando</th><th>De</th><th>Para</th><th>Reserva / hóspedes</th><th>Feita por</th><th>Conferência</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `<tr>
          <td class="small">${esc(fmt(c.created_at))}</td>
          <td class="room muted" style="text-decoration:line-through">${roomHtml(c.old_room)}</td><td class="room">${roomHtml(c.new_room)}</td>
          <td><b>${esc(c.guest_name)}</b> <span class="muted small">· ${esc(c.reservation_number)}</span>${c.guests ? `<div class="small muted">${esc(c.guests.split('\n').join(', '))}</div>` : ''}</td>
          <td class="small"><span class="badge">${esc(({ agencia: 'comercial', manual: 'resort', excel: 'planilha', desfeita: 'desfeita' })[c.source] || c.source)}</span>${c.user_name ? ' ' + esc(c.user_name) : ''}</td>
          <td class="small">${c.validated_at ? `<span class="badge ok">${icon('check')} conferida</span> ${esc(c.validated_by_name || '')} ${esc(fmt(c.validated_at))}${c.validation_note ? `<div class="muted">${esc(c.validation_note)}</div>` : ''}` : '<span class="badge warn">a conferir</span>'}</td>
          <td class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap">${canValidate && !c.validated_at ? `<button class="btn sm olive" data-ok="${c.id}">${icon('check')} Conferir</button><button class="btn sm danger" data-undo="${c.id}">Desfazer</button>` : ''}</td></tr>`).join('')
          || `<tr><td colspan="7"><div class="empty">${icon('swap')}<div>${st.pending ? 'Nenhuma troca a conferir no período.' : 'Nenhuma troca no período.'}</div></div></td></tr>`}</tbody></table></div></div>`;
    el.querySelectorAll('#d [data-v]').forEach((b) => b.addEventListener('click', () => { st.days = b.dataset.v; load().catch(fail); }));
    el.querySelectorAll('#p [data-v]').forEach((b) => b.addEventListener('click', () => { st.pending = b.dataset.v; load().catch(fail); }));
    el.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      try { await post(`/api/room-changes/${b.dataset.ok}/validate`, {}); toast('Troca conferida.'); load(); } catch (e) { fail(e); }
    }));
    el.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', () => {
      const c = rows.find((x) => String(x.id) === b.dataset.undo);
      const { el: m, close } = modal({
        title: 'Desfazer troca?',
        body: `<p style="margin-top:0">O hóspede volta do apartamento <b>${roomHtml(c.new_room)}</b> para o <b>${roomHtml(c.old_room)}</b>. Recepção e restaurantes são avisados.</p><label class="f">Motivo<input class="input" name="note" placeholder="Ex.: troca não aconteceu"></label>`,
        foot: '<button class="btn" data-close>Voltar</button><button class="btn danger" data-go>Desfazer troca</button>',
      });
      m.querySelector('[data-go]').onclick = async () => {
        try { await post(`/api/room-changes/${c.id}/validate`, { undo: true, note: m.querySelector('[name=note]').value }); toast('Troca desfeita.'); close(); load(); } catch (e) { fail(e); }
      };
    }));
  }
  await load();
}
