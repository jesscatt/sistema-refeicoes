import { get, esc, icon, fail } from '../ui.js';
import { readParams, syncParams } from './common.js';

export async function render(el) {
  const st = readParams({ days: '7' });
  async function load() {
    syncParams(st, ['days']);
    const rows = await get('/api/room-changes?days=' + st.days);
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Trocas de quarto</h1><p>Clientes que mudaram de quarto. Na marcação do restaurante, digitar o quarto antigo mostra para onde o hóspede foi.</p></div>
        <div class="seg" id="d">${[['1', 'Hoje'], ['7', '7 dias'], ['30', '30 dias']].map(([v, l]) => `<button data-v="${v}" class="${st.days === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="card"><div class="table-wrap"><table class="t">
        <thead><tr><th>Quando</th><th>De</th><th>Para</th><th>Hóspede</th><th>Reserva</th><th>Origem</th></tr></thead>
        <tbody>${rows.map((c) => `<tr><td>${esc(c.created_at.slice(8, 10) + '/' + c.created_at.slice(5, 7) + ' ' + c.created_at.slice(11, 16))}</td>
          <td class="room muted" style="text-decoration:line-through">${esc(c.old_room)}</td><td class="room">${esc(c.new_room)}</td>
          <td><b>${esc(c.guest_name)}</b></td><td>${esc(c.reservation_number)}</td><td><span class="badge">${esc(c.source)}</span>${c.user_name ? ' ' + esc(c.user_name) : ''}</td></tr>`).join('')
          || `<tr><td colspan="6"><div class="empty">${icon('swap')}<div>Nenhuma troca no período.</div></div></td></tr>`}</tbody></table></div></div>`;
    el.querySelectorAll('#d [data-v]').forEach((b) => b.addEventListener('click', () => { st.days = b.dataset.v; load().catch(fail); }));
  }
  await load();
}
