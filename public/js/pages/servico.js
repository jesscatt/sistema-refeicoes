import { get, post, del, esc, icon, mealIcon, MEAL_FULL, MEAL_LABEL, toast, fail, state, can, boardTag, paxTxt, dayLabel, modal, confirmBox, restTag, today, download, roomHtml } from '../ui.js';
import { dateBar, bindDateBar, readParams, syncParams } from './common.js';

export async function render(el) {
  const p = readParams({});
  const st = { date: p.date || null, meal: p.meal || null, restaurant_id: p.restaurant_id || (state.me.restaurant ? state.me.restaurant.id : ''), tab: 'lista', q: '' };
  if (!st.restaurant_id && !state.me.restaurant) st.restaurant_id = String(state.meta.restaurants[0].id);
  let data = null, timer, searchSeq = 0;

  const qs = () => `date=${st.date || ''}&meal=${st.meal || ''}&restaurant_id=${st.restaurant_id || ''}`;

  async function load() {
    data = await get('/api/service?' + qs());
    st.date = data.date; st.meal = data.meal;
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
          <div class="sub">${esc(dayLabel(data.date))} · serviço ${data.meal_time.start}–${data.meal_time.end}</div>
        </div>
        <div class="svc-counters">
          <div><b>${c.donePax}</b><span>pax atendidos</span></div>
          <div><b>${c.listPax}</b><span>pax na lista</span></div>
          <div><b>${c.pending}</b><span>quartos faltam</span></div>
        </div>
      </div>
      <div class="page-head" style="margin-bottom:14px">
        ${dateBar({ date: data.date, meal: data.meal, extra: can('restaurante') ? '' : `<select class="input sm" id="rest" style="width:auto">${rs.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` })}
        <div class="grow"></div>
        <button class="btn sm" id="print">${icon('print')} Imprimir lista</button>
        <button class="btn sm" id="csv">${icon('download')} CSV</button>
      </div>
      ${!data.serves ? `<div class="banner danger">${icon('alert')}<span>${esc(r.name)} não serve ${MEAL_FULL[data.meal].toLowerCase()}.</span></div>` : ''}
      ${data.serves && !data.published && data.date >= today() ? `<div class="banner warn">${icon('info')}<span><b>Prévia.</b> A lista oficial é liberada às ${openAt} e você recebe um aviso aqui no sistema. Até lá ela ainda pode mudar.</span></div>` : ''}
      ${data.serves && data.published ? `<div class="banner ok">${icon('check')}<span>Lista liberada às ${esc(data.published.published_at.slice(11, 16))}.</span></div>` : ''}
      <div class="search-big">${icon('search')}<input id="q" placeholder="Quarto e torre (ex.: 101A), nome ou reserva" inputmode="search" autocomplete="off" value="${esc(st.q)}"></div>
      <div class="results" id="results"></div>
      <div class="card">
        <div class="card-head">
          <div class="seg" id="tabs">
            <button data-t="lista" class="${st.tab === 'lista' ? 'on' : ''}">Lista (${data.list.length})</button>
            <button data-t="fora" class="${st.tab === 'fora' ? 'on' : ''}">Fora da lista (${data.extras.length})</button>
            <button data-t="avulso" class="${st.tab === 'avulso' ? 'on' : ''}">Pagos à parte (${data.walkins.length})</button>
          </div>
          <div class="grow"></div>
          <button class="btn sm primary" id="fora">${icon('plus')} Fora da lista</button>
          <button class="btn sm" id="walk">${icon('plus')} Consumo à parte</button>
        </div>
        <div id="tab-body">${tabBody()}</div>
      </div>`;
    bindDateBar(el, st, () => { st.q = ''; load().catch(fail); });
    el.querySelector('#rest')?.addEventListener('change', (e) => { st.restaurant_id = e.target.value; load().catch(fail); });
    el.querySelectorAll('#tabs [data-t]').forEach((b) => b.addEventListener('click', () => { st.tab = b.dataset.t; draw(); }));
    el.querySelector('#walk').onclick = () => walkinModal({});
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

  function tabBody() {
    if (st.tab === 'lista') {
      if (!data.list.length) return `<div class="empty">${icon('checklist')}<div>Ninguém na lista deste restaurante.</div></div>`;
      return `<div class="check-list">${data.list.map((g) => {
        const here = g.att_restaurant_id === data.restaurant.id;
        const other = g.att_restaurant_id && !here;
        return `<div class="item ${here ? 'done' : ''} ${other ? 'other' : ''}" data-res="${g.reservation_id}" data-att="${here ? g.attendance_id : ''}" ${other ? 'data-other' : ''}>
          <span class="tick">${icon('check')}</span>
          <span class="room">${roomHtml(g.room)}</span>
          <span style="min-width:0"><span class="nm">${esc(g.guest_name)}</span>${guestLine(g)}<br><span class="muted small">${paxTxt(g.adults, g.children)} · ${boardTag(g.board)} ${other ? ` · <b style="color:var(--danger)">foi ao ${esc(g.att_restaurant.name)}</b>` : ''}</span></span>
          <span class="muted small">${here ? `✓ ${esc(g.att_at.slice(11, 16))}${g.att_adults + g.att_children !== g.adults + g.children ? ` · ${g.att_adults + g.att_children} pax` : ''}` : ''}</span>
        </div>`;
      }).join('')}</div>`;
    }
    if (st.tab === 'fora') {
      const head = `<div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><span class="muted small grow">Hóspedes da lista de outro restaurante que comeram aqui. Ficam registrados aqui e não podem ser marcados de novo em nenhum restaurante.</span><button class="btn sm primary" data-fora>${icon('plus')} Fora da lista · nº do apto</button></div>`;
      if (!data.extras.length) return head + '<div class="empty">Nenhum cliente fora da lista.</div>';
      return head + `<div class="table-wrap"><table class="t"><thead><tr><th>Quarto</th><th>Nome</th><th>Pax</th><th>Deveria comer em</th><th>Hora</th><th></th></tr></thead><tbody>
        ${data.extras.map((x) => `<tr><td class="room">${roomHtml(x.room)}</td><td>${esc(x.guest_name)}${guestLine(x)}</td><td>${paxTxt(x.att_adults, x.att_children)}</td><td>${restTag(x.assigned_restaurant)}</td><td>${esc(x.att_at.slice(11, 16))}</td>
        <td><button class="btn sm ghost" data-undo="${x.attendance_id}">${icon('undo')} Desfazer</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    if (!data.walkins.length) return '<div class="empty">Nenhum consumo pago à parte registrado.</div>';
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Quarto</th><th>Pax</th><th>Obs.</th><th>Hora</th><th></th></tr></thead><tbody>
      ${data.walkins.map((w) => `<tr><td class="room">${esc(w.room || '—')}</td><td>${paxTxt(w.adults, w.children)}</td><td>${esc(w.note || '')}</td><td>${esc(w.created_at.slice(11, 16))}</td>
      <td><button class="btn sm ghost" data-delwalk="${w.id}">${icon('x')}</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function bindList() {
    el.querySelectorAll('.check-list .item').forEach((it) => it.addEventListener('click', async () => {
      if (it.hasAttribute('data-other')) { toast('Este cliente já foi registrado em outro restaurante.', 'err'); return; }
      if (it.dataset.att) {
        if (await confirmBox('Desfazer a marcação deste cliente?', 'Desfazer')) unmark(it.dataset.att);
        return;
      }
      mark(Number(it.dataset.res));
    }));
    el.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('Desfazer esta marcação?', 'Desfazer')) unmark(b.dataset.undo); }));
    el.querySelector('[data-fora]')?.addEventListener('click', () => foraModal());
    el.querySelectorAll('[data-delwalk]').forEach((b) => b.addEventListener('click', async () => {
      try { await del('/api/walkins/' + b.dataset.delwalk); await load(); } catch (e) { fail(e); }
    }));
  }

  async function mark(reservation_id, adults, children) {
    try {
      const r = await post('/api/attendance', { reservation_id, date: data.date, meal: data.meal, restaurant_id: data.restaurant.id, adults, children });
      toast(r.status === 'fora_lista' ? `Registrado FORA DA LISTA aqui${r.assigned_restaurant ? ` (deveria comer em ${r.assigned_restaurant})` : ''}. Não pode ser marcado de novo.` : 'Presença registrada.', r.status === 'fora_lista' ? 'notif' : 'ok');
      st.q = '';
      await load();
    } catch (e) { fail(e); load().catch(() => {}); }
  }
  async function unmark(id) {
    try { await del('/api/attendance/' + id); toast('Marcação desfeita.'); await load(); } catch (e) { fail(e); }
  }

  async function search() {
    const box = el.querySelector('#results');
    const q = st.q.trim();
    if (!q) { box.innerHTML = ''; return; }
    const seq = ++searchSeq;
    let r;
    try { r = await get(`/api/service/search?q=${encodeURIComponent(q)}&${qs()}`); } catch (e) { fail(e); return; }
    if (seq !== searchSeq) return;
    let html = r.moved.map((m) => `<div class="banner info">${icon('swap')}<span><b>Troca de quarto:</b> ${esc(m.guest_name)} saiu do ${esc(m.old_room)} e está agora no <b>${esc(m.new_room)}</b>.</span></div>`).join('');
    if (r.notFound) html += `<div class="result sem_refeicao"><span class="room">?</span><div><b>${esc(r.notFound)}</b><div class="msg">Confira o número do quarto. Se não for hóspede com pensão, cobre à parte.</div></div>
      <div class="act"><button class="btn" data-walkroom="${esc(q)}">Registrar consumo à parte</button></div></div>`;
    html += r.results.map((x) => {
      const canMark = x.state === 'na_lista' || x.state === 'outro_restaurante';
      const here = x.attendance && x.attendance.restaurant_id === data.restaurant.id;
      return `<div class="result ${x.state}" data-res="${x.reservation_id}">
        <span class="room">${roomHtml(x.room)}</span>
        <div style="min-width:0"><b>${esc(x.guest_name)}</b>${guestLine(x)} <span class="muted small">· reserva ${esc(x.reservation_number)} · ${boardTag(x.board)} · ${paxTxt(x.adults, x.children)}</span>
          <div class="msg">${esc(x.message)}</div></div>
        <div class="act row">
          ${canMark ? `
            <div><span class="stepper-l">Adultos</span>${stepper('a', x.adults, x.adults)}</div>
            ${x.children ? `<div><span class="stepper-l">Crianças</span>${stepper('c', x.children, x.children)}</div>` : ''}
            <button class="btn lg ${x.state === 'na_lista' ? 'olive' : ''}" data-mark>${icon('check')} ${x.state === 'na_lista' ? 'Marcar' : 'Marcar fora da lista'}</button>` : ''}
          ${x.state === 'sem_refeicao' ? `<button class="btn" data-walkres="${x.reservation_id}" data-room="${esc(x.room)}">Registrar consumo à parte</button>` : ''}
          ${here ? `<button class="btn" data-undo2="${x.attendance.id}">${icon('undo')} Desfazer</button>` : ''}
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

  // "Fora da lista": digita o apto, mostra onde o hóspede deveria comer e registra aqui
  function foraModal() {
    const { el: m, close } = modal({
      title: `Fora da lista · ${MEAL_FULL[data.meal]} · ${esc(data.restaurant.name)}`,
      body: `<form id="ff" class="row" style="flex-wrap:nowrap"><input class="input" name="q" placeholder="Nº do apto (ex.: 101A)" autocomplete="off" style="font-size:20px" autofocus><button class="btn primary">${icon('search')} Buscar</button></form>
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
      let html = r.moved.map((x) => `<div class="banner info">${icon('swap')}<span><b>Troca de quarto:</b> ${esc(x.guest_name)} saiu do ${esc(x.old_room)} e está agora no <b>${esc(x.new_room)}</b>. Busque pelo quarto novo.</span></div>`).join('');
      if (r.notFound) html += `<div class="banner danger">${icon('alert')}<span>${esc(r.notFound)} Se não é hóspede com pensão, registre como consumo à parte.</span></div>`;
      html += r.results.map((x) => {
        const head = `<div class="row" style="gap:10px"><span class="room" style="font-size:22px">${roomHtml(x.room)}</span><div class="grow" style="min-width:0"><b>${esc(x.guest_name)}</b>${guestLine(x)}<div class="small muted">reserva ${esc(x.reservation_number)} · ${boardTag(x.board)} · ${paxTxt(x.adults, x.children)}</div></div></div>`;
        if (x.state === 'outro_restaurante') return `<div class="result outro_restaurante" style="grid-template-columns:1fr;margin-bottom:10px" data-res="${x.reservation_id}">${head}
          <div class="banner warn" style="margin:10px 0 0"><span>Deveria comer em: ${restTag(x.assigned_restaurant)}</span></div>
          <div class="row" style="margin-top:10px"><div><span class="stepper-l">Adultos</span>${stepper('a', x.adults, x.adults)}</div>${x.children ? `<div><span class="stepper-l">Crianças</span>${stepper('c', x.children, x.children)}</div>` : ''}
          <div class="grow"></div><button class="btn lg primary" data-go>${icon('check')} Registrar fora da lista aqui</button></div></div>`;
        if (x.state === 'na_lista') return `<div class="result na_lista" style="grid-template-columns:1fr;margin-bottom:10px" data-res="${x.reservation_id}">${head}<div class="msg">Está na lista deste restaurante — não é fora da lista.</div>
          <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn olive" data-go>${icon('check')} Marcar presença</button></div></div>`;
        return `<div class="result ${x.state}" style="grid-template-columns:1fr;margin-bottom:10px">${head}<div class="msg">${esc(x.message)}</div>
          ${x.state === 'sem_refeicao' ? `<div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn" data-walk="${x.reservation_id}" data-room="${esc(x.room)}">Registrar consumo à parte</button></div>` : ''}</div>`;
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

  function walkinModal({ room = '', reservation_id = null }) {
    const { el: m, close } = modal({
      title: 'Consumo pago à parte',
      body: `<p class="muted" style="margin-top:0">Para clientes sem esta refeição na pensão. Fica registrado para o controle, mas não entra na conta do hotel.</p>
        <div class="form-grid"><label class="f">Quarto<input class="input" name="room" value="${esc(room)}"></label>
        <label class="f">Adultos<input class="input" name="adults" type="number" min="0" value="1"></label>
        <label class="f">Crianças<input class="input" name="children" type="number" min="0" value="0"></label>
        <label class="f">Observação<input class="input" name="note" placeholder="Ex.: pagou no cartão"></label></div>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Registrar</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const v = (n) => m.querySelector(`[name=${n}]`).value;
      try {
        await post('/api/walkins', { date: data.date, meal: data.meal, restaurant_id: data.restaurant.id, room: v('room'), reservation_id, adults: v('adults'), children: v('children'), note: v('note') });
        close(); toast('Consumo à parte registrado.'); st.q = ''; st.tab = 'avulso'; load();
      } catch (e) { fail(e); }
    };
  }

  function printList() {
    const area = document.getElementById('print-area');
    area.innerHTML = `<div class="plist"><h2>${esc(data.restaurant.name)} — ${MEAL_FULL[data.meal]} ${esc(dayLabel(data.date))}</h2>
      <p>${data.list.length} reservas · ${data.list.reduce((s, r) => s + r.adults + r.children, 0)} pax</p>
      <table><thead><tr><th></th><th>Quarto</th><th>Nome</th><th>Adt</th><th>Chd</th><th>Pensão</th></tr></thead><tbody>
      ${data.list.map((g) => `<tr><td><span class="box"></span></td><td><b>${roomHtml(g.room)}</b></td><td>${esc(g.guest_name)}</td><td>${g.adults}</td><td>${g.children}</td><td>${esc(g.board)}</td></tr>`).join('')}
      </tbody></table></div>`;
    window.print();
  }

  await load();
  timer = setInterval(() => {
    const busy = document.activeElement && document.activeElement.id === 'q' && st.q;
    if (!busy && !document.querySelector('.modal-bg')) load().catch(() => {});
  }, 20000);
  return () => clearInterval(timer);
}
