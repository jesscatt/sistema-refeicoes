import { get, put, post, esc, icon, fail, toast, modal, confirmBox, state, boardTag, paxTxt, br, roomHtml, roomMatches, MEALS, MEAL_LABEL, dayLabel, restTag } from '../ui.js';

// Portal da Agência e do Cliente final: só as próprias reservas.
export async function render(el) {
  const st = { q: '', past: false };
  let data;

  async function load() {
    data = await get('/api/portal/reservations' + (st.past ? '?past=1' : ''));
    draw();
  }

  function draw() {
    const q = st.q.trim().toLowerCase();
    const rows = data.rows.filter((r) => !q || roomMatches(r.room, q) || r.guest_name.toLowerCase().includes(q) || String(r.reservation_number).includes(q));
    const groups = [];
    const byNum = new Map();
    for (const r of rows) {
      if (!byNum.has(r.reservation_number)) { const g = { num: r.reservation_number, name: r.guest_name, rooms: [] }; byNum.set(r.reservation_number, g); groups.push(g); }
      byNum.get(r.reservation_number).rooms.push(r);
    }
    const who = state.me.role === 'agencia' ? `Agência ${esc(state.me.agency || state.me.name)}` : esc(state.me.name);
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Minhas reservas</h1><p>${who} · você pode trocar o quarto, ajustar nome, datas e quantidade de pessoas, ou remover um quarto/hóspede. A pensão só é alterada pelo resort.</p></div>
      </div>
      <div class="row" style="margin-bottom:14px">
        <div class="search-big grow" style="max-width:420px;min-width:240px">${icon('search')}<input id="q" style="font-size:16px;padding:11px 14px 11px 48px" placeholder="Quarto, nome ou reserva" value="${esc(st.q)}"></div>
        <label class="row small" style="gap:6px;cursor:pointer"><input type="checkbox" id="past" ${st.past ? 'checked' : ''}> mostrar estadias encerradas</label>
      </div>
      ${groups.length ? groups.map((g) => `
        <div class="card" style="margin-bottom:14px">
          <div class="card-head"><div class="grow"><h3>${esc(g.name)}</h3><div class="muted small">Reserva ${esc(g.num)} · ${g.rooms.filter((r) => r.status === 'ativa').length} quarto(s) ativo(s) · ${g.rooms.filter((r) => r.status === 'ativa').reduce((s, r) => s + r.adults + r.children, 0)} pax</div></div></div>
          <div class="table-wrap"><table class="t">
            <thead><tr><th>Quarto</th><th>Hóspede</th><th>Estadia</th><th>Pax</th><th>Pensão</th><th></th></tr></thead>
            <tbody>${g.rooms.map((r) => {
              const done = r.checkout < data.today, off = r.status !== 'ativa';
              return `<tr style="${off ? 'opacity:.55' : ''}">
                <td class="room">${roomHtml(r.room)}</td>
                <td>${esc(r.guest_name)}${off ? ' <span class="badge danger">removido</span>' : ''}${r.room_changes ? ' <span class="badge info">trocou de quarto</span>' : ''}</td>
                <td class="small">${esc(br(r.checkin))} → ${esc(br(r.checkout))}</td>
                <td>${paxTxt(r.adults, r.children)}</td>
                <td>${boardTag(r.board)}</td>
                <td class="row" style="justify-content:flex-end;gap:6px">
                  <button class="btn sm" data-plan="${r.id}">Refeições</button>
                  ${!off && !done ? `<button class="btn sm" data-edit="${r.id}">${icon('swap')} Alterar</button><button class="btn sm danger" data-del="${r.id}">Remover</button>` : ''}
                </td></tr>`;
            }).join('')}</tbody></table></div>
        </div>`).join('') : `<div class="card empty">${icon('book')}<div>Nenhuma reserva encontrada${st.past ? '' : ' em andamento ou futura'}.</div></div>`}`;
    const qi = el.querySelector('#q');
    qi.addEventListener('input', () => { st.q = qi.value; const pos = qi.selectionStart; draw(); const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(pos, pos); });
    el.querySelector('#past').addEventListener('change', (e) => { st.past = e.target.checked; load().catch(fail); });
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(data.rows.find((r) => r.id === Number(b.dataset.edit)))));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove(data.rows.find((r) => r.id === Number(b.dataset.del)))));
    el.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => plan(b.dataset.plan)));
  }

  function edit(r) {
    const { el: m, close } = modal({
      title: `Alterar quarto ${roomHtml(r.room)}`,
      body: `<form id="pf" class="form-grid">
        <label class="f full">Nome do hóspede<input class="input" name="guest_name" value="${esc(r.guest_name)}" required></label>
        <label class="f">Quarto (número + torre, ex.: 101A)<input class="input" name="room" value="${esc(r.room)}" required></label>
        <span></span>
        <label class="f">Entrada<input class="input" type="date" name="checkin" value="${esc(r.checkin)}" required></label>
        <label class="f">Saída<input class="input" type="date" name="checkout" value="${esc(r.checkout)}" required></label>
        <label class="f">Adultos<input class="input" type="number" min="0" name="adults" value="${r.adults}"></label>
        <label class="f">Crianças<input class="input" type="number" min="0" name="children" value="${r.children}"></label>
      </form>
      <p class="muted small">Ao trocar o quarto, a recepção e os restaurantes são avisados na hora. Para tirar só uma pessoa, diminua adultos ou crianças. Para tirar o quarto inteiro, use “Remover”.</p>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Salvar</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const f = Object.fromEntries(new FormData(m.querySelector('#pf')));
      try {
        const res = await put('/api/portal/reservations/' + r.id, f);
        toast(res.changed ? 'Alteração salva. O resort foi avisado.' : 'Nada foi alterado.');
        close(); load();
      } catch (e) { fail(e); }
    };
  }

  function remove(r) {
    const { el: m, close } = modal({
      title: `Remover quarto ${roomHtml(r.room)}?`,
      body: `<p style="margin-top:0">${esc(r.guest_name)} · ${paxTxt(r.adults, r.children)} · ${esc(br(r.checkin))} → ${esc(br(r.checkout))}</p>
        <p class="muted small">O quarto sai das listas de refeição a partir de agora. Refeições já servidas continuam registradas.</p>
        <label class="f">Motivo (opcional)<input class="input" name="reason" placeholder="Ex.: troca de hóspede, cancelamento"></label>`,
      foot: '<button class="btn" data-close>Voltar</button><button class="btn danger" data-ok>Remover</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      try { await post(`/api/portal/reservations/${r.id}/remove`, { reason: m.querySelector('[name=reason]').value }); toast('Quarto removido. O resort foi avisado.'); close(); load(); } catch (e) { fail(e); }
    };
  }

  async function plan(id) {
    let d;
    try { d = await get('/api/portal/reservations/' + id); } catch (e) { fail(e); return; }
    const cell = (x) => (!x.included ? '<span class="muted small">—</span>' : restTag(x.restaurant));
    modal({
      wide: true,
      title: `Refeições · quarto ${roomHtml(d.reservation.room)}`,
      body: `<div class="plan-grid"><div class="h">Dia</div>${MEALS.map((m) => `<div class="h">${MEAL_LABEL[m]}</div>`).join('')}
        ${d.plan.map((p) => `<div class="d">${esc(dayLabel(p.date))}</div>${MEALS.map((m) => `<div>${cell(p.meals[m])}</div>`).join('')}`).join('')}</div>
        <p class="muted small">Horários: ${state.meta.meal_times.map((t) => `${esc(t.label)} ${t.start}–${t.end}`).join(' · ')}. Refeições fora da pensão são pagas à parte no restaurante.</p>`,
      foot: '<button class="btn primary" data-close>Fechar</button>',
    });
  }

  await load();
}
