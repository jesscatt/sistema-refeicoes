import { get, put, post, api, esc, icon, fail, toast, modal, state, boardTag, paxTxt, br, roomHtml, MEALS, MEAL_LABEL, dayLabel, restTag, today, addDays, download } from '../ui.js';
import { readParams, syncParams } from './common.js';

// Comercial: rooming list das agências, conferência de quartos e trocas (todas as reservas).
export async function render(el) {
  const st = readParams({ q: '', from: addDays(today(), -1), to: addDays(today(), 30) });
  let data, view = 'lista', rl = null, deb;

  const guestList = (g) => String(g || '').split('\n').filter(Boolean);

  async function load() {
    syncParams(st, ['q', 'from', 'to']);
    data = await get(`/api/portal/reservations?q=${encodeURIComponent(st.q)}&from=${st.from}&to=${st.to}`);
    draw();
  }

  function draw() {
    if (view === 'rooming') return drawRooming();
    const groups = [];
    const byNum = new Map();
    for (const r of data.rows) {
      if (!byNum.has(r.reservation_number)) { const g = { num: r.reservation_number, name: r.guest_name, rooms: [] }; byNum.set(r.reservation_number, g); groups.push(g); }
      byNum.get(r.reservation_number).rooms.push(r);
    }
    const open = groups.length <= 3 || !!st.q;
    const noNames = (g) => g.rooms.filter((r) => !guestList(r.guests).length).length;
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Rooming list</h1><p>Exclusivo para <b>reservas de grupo</b> (2 ou mais apartamentos na mesma reserva): envio do rooming list das agências e conferência de apartamentos. Alterações de apartamento, hóspedes e quantidade de pessoas são comunicadas à recepção, ao setor de refeições e aos restaurantes. Pensão e distribuição são definidas pelo resort.</p></div>
        <a class="btn" href="#/trocas">${icon('swap')} Trocas de apartamento</a>
        <button class="btn primary" id="rl">${icon('upload')} Enviar rooming list</button>
      </div>
      <div class="card pad" style="margin-bottom:14px"><div class="row">
        <div class="search-big grow" style="max-width:420px;min-width:240px">${icon('search')}<input id="q" style="font-size:16px;padding:11px 14px 11px 48px" placeholder="Reserva, agência/grupo, hóspede ou quarto" value="${esc(st.q)}"></div>
        <label class="row small" style="gap:6px">Hospedados de <input type="date" class="input sm" id="from" value="${esc(st.from)}" style="width:auto"></label>
        <label class="row small" style="gap:6px">até <input type="date" class="input sm" id="to" value="${esc(st.to)}" style="width:auto"></label>
        <span class="muted small">${groups.length} grupo(s) · ${data.rows.length} quarto(s)</span>
      </div></div>
      ${groups.length ? groups.map((g) => {
        const act = g.rooms.filter((r) => r.status === 'ativa');
        const nn = noNames(g), pend = g.rooms.reduce((s, r) => s + (r.room_changes_pending || 0), 0);
        return `<details class="card" style="margin-bottom:12px" ${open ? 'open' : ''}>
          <summary class="card-head" style="cursor:pointer;list-style:none"><div class="grow"><h3>${esc(g.name)}</h3><div class="muted small">Reserva ${esc(g.num)} · ${act.length} quarto(s) · ${act.reduce((s, r) => s + r.adults + r.children, 0)} pax · ${esc(br(act[0]?.checkin || g.rooms[0].checkin))} → ${esc(br(act[0]?.checkout || g.rooms[0].checkout))}</div></div>
            ${nn ? `<span class="badge warn">${nn} sem nomes</span>` : '<span class="badge ok">rooming completo</span>'}
            ${pend ? `<span class="badge info">${pend} troca(s) a conferir</span>` : ''}
            <button class="btn sm" data-addroom="${esc(g.num)}">${icon('plus')} Quarto</button>
            <button class="btn sm" data-rlg="${esc(g.num)}">${icon('upload')} Rooming list</button></summary>
          <div class="table-wrap"><table class="t">
            <thead><tr><th>Quarto</th><th>Hóspedes</th><th>Estadia</th><th>Pax</th><th>Pensão</th><th></th></tr></thead>
            <tbody>${g.rooms.map((r) => {
              const done = r.checkout < data.today, off = r.status !== 'ativa';
              const names = guestList(r.guests);
              return `<tr style="${off ? 'opacity:.55' : ''}">
                <td class="room">${roomHtml(r.room)}</td>
                <td>${names.length ? names.map(esc).join('<br>') : '<span class="muted small">sem nomes</span>'}${off ? ' <span class="badge danger">removido</span>' : ''}${r.room_changes ? ` <span class="badge ${r.room_changes_pending ? 'warn' : 'info'}">${r.room_changes_pending ? 'troca a conferir' : 'trocou de quarto'}</span>` : ''}</td>
                <td class="small">${esc(br(r.checkin))} → ${esc(br(r.checkout))}</td>
                <td>${paxTxt(r.adults, r.children)}</td>
                <td>${boardTag(r.board)}</td>
                <td class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap">
                  <button class="btn sm" data-plan="${r.id}">Refeições</button>
                  ${!off && !done ? `<button class="btn sm" data-edit="${r.id}">${icon('swap')} Alterar</button><button class="btn sm danger" data-del="${r.id}">Remover</button>` : ''}
                </td></tr>`;
            }).join('')}</tbody></table></div>
        </details>`;
      }).join('') : `<div class="card empty">${icon('book')}<div>Nenhum grupo no período${st.q ? ' para essa busca' : ''}. O rooming list considera apenas reservas de grupo (2 ou mais apartamentos).</div></div>`}`;
    const qi = el.querySelector('#q');
    qi.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { st.q = qi.value; load().then(() => { const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }).catch(fail); }, 300); });
    el.querySelector('#from').addEventListener('change', (e) => { if (e.target.value) { st.from = e.target.value; load().catch(fail); } });
    el.querySelector('#to').addEventListener('change', (e) => { if (e.target.value) { st.to = e.target.value; load().catch(fail); } });
    el.querySelector('#rl').onclick = () => openRooming('');
    el.querySelectorAll('[data-rlg]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openRooming(b.dataset.rlg); }));
    el.querySelectorAll('[data-addroom]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); addRoom(b.dataset.addroom); }));
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(data.rows.find((r) => r.id === Number(b.dataset.edit)))));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove(data.rows.find((r) => r.id === Number(b.dataset.del)))));
    el.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => plan(b.dataset.plan)));
  }

  // ---------- Rooming list ----------
  async function openRooming(resNum) {
    let groups = [];
    try { groups = await get('/api/portal/groups'); } catch (e) { fail(e); return; }
    rl = { reservation: resNum, groups, preview: null, removeIds: new Set() };
    view = 'rooming';
    draw();
  }

  function drawRooming() {
    const g = rl.groups.find((x) => x.reservation_number === rl.reservation);
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Envio de rooming list</h1><p>Planilha da agência (.xlsx ou .csv) com o <b>quarto</b> e o <b>nome</b> de cada hóspede — uma linha por hóspede ou por quarto. Se tiver coluna de idade, até 11 anos conta como criança.</p></div>
        <button class="btn" id="back">Voltar</button><button class="btn" id="tpl">${icon('download')} Modelo</button></div>
      <div class="card pad" style="margin-bottom:14px">
        <label class="f" style="max-width:640px">Reserva / grupo deste rooming list
          <select class="input" id="res"><option value="">— a planilha tem a coluna Reserva / descobrir pelo quarto —</option>
            ${rl.groups.map((x) => `<option value="${esc(x.reservation_number)}" ${x.reservation_number === rl.reservation ? 'selected' : ''}>${esc(x.reservation_number)} · ${esc(x.name)} · ${x.rooms} qtos · ${esc(br(x.checkin).slice(0, 5))} → ${esc(br(x.checkout).slice(0, 5))}</option>`).join('')}
          </select></label>
        ${g ? `<p class="small muted" style="margin:8px 0 0">Quartos novos entram nesse grupo com a mesma pensão e as mesmas datas (${esc(br(g.checkin))} → ${esc(br(g.checkout))}).</p>` : ''}
      </div>
      ${rl.preview ? previewHtml() : `<label class="dropzone" id="dz">${icon('upload')}<h2>Arraste o rooming list para esta área</h2><p class="muted">ou clique para escolher o arquivo (.xlsx ou .csv)</p><input type="file" id="file" accept=".xlsx,.csv,.txt" hidden></label>`}`;
    el.querySelector('#back').onclick = () => { view = 'lista'; rl = null; load().catch(fail); };
    el.querySelector('#tpl').onclick = () => download('/api/portal/rooming/modelo.csv');
    el.querySelector('#res').addEventListener('change', async (e) => {
      rl.reservation = e.target.value;
      if (rl.preview) await recheck(); else drawRooming();
    });
    const dz = el.querySelector('#dz');
    if (dz) {
      const fi = el.querySelector('#file');
      fi.addEventListener('change', () => fi.files[0] && upload(fi.files[0]));
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    } else bindPreview();
  }

  async function upload(file) {
    try {
      const buf = await file.arrayBuffer();
      const p = await api('POST', '/api/portal/rooming/preview', buf, { headers: { 'X-Filename': encodeURIComponent(file.name), 'X-Reservation': encodeURIComponent(rl.reservation || '') } });
      rl.preview = p; rl.filename = file.name; rl.removeIds = new Set();
      drawRooming();
    } catch (e) { fail(e); }
  }

  // reconfere a lista (ao trocar a reserva ou editar uma linha)
  async function recheck() {
    const groups = rl.preview.items.map((i) => ({ reservation_number: i.sheet_reservation || '', room: i.room, names: i.names, adults: i.adults, children: i.children }));
    try {
      const p = await post('/api/portal/rooming/check', { groups, reservation_number: rl.reservation });
      rl.preview = { ...p, filename: rl.filename };
      drawRooming();
    } catch (e) { fail(e); }
  }

  function previewHtml() {
    const p = rl.preview;
    const c = (a) => p.items.filter((i) => i.action === a).length;
    const need = p.items.filter((i) => i.needs_reservation).length;
    const badge = { atualizar: '<span class="badge warn">atualizar</span>', novo: '<span class="badge ok">quarto novo</span>', igual: '<span class="badge">sem mudança</span>', erro: '<span class="badge danger">erro</span>' };
    return `
      <div class="stats">
        <div class="card stat"><div class="k">Atualizar</div><div class="v">${c('atualizar')}</div></div>
        <div class="card stat"><div class="k">Quartos novos</div><div class="v">${c('novo')}</div></div>
        <div class="card stat"><div class="k">Sem mudança</div><div class="v">${c('igual')}</div></div>
        <div class="card stat"><div class="k">Com erro</div><div class="v" style="color:${c('erro') + need ? 'var(--danger)' : 'inherit'}">${c('erro') + need}</div></div>
      </div>
      ${need ? `<div class="banner danger">${icon('alert')}<span><b>${need} quarto(s)</b> sem reserva definida. Escolha acima a reserva/grupo deste rooming list.</span></div>` : ''}
      ${p.missing.length ? `<div class="card pad" style="margin-bottom:14px;border-color:#e8c47e">
        <b>${p.missing.length} quarto(s) do grupo não estão neste rooming list.</b> Marque os que saíram (serão removidos das listas de refeição):
        <div class="row" style="margin-top:8px">${p.missing.map((m) => `<label class="badge" style="cursor:pointer;gap:6px;padding:5px 10px"><input type="checkbox" data-rm="${m.id}" ${rl.removeIds.has(m.id) ? 'checked' : ''}> ${roomHtml(m.room)} · ${paxTxt(m.adults, m.children)}${m.guests.length ? ' · ' + esc(m.guests[0]) : ''}</label>`).join('')}</div>
      </div>` : ''}
      <div class="card"><div class="table-wrap" style="max-height:60vh"><table class="t">
        <thead><tr><th></th><th>Reserva</th><th>Quarto</th><th>Hóspedes</th><th class="n">Adt</th><th class="n">Chd</th><th>Hoje no sistema</th><th>Observação</th></tr></thead>
        <tbody>${p.items.map((i, k) => `<tr data-k="${k}">
          <td>${i.needs_reservation ? '<span class="badge danger">escolha a reserva</span>' : badge[i.action] || ''}</td>
          <td>${esc(i.reservation_number || '')}</td>
          <td class="room">${roomHtml(i.room)}</td>
          <td class="small">${i.names.map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
          <td class="n"><input class="input sm" type="number" min="0" data-f="adults" value="${i.adults}" style="width:56px"></td>
          <td class="n"><input class="input sm" type="number" min="0" data-f="children" value="${i.children}" style="width:56px"></td>
          <td class="small muted">${i.old ? `${paxTxt(i.old.adults, i.old.children)}${i.old.guests.length ? '<br>' + i.old.guests.map(esc).join(', ') : ''}${i.old.status !== 'ativa' ? '<br><b>removido (será reativado)</b>' : ''}` : (i.action === 'novo' ? `entra no grupo · ${esc(i.template.board)} · ${esc(br(i.template.checkin).slice(0, 5))}→${esc(br(i.template.checkout).slice(0, 5))}` : '')}</td>
          <td class="small" style="color:var(--danger)">${(i.errors || []).map(esc).join('<br>')}</td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn" id="other">Outro arquivo</button>
        <button class="btn primary" id="send" ${c('erro') + need ? 'disabled' : ''}>${icon('check')} Gravar rooming list</button>
      </div>`;
  }

  function bindPreview() {
    const p = rl.preview;
    el.querySelectorAll('[data-rm]').forEach((cb) => cb.addEventListener('change', () => { const id = Number(cb.dataset.rm); cb.checked ? rl.removeIds.add(id) : rl.removeIds.delete(id); }));
    el.querySelectorAll('tr[data-k] input[data-f]').forEach((inp) => inp.addEventListener('change', () => {
      const it = p.items[Number(inp.closest('tr').dataset.k)];
      it[inp.dataset.f] = Math.max(0, parseInt(inp.value, 10) || 0);
      recheck();
    }));
    el.querySelector('#other').onclick = () => { rl.preview = null; drawRooming(); };
    el.querySelector('#send').onclick = async () => {
      const btn = el.querySelector('#send'); btn.disabled = true; btn.textContent = 'Gravando…';
      try {
        const groups = p.items.map((i) => ({ reservation_number: i.reservation_number, room: i.room, names: i.names, adults: i.adults, children: i.children }));
        const r = await post('/api/portal/rooming/commit', { filename: rl.filename, groups, remove_ids: [...rl.removeIds], reservation_number: rl.reservation });
        toast(`${r.updated} atualizado(s), ${r.created} novo(s), ${r.removed} removido(s). Resort avisado.`, 'ok', 'Rooming list gravado');
        view = 'lista'; rl = null; load();
      } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Gravar rooming list'; }
    };
  }

  // ---------- Quarto ----------
  function roomForm(r = {}) {
    return `<form id="pf" class="form-grid">
      <label class="f">Quarto (número + torre, ex.: 101A)<input class="input" name="room" value="${esc(r.room || '')}" required></label><span></span>
      <label class="f full">Hóspedes (um nome completo por linha · máximo ${state.meta.max_pax_room || 5} por quarto)<textarea class="input" name="guests" rows="5" placeholder="Maria da Silva&#10;João da Silva">${esc(r.guests || '')}</textarea></label>
      ${r.id ? `<label class="f">Entrada<input class="input" type="date" name="checkin" value="${esc(r.checkin)}" required></label>
      <label class="f">Saída<input class="input" type="date" name="checkout" value="${esc(r.checkout)}" required></label>` : ''}
      <label class="f">Adultos<input class="input" type="number" min="0" name="adults" value="${r.adults ?? ''}" placeholder="pelos nomes"></label>
      <label class="f">Crianças<input class="input" type="number" min="0" name="children" value="${r.children ?? ''}" placeholder="0"></label>
    </form>`;
  }

  function edit(r) {
    const { el: m, close } = modal({
      title: `Alterar quarto ${roomHtml(r.room)}`,
      body: roomForm(r) + '<p class="muted small">Trocar o número do quarto registra a troca e avisa recepção e restaurantes na hora. Para tirar uma pessoa, apague o nome e ajuste adultos/crianças. Para tirar o quarto inteiro, use “Remover”.</p>',
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

  function addRoom(num) {
    const { el: m, close } = modal({
      title: `Incluir quarto na reserva ${esc(num)}`,
      body: roomForm({}) + '<p class="muted small">O quarto entra no grupo com a mesma pensão e datas dos demais quartos e já vai para a divisão das refeições.</p>',
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Incluir</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const f = Object.fromEntries(new FormData(m.querySelector('#pf')));
      try { await post('/api/portal/rooms', { reservation_number: num, ...f }); toast('Quarto incluído. O resort foi avisado.'); close(); load(); } catch (e) { fail(e); }
    };
  }

  function remove(r) {
    const { el: m, close } = modal({
      title: `Remover quarto ${roomHtml(r.room)}?`,
      body: `<p style="margin-top:0">${guestList(r.guests).map(esc).join(', ') || esc(r.guest_name)} · ${paxTxt(r.adults, r.children)} · ${esc(br(r.checkin))} → ${esc(br(r.checkout))}</p>
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
        <p class="muted small">Horários: ${state.meta.meal_times.map((t) => `${esc(t.label)} ${t.start}–${t.end}`).join(' · ')}.</p>`,
      foot: '<button class="btn primary" data-close>Fechar</button>',
    });
  }

  await load();
}
