import { get, post, esc, icon, fail, toast, can, state, boardTag, paxTxt, br, modal, download, roomHtml } from '../ui.js';
import { readParams, syncParams } from './common.js';
import { openReservation } from './plan.js';

export async function render(el) {
  const st = readParams({ q: '', date: '', status: 'ativa', board: '', offset: '0' });
  const edit = can('admin', 'refeicao');

  async function load() {
    syncParams(st, ['q', 'date', 'status', 'board', 'offset']);
    const qs = new URLSearchParams({ q: st.q, date: st.date, status: st.status, board: st.board, offset: st.offset, limit: 100 });
    const d = await get('/api/reservations?' + qs);
    const off = Number(st.offset);
    el.querySelector('#tbody').innerHTML = d.rows.map((r) => `<tr class="click" data-id="${r.id}">
      <td>${esc(r.reservation_number)}</td><td class="room">${roomHtml(r.room)}</td><td><b>${esc(r.guest_name)}</b>${r.room_changes ? ` <span class="badge terra">${icon('swap').replace('<svg', '<svg style="width:12px;height:12px"')} ${r.room_changes}</span>` : ''}${r.guests ? `<div class="small" style="margin-top:3px">${String(r.guests).split('\n').filter(Boolean).map(esc).join('<br>')}</div>` : ''}</td>
      <td>${esc(br(r.checkin))}</td><td>${esc(br(r.checkout))}</td><td>${boardTag(r.board)}</td><td>${paxTxt(r.adults, r.children)}</td>
      <td><span class="badge">${esc(r.source)}</span></td><td>${r.status === 'ativa' ? '<span class="badge ok">ativa</span>' : '<span class="badge danger">cancelada</span>'}</td></tr>`).join('')
      || '<tr><td colspan="9"><div class="empty">Nenhuma reserva encontrada.</div></td></tr>';
    el.querySelector('#count').textContent = `${d.total} reserva(s)` + (d.total > 100 ? ` · mostrando ${off + 1}–${Math.min(off + 100, d.total)}` : '');
    el.querySelector('#prev').disabled = off <= 0;
    el.querySelector('#next').disabled = off + 100 >= d.total;
    el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openReservation(tr.dataset.id, load)));
  }

  el.innerHTML = `
    <div class="page-head">
      <div class="grow"><h1>Reservas</h1><p id="count"></p></div>
      ${can('admin', 'supervisor', 'refeicao') ? `<button class="btn" id="csv">${icon('download')} Exportar</button>` : ''}
      ${edit ? `<button class="btn primary" id="new">${icon('plus')} Nova reserva</button>` : ''}
    </div>
    <div class="card pad" style="margin-bottom:14px">
      <div class="row">
        <input class="input" id="q" placeholder="Nome, quarto e torre (101A) ou nº da reserva" value="${esc(st.q)}" style="max-width:340px">
        <label class="row small" style="gap:6px">Hospedados em <input type="date" class="input sm" id="date" value="${esc(st.date)}" style="width:auto"></label>
        <select class="input sm" id="board" style="width:auto"><option value="">Todas as pensões</option>${Object.keys(state.meta.boards).map((b) => `<option ${b === st.board ? 'selected' : ''}>${b}</option>`).join('')}</select>
        <select class="input sm" id="status" style="width:auto">${[['ativa', 'Ativas'], ['cancelada', 'Canceladas'], ['', 'Todas']].map(([v, l]) => `<option value="${v}" ${v === st.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table class="t">
      <thead><tr><th>Reserva</th><th>Quarto</th><th>Grupo / hóspedes</th><th>Entrada</th><th>Saída</th><th>Pensão</th><th>Pax</th><th>Origem</th><th>Situação</th></tr></thead>
      <tbody id="tbody"></tbody></table></div>
      <div class="row" style="padding:12px 16px;justify-content:flex-end"><button class="btn sm" id="prev">‹ Anterior</button><button class="btn sm" id="next">Próxima ›</button></div>
    </div>`;

  let deb;
  el.querySelector('#q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { st.q = e.target.value; st.offset = '0'; load().catch(fail); }, 250); });
  for (const k of ['date', 'board', 'status']) el.querySelector('#' + k).addEventListener('change', (e) => { st[k] = e.target.value; st.offset = '0'; load().catch(fail); });
  el.querySelector('#prev').onclick = () => { st.offset = String(Math.max(0, Number(st.offset) - 100)); load().catch(fail); };
  el.querySelector('#next').onclick = () => { st.offset = String(Number(st.offset) + 100); load().catch(fail); };
  el.querySelector('#csv')?.addEventListener('click', () => download('/api/reservations/export.csv' + (st.date ? '?date=' + st.date : '')));
  el.querySelector('#new')?.addEventListener('click', newReservation);

  function newReservation() {
    const boards = state.meta.boards;
    const { el: m, close } = modal({
      title: 'Nova reserva',
      body: `<form id="nf" class="form-grid">
        <label class="f">Nº da reserva<input class="input" name="reservation_number" required></label>
        <label class="f">Quarto<input class="input" name="room" required></label>
        <label class="f full">Nome completo<input class="input" name="guest_name" required></label>
        <label class="f">Entrada<input class="input" type="date" name="checkin" required></label>
        <label class="f">Saída<input class="input" type="date" name="checkout" required></label>
        <label class="f">Pensão<select class="input" name="board">${Object.entries(boards).filter(([k]) => k !== 'SA').map(([k, b]) => `<option value="${k}">${k} — ${esc(b.label)}</option>`).join('')}</select></label>
        <label class="f">Adultos<input class="input" type="number" min="0" name="adults" value="2"></label>
        <label class="f">Crianças<input class="input" type="number" min="0" name="children" value="0"></label>
      </form>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Criar e distribuir</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const f = Object.fromEntries(new FormData(m.querySelector('#nf')));
      try { const r = await post('/api/reservations', f); toast('Reserva criada e distribuída nos restaurantes.'); close(); load(); openReservation(r.id, load); } catch (e) { fail(e); }
    };
  }

  await load();
}
