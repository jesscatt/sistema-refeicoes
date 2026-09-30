import { get, post, put, esc, icon, mealIcon, MEALS, MEAL_LABEL, MEAL_FULL, modal, toast, fail, can, state, boardTag, br, dayLabel, restTag, confirmBox } from '../ui.js';

function cell(m) {
  if (!m.included) return `<span class="muted small">${m.reason === 'nao_inclui' ? 'não incluso' : '—'}</span>`;
  let s = restTag(m.restaurant);
  if (m.locked) s += ` <span title="Escolhido/travado" style="color:var(--terracotta)">${icon('lock').replace('<svg', '<svg style="width:14px;height:14px"')}</span>`;
  if (m.attended) s += ` <span class="badge ${m.attended.status === 'presente' ? 'ok' : 'warn'}" title="${esc(m.attended.at)}">✓ ${m.attended.status === 'fora_lista' ? 'em ' + esc(m.attended.restaurant.name) : ''}</span>`;
  return s;
}

export function planGrid(plan) {
  return `<div class="plan-grid">
    <div class="h">Dia</div>${MEALS.map((m) => `<div class="h">${MEAL_LABEL[m]}</div>`).join('')}
    ${plan.map((d) => `<div class="d">${esc(dayLabel(d.date))}</div>${MEALS.map((m) => `<div>${cell(d.meals[m])}</div>`).join('')}`).join('')}
  </div>`;
}

// Cartão impresso para o hóspede
export function printCards(items) {
  const area = document.getElementById('print-area');
  area.innerHTML = items.map(({ reservation: r, plan }) => `
    <div class="pcard">
      <h2>Quarto ${esc(r.room)} · ${esc(r.guest_name)}</h2>
      <div>Reserva ${esc(r.reservation_number)} · ${esc(br(r.checkin))} a ${esc(br(r.checkout))} · ${esc(r.board)} (${esc(state.meta.boards[r.board].label)}) · ${r.adults} adulto(s)${r.children ? `, ${r.children} criança(s)` : ''}</div>
      <table><thead><tr><th>Dia</th>${MEALS.map((m) => `<th>${MEAL_FULL[m]}<br><small>${esc(state.meta.meal_times.find((t) => t.meal === m).start)}–${esc(state.meta.meal_times.find((t) => t.meal === m).end)}</small></th>`).join('')}</tr></thead>
      <tbody>${plan.filter((d) => MEALS.some((m) => d.meals[m].included)).map((d) => `<tr><td>${esc(dayLabel(d.date))}</td>${MEALS.map((m) => `<td>${d.meals[m].included ? esc(d.meals[m].restaurant ? d.meals[m].restaurant.name : '—') : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <div style="margin-top:6px;font-size:11px">Refeições fora da pensão são cobradas à parte no restaurante.</div>
    </div>`).join('');
  window.print();
}

export async function openReservation(id, onChange = () => {}) {
  let data;
  try { data = await get('/api/reservations/' + id); } catch (e) { fail(e); return; }
  const r = data.reservation;
  const edit = can('admin', 'refeicao');
  const boards = state.meta.boards;
  const { el, close } = modal({
    wide: true,
    title: `Quarto ${esc(r.room)} · ${esc(r.guest_name)}`,
    body: `
      <div class="row" style="margin-bottom:14px">
        <span class="badge">Reserva ${esc(r.reservation_number)}</span> ${boardTag(r.board)} <span class="muted">${esc(boards[r.board].label)}</span>
        <span class="badge">${esc(br(r.checkin))} → ${esc(br(r.checkout))}</span>
        <span class="badge">${r.adults} adt · ${r.children} chd</span>
        <span class="badge ${r.status === 'ativa' ? 'ok' : 'danger'}">${r.status}</span>
        <span class="badge info">origem: ${esc(r.source)}</span>
      </div>
      ${planGrid(data.plan)}
      ${data.room_changes.length ? `<h3 style="margin:18px 0 8px">Trocas de quarto</h3>
        <table class="t"><tbody>${data.room_changes.map((c) => `<tr><td class="room">${esc(c.old_room)} → ${esc(c.new_room)}</td><td>${esc(c.source)}${c.user_name ? ' · ' + esc(c.user_name) : ''}</td><td class="muted small">${esc(c.created_at)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${edit ? `<h3 style="margin:20px 0 10px">Editar reserva</h3>
        <form id="ed" class="form-grid">
          <label class="f full">Nome completo<input class="input" name="guest_name" value="${esc(r.guest_name)}" required></label>
          <label class="f">Quarto<input class="input" name="room" value="${esc(r.room)}" required></label>
          <label class="f">Pensão<select class="input" name="board">${Object.entries(boards).map(([k, b]) => `<option value="${k}" ${k === r.board ? 'selected' : ''}>${k} — ${esc(b.label)}</option>`).join('')}</select></label>
          <label class="f">Entrada<input class="input" type="date" name="checkin" value="${esc(r.checkin)}" required></label>
          <label class="f">Saída<input class="input" type="date" name="checkout" value="${esc(r.checkout)}" required></label>
          <label class="f">Adultos<input class="input" type="number" min="0" name="adults" value="${r.adults}"></label>
          <label class="f">Crianças<input class="input" type="number" min="0" name="children" value="${r.children}"></label>
          <label class="f full">Observações<input class="input" name="notes" value="${esc(r.notes || '')}"></label>
        </form>
        <p class="muted small">Ao trocar o quarto, recepção, setor de refeições e restaurantes recebem um aviso.</p>` : ''}`,
    foot: `${edit ? (r.status === 'ativa' ? '<button class="btn danger" data-cancel>Cancelar reserva</button>' : '<button class="btn" data-react>Reativar</button>') : ''}
      <span style="flex:1"></span><button class="btn" data-print>${icon('print')} Imprimir cartão</button>
      ${edit ? '<button class="btn primary" data-save>Salvar</button>' : '<button class="btn" data-close>Fechar</button>'}`,
  });
  el.querySelector('[data-print]').onclick = () => printCards([data]);
  el.querySelector('[data-save]')?.addEventListener('click', async () => {
    const f = Object.fromEntries(new FormData(el.querySelector('#ed')));
    try { await put('/api/reservations/' + r.id, f); toast('Reserva salva.'); close(); onChange(); } catch (e) { fail(e); }
  });
  el.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    if (!(await confirmBox('Cancelar esta reserva? Ela sai de todas as listas futuras.', 'Cancelar reserva', true))) return;
    try { await post(`/api/reservations/${r.id}/cancel`); toast('Reserva cancelada.'); close(); onChange(); } catch (e) { fail(e); }
  });
  el.querySelector('[data-react]')?.addEventListener('click', async () => {
    try { await post(`/api/reservations/${r.id}/reactivate`); toast('Reserva reativada.'); close(); onChange(); } catch (e) { fail(e); }
  });
}
