import { roomError, get, post, del, esc, icon, mealIcon, MEAL_FULL, MEAL_LABEL, toast, fail, state, can, boardTag, paxTxt, dayLabel, modal, confirmBox, restTag, today, download, roomHtml } from '../ui.js';
import { dateBar, bindDateBar, readParams, syncParams } from './common.js';

export async function render(el) {
  const p = readParams({});
  const st = { date: p.date || null, meal: p.meal || null, restaurant_id: p.restaurant_id || (state.me.restaurant ? state.me.restaurant.id : ''), tab: 'lista', q: '' };
  if (!st.restaurant_id && !state.me.restaurant) st.restaurant_id = String(state.meta.restaurants[0].id);
  let data = null, reg = { extras: [], vouchers: [], price: {} }, timer, searchSeq = 0;

  const qs = () => `date=${st.date || ''}&meal=${st.meal || ''}&restaurant_id=${st.restaurant_id || ''}`;

  async function load() {
    data = await get('/api/service?' + qs());
    st.date = data.date; st.meal = data.meal;
    try { reg = await get(`/api/extras?date=${data.date}&meal=${data.meal}&restaurant_id=${data.restaurant.id}`); } catch { reg = { extras: [], vouchers: [], price: {} }; }
    syncParams(st, can('restaurante') ? ['date', 'meal'] : ['date', 'meal', 'restaurant_id']);
    draw();
  }

  function counters() {
    const listPax = data.list.reduce((s, r) => s + r.adults + r.children, 0);
    const here = data.list.filter((r) => r.att_restaurant_id === data.restaurant.id);
    const donePax = here.reduce((s, r) => s + r.att_adults + r.att_children, 0) + data.extras.reduce((s, r) => s + r.att_adults + r.att_children, 0);
    return { listPax, donePax, pending: data.list.filter((r) => !r.attendance_id).length, extras: data.extras.length, walk: data.walkins.reduce((s, w) => s + w.adults + w.children, 0) };
  }

  function draw() {
    const r = data.restaurant, c = counters();
    const rs = state.meta.restaurants;
    const openAt = (() => { const [h, m] = data.meal_time.start.split(':').map(Number); const t = h * 60 + m - data.meal_time.notify_before_min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; })();
    el.innerHTML = `
      <div class="svc-head" style="--c:${esc(r.color)}">
        <div>
          <div class="row" style="gap:10px">${mealIcon(data.meal).replace('<svg', '<svg style="width:28px;height:28px"')}<h1>${MEAL_FULL[data.meal]} · ${esc(r.name)}</h1></div>
          <div class="sub">${esc(dayLabel(data.date))} · horário de serviço: ${data.meal_time.start} às ${data.meal_time.end}</div>
        </div>
        <div class="svc-counters">
          <div><b>${c.donePax}</b><span>Hóspedes atendidos</span></div>
          <div><b>${c.listPax}</b><span>Hóspedes previstos</span></div>
          <div><b>${c.pending}</b><span>Apartamentos pendentes</span></div>
        </div>
      </div>
      <div class="page-head" style="margin-bottom:14px">
        ${dateBar({ date: data.date, meal: data.meal, extra: can('restaurante') ? '' : `<select class="input sm" id="rest" style="width:auto">${rs.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` })}
        <div class="grow"></div>
        <button class="btn sm" id="print">${icon('print')} Imprimir lista</button>
        <button class="btn sm" id="csv">${icon('download')} Exportar CSV</button>
      </div>
      ${!data.serves ? `<div class="banner danger">${icon('alert')}<span>${esc(r.name)} não oferece ${MEAL_FULL[data.meal].toLowerCase()}.</span></div>` : ''}
      ${data.serves && !data.published && data.date >= today() ? `<div class="banner warn">${icon('info')}<span><b>Lista preliminar.</b> A lista oficial será liberada às ${openAt}, com aviso no sistema. Até a liberação, poderá sofrer alterações.</span></div>` : ''}
      ${data.serves && data.published ? `<div class="banner ok">${icon('check')}<span>Lista oficial liberada às ${esc(data.published.published_at.slice(11, 16))}.</span></div>` : ''}
      <div class="search-big">${icon('search')}<input id="q" placeholder="Apartamento (ex.: 101A), nome do hóspede ou número da reserva" inputmode="search" autocomplete="off" value="${esc(st.q)}"></div>
      <div class="results" id="results"></div>
      <div class="card">
        <div class="card-head">
          <div class="seg" id="tabs">
            <button data-t="lista" class="${st.tab === 'lista' ? 'on' : ''}">Lista do restaurante (${data.list.length})</button>
            <button data-t="fora" class="${st.tab === 'fora' ? 'on' : ''}">Atendimentos fora da lista (${data.extras.length})</button>
            <button data-t="avulso" class="${st.tab === 'avulso' ? 'on' : ''}">Consumos cobrados à parte (${data.walkins.length})</button>
            <button data-t="extra" class="${st.tab === 'extra' ? 'on' : ''}">Refeições extras (${reg.extras.reduce((a, x) => a + x.adults + x.children, 0)})</button>
            ${acceptsVoucher() ? `<button data-t="voucher" class="${st.tab === 'voucher' ? 'on' : ''}">Vouchers registrados (${reg.vouchers.length})</button>` : ''}
          </div>
          <div class="grow"></div>
          <button class="btn sm primary" id="fora">${icon('plus')} Registrar fora da lista</button>
          ${acceptsVoucher() ? `<button class="btn sm primary" id="voucher">${icon('card')} Registrar voucher</button>` : ''}
          <button class="btn sm" id="extra">${icon('plus')} Registrar refeição extra</button>
          <button class="btn sm" id="walk">${icon('plus')} Registrar consumo cobrado à parte</button>
        </div>
        <div id="tab-body">${tabBody()}</div>
      </div>`;
    bindDateBar(el, st, () => { st.q = ''; load().catch(fail); });
    el.querySelector('#rest')?.addEventListener('change', (e) => { st.restaurant_id = e.target.value; load().catch(fail); });
    el.querySelectorAll('#tabs [data-t]').forEach((b) => b.addEventListener('click', () => { st.tab = b.dataset.t; draw(); }));
    el.querySelector('#walk').onclick = () => walkinModal({});
    el.querySelector('#extra').onclick = () => extraModal();
    el.querySelector('#voucher')?.addEventListener('click', () => voucherModal());
    el.querySelector('#fora').onclick = () => foraModal();
    el.querySelector('#csv').onclick = () => download(`/api/distribution/export.csv?date=${data.date}&meal=${data.meal}&restaurant_id=${r.id}`);
    el.querySelector('#print').onclick = printList;
    const q = el.querySelector('#q');
    let deb;
    q.addEventListener('input', () => { st.q = q.value; clearTimeout(deb); deb = setTimeout(search, 220); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const ok = el.querySelectorAll('.result.na_lista [data-mark]');
        if (ok.length === 1) ok[0].click();
      }
      if (e.key === 'Escape') { q.value = ''; st.q = ''; search(); }
    });
    bindList();
    if (st.q) search();
    if (!matchMedia('(max-width: 860px)').matches) q.focus();
  }

  function acceptsVoucher() {
    const r = state.meta.restaurants.find((x) => x.id === data.restaurant.id);
    return !!(r && r.accepts_voucher);
  }
  const brl = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function tabBody() {
    if (st.tab === 'extra') {
      const p = reg.price || {};
      const head = `<p class="muted small" style="padding:10px 16px 0;margin:0">Refeições extras são cobradas pelo valor de extra${p.extra_adult ? ` (${brl(p.extra_adult)} por adulto e ${brl(p.extra_child)} por criança)` : ''} e integram o controle do restaurante e o faturamento.</p>`;
      if (!reg.extras.length) return head + '<div class="empty">Não há refeições extras registradas neste serviço.</div>';
      return head + `<div class="table-wrap"><table class="t"><thead><tr><th>Pessoas</th><th>Descrição</th><th>Registrado por</th><th>Horário</th><th></th></tr></thead><tbody>
        ${reg.extras.map((x) => `<tr><td>${paxTxt(x.adults, x.children)}</td><td>${esc(x.note || '')}</td><td class="small">${esc(x.user_name || '')}</td><td>${esc(x.created_at.slice(11, 16))}</td>
        <td><button class="btn sm ghost" data-delextra="${x.id}">${icon('x')}</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    if (st.tab === 'voucher') {
      if (!reg.vouchers.length) return '<div class="empty">Não há vouchers registrados neste serviço.</div>';
      return `<div class="table-wrap"><table class="t"><thead><tr><th>Voucher</th><th>Pessoas</th><th>Observação</th><th>Registrado por</th><th>Horário</th><th></th></tr></thead><tbody>
        ${reg.vouchers.map((x) => `<tr><td><b>${esc(x.code)}</b></td><td>${paxTxt(x.adults, x.children)}</td><td>${esc(x.note || '')}</td><td class="small">${esc(x.user_name || '')}</td><td>${esc(x.created_at.slice(11, 16))}</td>
        <td><button class="btn sm ghost" data-delvoucher="${x.id}">${icon('x')}</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    if (st.tab === 'lista') {
      if (!data.list.length) return `<div class="empty">${icon('checklist')}<div>Não há hóspedes na lista deste restaurante.</div></div>`;
      return `<div class="check-list">${data.list.map((g) => {
        const here = g.att_restaurant_id === data.restaurant.id;
        const other = g.att_restaurant_id && !here;
        return `<div class="item ${here ? 'done' : ''} ${other ? 'other' : ''}" data-res="${g.reservation_id}" data-att="${here ? g.attendance_id : ''}" ${other ? 'data-other' : ''}>
          <span class="tick">${icon('check')}</span>
          <span class="room">${roomHtml(g.room)}</span>
          <span style="min-width:0"><span class="nm">${esc(g.guest_name)}</span>${guestLine(g)}<br><span class="muted small">${paxTxt(g.adults, g.children)} · ${boardTag(g.board)} ${other ? ` · <b style="color:var(--danger)">atendido no restaurante ${esc(g.att_restaurant.name)}</b>` : ''}</span></span>
          <span class="muted small">${here ? `✓ ${esc(g.att_at.slice(11, 16))}${g.att_adults + g.att_children !== g.adults + g.children ? ` · ${g.att_adults + g.att_children} pessoa(s)` : ''}` : ''}</span>
        </div>`;
      }).join('')}</div>`;
    }
    if (st.tab === 'fora') {
      const head = `<div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><span class="muted small grow">Hóspedes designados a outro restaurante e atendidos neste. O registro impede novo atendimento na mesma refeição em qualquer restaurante.</span><button class="btn sm primary" data-fora>${icon('plus')} Registrar fora da lista</button></div>`;
      if (!data.extras.length) return head + '<div class="empty">Não há atendimentos fora da lista neste serviço.</div>';
      return head + `<div class="table-wrap"><table class="t"><thead><tr><th>Apartamento</th><th>Hóspede</th><th>Pessoas</th><th>Restaurante designado</th><th>Horário</th><th></th></tr></thead><tbody>
        ${data.extras.map((x) => `<tr><td class="room">${roomHtml(x.room)}</td><td>${esc(x.guest_name)}${guestLine(x)}</td><td>${paxTxt(x.att_adults, x.att_children)}</td><td>${restTag(x.assigned_restaurant)}</td><td>${esc(x.att_at.slice(11, 16))}</td>
        <td><button class="btn sm ghost" data-undo="${x.attendance_id}">${icon('undo')} Cancelar registro</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    if (!data.walkins.length) return '<div class="empty">Não há consumos cobrados à parte neste serviço.</div>';
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Apartamento</th><th>Pessoas</th><th>Observação</th><th>Horário</th><th></th></tr></thead><tbody>
      ${data.walkins.map((w) => `<tr><td class="room">${esc(w.room || '—')}</td><td>${paxTxt(w.adults, w.children)}</td><td>${esc(w.note || '')}</td><td>${esc(w.created_at.slice(11, 16))}</td>
      <td><button class="btn sm ghost" data-delwalk="${w.id}">${icon('x')}</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function bindList() {
    el.querySelectorAll('.check-list .item').forEach((it) => it.addEventListener('click', async () => {
      if (it.hasAttribute('data-other')) { toast('Este hóspede já foi atendido em outro restaurante nesta refeição.', 'err'); return; }
      if (it.dataset.att) {
        if (await confirmBox('Deseja cancelar o registro de atendimento deste hóspede?', 'Cancelar registro')) unmark(it.dataset.att);
        return;
      }
      mark(Number(it.dataset.res));
    }));
    el.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('Deseja cancelar este registro de atendimento?', 'Cancelar registro')) unmark(b.dataset.undo); }));
    el.querySelector('[data-fora]')?.addEventListener('click', () => foraModal());
    el.querySelectorAll('[data-delwalk]').forEach((b) => b.addEventListener('click', async () => {
      try { await del('/api/walkins/' + b.dataset.delwalk); await load(); } catch (e) { fail(e); }
    }));
    el.querySelectorAll('[data-delextra]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmBox('Deseja excluir este registro de refeição extra?', 'Excluir', true))) return;
      try { await del('/api/extras/' + b.dataset.delextra); await load(); } catch (e) { fail(e); }
    }));
    el.querySelectorAll('[data-delvoucher]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmBox('Deseja excluir este voucher? O número poderá ser registrado novamente.', 'Excluir', true))) return;
      try { await del('/api/vouchers/' + b.dataset.delvoucher); await load(); } catch (e) { fail(e); }
    }));
  }

  async function mark(reservation_id, adults, children) {
    try {
      const r = await post('/api/attendance', { reservation_id, date: data.date, meal: data.meal, restaurant_id: data.restaurant.id, adults, children });
      toast(r.status === 'fora_lista' ? `Atendimento fora da lista registrado${r.assigned_restaurant ? ` (restaurante designado: ${r.assigned_restaurant})` : ''}. Não será possível novo registro nesta refeição.` : 'Atendimento registrado.', r.status === 'fora_lista' ? 'notif' : 'ok');
      st.q = '';
      await load();
    } catch (e) { fail(e); load().catch(() => {}); }
  }
  async function unmark(id) {
    try { await del('/api/attendance/' + id); toast('Registro de atendimento cancelado.'); await load(); } catch (e) { fail(e); }
  }

  async function search() {
    const box = el.querySelector('#results');
    const q = st.q.trim();
    if (!q) { box.innerHTML = ''; return; }
    const seq = ++searchSeq;
    let r;
    try { r = await get(`/api/service/search?q=${encodeURIComponent(q)}&${qs()}`); } catch (e) { fail(e); return; }
    if (seq !== searchSeq) return;
    let html = r.moved.map((m) => `<div class="banner info">${icon('swap')}<span><b>Troca de apartamento:</b> ${esc(m.guest_name)} foi transferido do apartamento ${esc(m.old_room)} para o apartamento <b>${esc(m.new_room)}</b>.</span></div>`).join('');
    if (r.notFound) html += `<div class="result sem_refeicao"><span class="room">?</span><div><b>${esc(r.notFound)}</b><div class="msg">Verifique o número do apartamento. Caso não se trate de hóspede com pensão, a refeição deve ser cobrada à parte.</div></div>
      <div class="act"><button class="btn" data-walkroom="${esc(q)}">Registrar consumo cobrado à parte</button></div></div>`;
    html += r.results.map((x) => {
      const canMark = x.state === 'na_lista' || x.state === 'outro_restaurante';
      const here = x.attendance && x.attendance.restaurant_id === data.restaurant.id;
      return `<div class="result ${x.state}" data-res="${x.reservation_id}">
        <span class="room">${roomHtml(x.room)}</span>
        <div style="min-width:0"><b>${esc(x.guest_name)}</b>${guestLine(x)} <span class="muted small">· Reserva nº ${esc(x.reservation_number)} · ${boardTag(x.board)} · ${paxTxt(x.adults, x.children)}</span>
          <div class="msg">${esc(x.message)}</div></div>
        <div class="act row">
          ${canMark ? `
            <div><span class="stepper-l">Adultos</span>${stepper('a', x.adults, x.adults)}</div>
            ${x.children ? `<div><span class="stepper-l">Crianças</span>${stepper('c', x.children, x.children)}</div>` : ''}
            <button class="btn lg ${x.state === 'na_lista' ? 'olive' : ''}" data-mark>${icon('check')} ${x.state === 'na_lista' ? 'Registrar atendimento' : 'Registrar fora da lista'}</button>` : ''}
          ${x.state === 'sem_refeicao' ? `<button class="btn" data-walkres="${x.reservation_id}" data-room="${esc(x.room)}">Registrar consumo cobrado à parte</button>` : ''}
          ${here ? `<button class="btn" data-undo2="${x.attendance.id}">${icon('undo')} Cancelar registro</button>` : ''}
        </div></div>`;
    }).join('');
    box.innerHTML = html;
    box.querySelectorAll('.stepper').forEach(bindStepper);
    box.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', () => {
      const card = b.closest('.result');
      const a = card.querySelector('.stepper[data-k="a"]'), c = card.querySelector('.stepper[data-k="c"]');
      mark(Number(card.dataset.res), a ? Number(a.dataset.v) : undefined, c ? Number(c.dataset.v) : 0);
    }));
    box.querySelectorAll('[data-undo2]').forEach((b) => b.addEventListener('click', () => unmark(b.dataset.undo2)));
    box.querySelectorAll('[data-walkres]').forEach((b) => b.addEventListener('click', () => walkinModal({ room: b.dataset.room, reservation_id: Number(b.dataset.walkres) })));
    box.querySelectorAll('[data-walkroom]').forEach((b) => b.addEventListener('click', () => walkinModal({ room: b.dataset.walkroom })));
  }

  function guestLine(g) {
    const n = String(g.guests || '').split('\n').filter(Boolean);
    return n.length ? `<div class="small muted" style="white-space:normal">${n.map(esc).join(', ')}</div>` : '';
  }

  // "Fora da lista": digita o apartamento, mostra onde o hóspede deveria comer e registra aqui
  function foraModal() {
    const { el: m, close } = modal({
      title: `Atendimento fora da lista · ${MEAL_FULL[data.meal]} · ${esc(data.restaurant.name)}`,
      body: `<form id="ff" class="row" style="flex-wrap:nowrap"><input class="input" name="q" placeholder="Número do apartamento (ex.: 101A)" autocomplete="off" style="font-size:20px" autofocus><button class="btn primary">${icon('search')} Pesquisar</button></form>
        <div id="fr" style="margin-top:14px"></div>`,
    });
    const input = m.querySelector('[name=q]');
    setTimeout(() => input.focus(), 50);
    m.querySelector('#ff').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      const box = m.querySelector('#fr');
      let r;
      try { r = await get(`/api/service/search?q=${encodeURIComponent(q)}&${qs()}`); } catch (err) { fail(err); return; }
      let html = r.moved.map((x) => `<div class="banner info">${icon('swap')}<span><b>Troca de apartamento:</b> ${esc(x.guest_name)} foi transferido do apartamento ${esc(x.old_room)} para o apartamento <b>${esc(x.new_room)}</b>. Pesquise pelo novo apartamento.</span></div>`).join('');
      if (r.notFound) html += `<div class="banner danger">${icon('alert')}<span>${esc(r.notFound)} Caso não se trate de hóspede com pensão, registre como consumo cobrado à parte.</span></div>`;
      html += r.results.map((x) => {
        const head = `<div class="row" style="gap:10px"><span class="room" style="font-size:22px">${roomHtml(x.room)}</span><div class="grow" style="min-width:0"><b>${esc(x.guest_name)}</b>${guestLine(x)}<div class="small muted">Reserva nº ${esc(x.reservation_number)} · ${boardTag(x.board)} · ${paxTxt(x.adults, x.children)}</div></div></div>`;
        if (x.state === 'outro_restaurante') return `<div class="result outro_restaurante" style="grid-template-columns:1fr;margin-bottom:10px" data-res="${x.reservation_id}">${head}
          <div class="banner warn" style="margin:10px 0 0"><span>Restaurante designado: ${restTag(x.assigned_restaurant)}</span></div>
          <div class="row" style="margin-top:10px"><div><span class="stepper-l">Adultos</span>${stepper('a', x.adults, x.adults)}</div>${x.children ? `<div><span class="stepper-l">Crianças</span>${stepper('c', x.children, x.children)}</div>` : ''}
          <div class="grow"></div><button class="btn lg primary" data-go>${icon('check')} Registrar atendimento neste restaurante</button></div></div>`;
        if (x.state === 'na_lista') return `<div class="result na_lista" style="grid-template-columns:1fr;margin-bottom:10px" data-res="${x.reservation_id}">${head}<div class="msg">O hóspede consta na lista deste restaurante; não se trata de atendimento fora da lista.</div>
          <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn olive" data-go>${icon('check')} Registrar atendimento</button></div></div>`;
        return `<div class="result ${x.state}" style="grid-template-columns:1fr;margin-bottom:10px">${head}<div class="msg">${esc(x.message)}</div>
          ${x.state === 'sem_refeicao' ? `<div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn" data-walk="${x.reservation_id}" data-room="${esc(x.room)}">Registrar consumo cobrado à parte</button></div>` : ''}</div>`;
      }).join('');
      box.innerHTML = html;
      box.querySelectorAll('.stepper').forEach(bindStepper);
      box.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => {
        const card = b.closest('[data-res]');
        const a = card.querySelector('.stepper[data-k="a"]'), c = card.querySelector('.stepper[data-k="c"]');
        close();
        await mark(Number(card.dataset.res), a ? Number(a.dataset.v) : undefined, c ? Number(c.dataset.v) : 0);
        st.tab = 'fora'; draw();
      }));
      box.querySelectorAll('[data-walk]').forEach((b) => b.addEventListener('click', () => { close(); walkinModal({ room: b.dataset.room, reservation_id: Number(b.dataset.walk) }); }));
    });
  }

  function stepper(k, v, max) {
    return `<div class="stepper" data-k="${k}" data-v="${v}" data-max="${max}"><button type="button" data-s="-1">−</button><span>${v}</span><button type="button" data-s="1">+</button></div>`;
  }
  function bindStepper(s) {
    s.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => {
      const v = Math.max(0, Math.min(Number(s.dataset.max), Number(s.dataset.v) + Number(b.dataset.s)));
      s.dataset.v = v; s.querySelector('span').textContent = v;
    }));
  }

  function extraModal() {
    const p = reg.price || {};
    const { el: m, close } = modal({
      title: `Refeição extra · ${esc(data.restaurant.name)} · ${MEAL_FULL[data.meal]}`,
      body: `<p class="muted" style="margin-top:0">Refeições adicionais cobradas pelo valor de extra${p.extra_adult ? ` (<b>${brl(p.extra_adult)}</b> por adulto e <b>${brl(p.extra_child)}</b> por criança)` : ''}.</p>
        <div class="form-grid"><label class="f">Adultos<input class="input" name="adults" type="number" min="0" value="1"></label>
        <label class="f">Crianças<input class="input" name="children" type="number" min="0" value="0"></label>
        <label class="f" style="grid-column:1/-1">Descrição <span style="color:var(--danger)">*</span><input class="input" name="note" placeholder="Obrigatório. Ex.: evento, mesa 12, responsável pela autorização"></label></div>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Registrar refeição extra</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const v = (n) => m.querySelector(`[name=${n}]`).value;
      if (v('note').trim().length < 3) { m.querySelector('[name=note]').focus(); toast('Informe a descrição da refeição extra.', 'err'); return; }
      try { await post('/api/extras', { date: data.date, meal: data.meal, restaurant_id: data.restaurant.id, adults: v('adults'), children: v('children'), note: v('note') }); close(); toast('Refeição extra registrada.'); st.tab = 'extra'; load(); } catch (e) { fail(e); }
    };
  }

  function voucherModal() {
    const { el: m, close } = modal({
      title: `Registro de voucher · ${MEAL_FULL[data.meal]}`,
      body: `<div class="form-grid"><label class="f" style="grid-column:1/-1">Número do voucher <span style="color:var(--danger)">*</span><input class="input" name="code" autocomplete="off" style="font-size:18px;letter-spacing:.06em" placeholder="Digite ou faça a leitura do código"></label>
        <label class="f">Adultos<input class="input" name="adults" type="number" min="0" value="1"></label>
        <label class="f">Crianças<input class="input" name="children" type="number" min="0" value="0"></label>
        <label class="f" style="grid-column:1/-1">Observação<input class="input" name="note" placeholder="Opcional"></label></div>
        <p class="muted small">Cada voucher pode ser registrado uma única vez e integra o controle do restaurante pelo valor da refeição.</p>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Registrar voucher</button>',
    });
    setTimeout(() => m.querySelector('[name=code]').focus(), 50);
    m.querySelector('[data-ok]').onclick = async () => {
      const v = (n) => m.querySelector(`[name=${n}]`).value;
      if (!v('code').trim()) { m.querySelector('[name=code]').focus(); toast('Informe o número do voucher.', 'err'); return; }
      try { await post('/api/vouchers', { date: data.date, meal: data.meal, restaurant_id: data.restaurant.id, code: v('code'), adults: v('adults'), children: v('children'), note: v('note') }); close(); toast('Voucher registrado.'); st.tab = 'voucher'; load(); } catch (e) { fail(e); }
    };
  }

  function walkinModal({ room = '', reservation_id = null }) {
    const { el: m, close } = modal({
      title: 'Consumo cobrado à parte',
      body: `<p class="muted" style="margin-top:0">Destinado a hóspedes sem esta refeição na pensão ou a não hóspedes. O registro é mantido para controle e não integra a conta do hotel.</p>
        <div class="form-grid"><label class="f">Apartamento<input class="input" name="room" data-room maxlength="4" autocomplete="off" placeholder="101A" title="3 números e a letra da torre (A a H), ex.: 101A" value="${esc(room)}"></label>
        <label class="f">Adultos<input class="input" name="adults" type="number" min="0" value="1"></label>
        <label class="f">Crianças<input class="input" name="children" type="number" min="0" value="0"></label>
        <label class="f" style="grid-column:1/-1">Observação <span style="color:var(--danger)">*</span><input class="input" name="note" required placeholder="Obrigatório. Ex.: pagamento em cartão, comanda nº 1234"></label></div>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Registrar</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const v = (n) => m.querySelector(`[name=${n}]`).value;
      if (v('room').trim() && roomError(v('room'))) { const f = m.querySelector('[name=room]'); f.focus(); f.style.borderColor = 'var(--danger)'; toast(roomError(v('room')), 'err'); return; }
      if (v('note').trim().length < 3) { const f = m.querySelector('[name=note]'); f.focus(); f.style.borderColor = 'var(--danger)'; toast('Informe a observação do consumo cobrado à parte.', 'err'); return; }
      try {
        await post('/api/walkins', { date: data.date, meal: data.meal, restaurant_id: data.restaurant.id, room: v('room'), reservation_id, adults: v('adults'), children: v('children'), note: v('note') });
        close(); toast('Consumo cobrado à parte registrado.'); st.q = ''; st.tab = 'avulso'; load();
      } catch (e) { fail(e); }
    };
  }

  function printList() {
    const area = document.getElementById('print-area');
    area.innerHTML = `<div class="plist"><h2>${esc(data.restaurant.name)} — ${MEAL_FULL[data.meal]} ${esc(dayLabel(data.date))}</h2>
      <p>${data.list.length} reservas · ${data.list.reduce((s, r) => s + r.adults + r.children, 0)} pessoas</p>
      <table><thead><tr><th></th><th>Apartamento</th><th>Hóspede</th><th>Adultos</th><th>Crianças</th><th>Pensão</th></tr></thead><tbody>
      ${data.list.map((g) => `<tr><td><span class="box"></span></td><td><b>${roomHtml(g.room)}</b></td><td>${esc(g.guest_name)}</td><td>${g.adults}</td><td>${g.children}</td><td>${esc(g.board)}</td></tr>`).join('')}
      </tbody></table></div>`;
    window.print();
  }

  await load();
  timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    const busy = document.activeElement && document.activeElement.id === 'q' && st.q;
    if (!busy && !document.querySelector('.modal-bg')) load().catch(() => {});
  }, 20000);
  return () => clearInterval(timer);
}
