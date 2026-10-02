import { get, esc, icon, mealIcon, MEALS, MEAL_LABEL, fail, boardTag, paxTxt, dayLabel, restTag, br, toast, roomHtml, roomMatches } from '../ui.js';
import { dateBar, bindDateBar, readParams, syncParams } from './common.js';
import { openReservation, printCards } from './plan.js';

export async function render(el) {
  const st = readParams({ date: '', q: '', filter: 'todos' });
  let d;

  async function load() {
    d = await get('/api/reception?date=' + st.date);
    st.date = d.date;
    syncParams(st, ['date']);
    draw();
  }

  function rows() {
    const q = st.q.trim().toLowerCase();
    return d.rows.filter((r) => (!q || roomMatches(r.room, q) || r.guest_name.toLowerCase().includes(q) || String(r.guests || '').toLowerCase().includes(q) || r.reservation_number.includes(q))
      && (st.filter === 'todos' || (st.filter === 'chegadas' && r.arriving) || (st.filter === 'saidas' && r.leaving) || (st.filter === 'trocas' && r.old_room)));
  }

  function draw() {
    const list = rows();
    const n = (f) => d.rows.filter(f).length;
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Consulta de refeições</h1><p>${esc(dayLabel(d.date))} · ${d.rows.length} reservas hospedadas. Selecione o hóspede para consultar a estadia completa e imprimir o cartão de refeições.</p></div>
        ${dateBar({ date: d.date })}
      </div>
      <div class="row" style="margin-bottom:14px">
        <div class="search-big grow" style="max-width:420px;min-width:240px">${icon('search')}<input id="q" class="" style="font-size:16px;padding:11px 14px 11px 48px" placeholder="Apartamento (101A), hóspede ou reserva" value="${esc(st.q)}"></div>
        <div class="seg" id="flt">
          ${[['todos', `Todos (${d.rows.length})`], ['chegadas', `Chegadas (${n((r) => r.arriving)})`], ['saidas', `Saídas (${n((r) => r.leaving)})`], ['trocas', `Trocaram de apartamento (${n((r) => r.old_room)})`]]
            .map(([k, l]) => `<button data-f="${k}" class="${st.filter === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <div class="grow"></div>
        <button class="btn" id="print">${icon('print')} Imprimir cartões (${list.length})</button>
      </div>
      <div class="card"><div class="table-wrap"><table class="t">
        <thead><tr><th>Apartamento</th><th>Hóspede</th><th>Pessoas</th><th>Pensão</th><th>Estadia</th>${MEALS.map((m) => `<th>${MEAL_LABEL[m]}</th>`).join('')}</tr></thead>
        <tbody>${list.map((r) => `<tr class="click" data-id="${r.id}">
          <td class="room">${roomHtml(r.room)}${r.old_room ? `<div class="small" style="color:var(--primary-d);font-weight:600">anterior: ${esc(r.old_room)}</div>` : ''}</td>
          <td><b>${esc(r.guest_name)}</b>${r.guests ? `<div class="small">${esc(r.guests.split('\n').join(', '))}</div>` : ''}<div class="muted small">Reserva nº ${esc(r.reservation_number)}</div></td>
          <td>${paxTxt(r.adults, r.children)}</td>
          <td>${boardTag(r.board)}</td>
          <td class="small">${esc(br(r.checkin).slice(0, 5))} → ${esc(br(r.checkout).slice(0, 5))} ${r.arriving ? '<span class="badge info">chega</span>' : ''}${r.leaving ? '<span class="badge warn">sai</span>' : ''}</td>
          ${MEALS.map((m) => `<td>${r.meals[m] ? restTag(r.meals[m]) : '<span class="muted small">—</span>'}</td>`).join('')}
        </tr>`).join('') || `<tr><td colspan="8"><div class="empty">Nenhum hóspede encontrado.</div></td></tr>`}</tbody>
      </table></div></div>`;
    bindDateBar(el, st, () => load().catch(fail));
    const q = el.querySelector('#q');
    q.addEventListener('input', () => { st.q = q.value; const pos = q.selectionStart; draw(); const n2 = el.querySelector('#q'); n2.focus(); n2.setSelectionRange(pos, pos); });
    el.querySelectorAll('#flt [data-f]').forEach((b) => b.addEventListener('click', () => { st.filter = b.dataset.f; draw(); }));
    el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openReservation(tr.dataset.id, () => load())));
    el.querySelector('#print').onclick = async () => {
      if (!list.length) return;
      if (list.length > 150) { toast('Quantidade excessiva de cartões para impressão; filtre pelas chegadas do dia.', 'err'); return; }
      try { printCards(await Promise.all(list.map((r) => get('/api/reservations/' + r.id)))); } catch (e) { fail(e); }
    };
  }

  await load();
}
