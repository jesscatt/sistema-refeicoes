import { get, put, esc, icon, mealIcon, MEAL_FULL, today, dayLabel, pct, restDot, can, canSee, state, modal, toast, fail } from '../ui.js';
import { dateBar, bindDateBar, readParams, syncParams } from './common.js';

export async function render(el) {
  const st = readParams({ date: today() });
  let timer;

  async function load() {
    syncParams(st, ['date']);
    const [d, notifs, rd] = await Promise.all([get('/api/dashboard?date=' + st.date), get('/api/notifications').catch(() => []), get('/api/restaurants/week?date=' + st.date)]);
    const boards = Object.fromEntries(d.boards.map((b) => [b.board, b]));
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Painel geral</h1><p>${esc(dayLabel(d.date))} · divisão Di Giordana 60% · Paradiso 20% · Maestro 20% (café 60/40)</p></div>
        ${dateBar({ date: st.date })}
      </div>
      ${openCard(rd)}
      <div class="stats">
        <div class="card stat"><div class="k">Hospedados</div><div class="v">${d.inhouse.adults + d.inhouse.children}<small>pax · ${d.inhouse.reservas} reservas</small></div></div>
        <div class="card stat"><div class="k">Adultos / Crianças</div><div class="v">${d.inhouse.adults}<small>adt</small> ${d.inhouse.children}<small>chd</small></div></div>
        <div class="card stat"><div class="k">Entradas · Saídas</div><div class="v">${d.arrivals}<small>entram</small> ${d.departures}<small>saem</small></div></div>
        <div class="card stat"><div class="k">Pensões</div><div class="v" style="font-size:15px;font-family:var(--font);display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${['CM', 'MAP', 'MAPA', 'FAP', 'SA'].filter((b) => boards[b]).map((b) => `<span class="badge"><b>${b}</b> ${boards[b].n}</span>`).join('') || '<span class="muted">—</span>'}
        </div></div>
      </div>
      <div class="grid g3">
        ${d.meals.map((m) => mealCard(m, d.date)).join('')}
      </div>
      <div class="card" style="margin-top:18px">
        <div class="card-head">${icon('bell')}<h3 class="grow">Avisos</h3><span class="muted small">listas liberadas, trocas de apartamento, rooming lists e alterações</span></div>
        ${notifs.length ? `<div>${notifs.slice(0, 10).map((n) => `<a class="aviso ${n.read ? '' : 'unread'}" href="${esc(n.link && canSee(n.link.replace(/^#\//, '').split('?')[0]) ? n.link : '#/painel')}">
            <b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ''}<small>${esc(n.created_at.slice(8, 10) + '/' + n.created_at.slice(5, 7) + ' ' + n.created_at.slice(11, 16))}</small></a>`).join('')}</div>`
          : '<div class="empty">Nenhum aviso nos últimos dias.</div>'}
      </div>
      <div class="card" style="margin-top:18px">
        <div class="card-head">${icon('swap')}<h3 class="grow">Trocas de apartamento recentes</h3>${canSee('trocas') ? '<a class="btn sm" href="#/trocas">Ver todas</a>' : ''}</div>
        ${d.roomChanges.length ? `<div class="table-wrap"><table class="t"><tbody>${d.roomChanges.map((c) => `
          <tr><td class="room">${esc(c.old_room)} → ${esc(c.new_room)}</td><td>${esc(c.guest_name)} <span class="muted small">· reserva ${esc(c.reservation_number)}</span></td>
          <td class="muted small">${esc(c.created_at.slice(8, 10) + '/' + c.created_at.slice(5, 7) + ' ' + c.created_at.slice(11, 16))}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">Nenhuma troca registrada.</div>'}
      </div>`;
    bindDateBar(el, st, load);
    el.querySelectorAll('[data-rday]').forEach((b) => b.addEventListener('click', () => toggleDay(rd, b.dataset.rday, b.dataset.meal, b.dataset.date)));
  }

  const REASON = { fechado_semana: 'fechado neste dia da semana', fechado_dia: 'fechado nesta data', aberto_excecao: 'aberto excepcionalmente' };
  const WD = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const SHORT = { cafe: 'Café', almoco: 'Almoço', janta: 'Jantar' };
  function openCard(wk) {
    const edit = can('admin', 'refeicao');
    const br = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
    const wdOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
    const isThisWeek = wk.days.includes(wk.today);
    return `<div class="card" style="margin-bottom:18px">
      <div class="card-head">${icon('plate')}<h3 class="grow">Restaurantes abertos ${isThisWeek ? 'nesta semana' : 'na semana'} · ${br(wk.from)} a ${br(wk.to)}</h3>
        <span class="row small muted" style="gap:10px"><span class="leg on"></span>aberto <span class="leg off"></span>fechado <span class="leg na"></span>não serve${edit ? ' · clique para abrir ou fechar' : ''}</span></div>
      <div class="table-wrap"><table class="t week">
        <thead><tr><th>Restaurante</th>${wk.days.map((d) => `<th class="${d === wk.today ? 'today' : ''}">${wdOf(d)}<div>${br(d)}${d === wk.today ? ' · hoje' : ''}</div></th>`).join('')}</tr></thead>
        <tbody>${wk.restaurants.map((r) => `<tr>
          <td class="wr"><span class="row" style="gap:8px;flex-wrap:nowrap">${restDot(r)}<b>${esc(r.name)}</b></span></td>
          ${r.days.map((d) => `<td class="${d.date === wk.today ? 'today' : ''}"><div class="wk-meals">${d.meals.map((m) => {
            const cls = !m.serves ? 'na' : m.open ? 'on' : 'off';
            const can = edit && m.serves && d.date >= wk.today;
            const tip = `${SHORT[m.meal]} · ${!m.serves ? 'não serve' : m.open ? 'aberto' : 'fechado'}${m.note ? ' · ' + m.note : ''}`;
            return `<${can ? 'button' : 'span'} class="wm ${cls}" title="${esc(tip)}" ${can ? `data-rday="${r.id}" data-meal="${m.meal}" data-date="${d.date}"` : ''}>${SHORT[m.meal]}</${can ? 'button' : 'span'}>`;
          }).join('')}</div>${d.meals.some((m) => m.note && !m.open) ? `<div class="wk-note">${esc(d.meals.find((m) => m.note && !m.open).note)}</div>` : ''}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  }

  function toggleDay(wk, restId, meal, date) {
    const r = wk.restaurants.find((x) => String(x.id) === String(restId));
    const m = r.days.find((x) => x.date === date).meals.find((x) => x.meal === meal);
    const t = wk.meal_times.find((x) => x.meal === meal);
    Object.assign(m, { label: t.label, start: t.start, end: t.end });
    const rd = { date };
    const closing = m.open;
    const { el: md, close } = modal({
      title: `${closing ? 'Fechar' : 'Abrir'} ${esc(r.name)} · ${esc(m.label)}`,
      body: `<p style="margin-top:0">${esc(dayLabel(rd.date))} · ${m.start} – ${m.end}</p>
        ${closing ? '<p class="muted small">Os apartamentos ainda não atendidos neste restaurante serão redistribuídos entre os restaurantes abertos, mantendo os grupos juntos. Todos os perfis recebem o aviso.</p>' : '<p class="muted small">O restaurante volta a receber hóspedes nesta refeição. Se a lista ainda não foi liberada, a distribuição é refeita.</p>'}
        <label class="f">Motivo / observação<input class="input" name="note" placeholder="${closing ? 'Ex.: manutenção, evento fechado' : 'Ex.: alta ocupação'}" value="${esc(m.note || '')}"></label>`,
      foot: `<button class="btn" data-close>Cancelar</button><button class="btn ${closing ? 'danger' : 'primary'}" data-ok>${closing ? 'Fechar restaurante' : 'Abrir restaurante'}</button>`,
    });
    md.querySelector('[data-ok]').onclick = async () => {
      try {
        const res = await put('/api/restaurants/day', { date: rd.date, meal, restaurant_id: r.id, open: !closing, note: md.querySelector('[name=note]').value });
        toast(`${r.name} ${closing ? 'fechado' : 'aberto'}${res.moved ? ` · ${res.moved} apto(s) redistribuído(s)` : ''}.`);
        close(); load();
      } catch (e) { fail(e); }
    };
  }

  function mealCard(m, date) {
    const serv = m.restaurants.filter((r) => r.serves || r.pax);
    const total = serv.reduce((s, r) => s + r.pax, 0);
    const checked = serv.reduce((s, r) => s + r.checked_pax, 0);
    const link = canSee('distribuicao') ? `#/distribuicao?date=${date}&meal=${m.meal}` : canSee('servico') ? `#/servico?date=${date}&meal=${m.meal}` : canSee('recepcao') ? `#/recepcao?date=${date}` : '';
    return `<div class="card meal-card">
      <div class="top">
        <div class="meal-ico ${m.meal}">${mealIcon(m.meal)}</div>
        <div><div class="title">${MEAL_FULL[m.meal]}</div><div class="hours">${m.start} – ${m.end}</div></div>
        <div class="total"><b>${total}</b><span>pax previstos</span></div>
      </div>
      <div class="split-bar">${serv.map((r) => `<i style="width:${total ? (r.pax / total) * 100 : 0}%;background:${esc(r.color)}" title="${esc(r.name)}"></i>`).join('')}</div>
      <div class="rests">${serv.map((r) => `
        <div class="rest-line">
          <span class="nm">${restDot(r)}${esc(r.name)}${r.full ? ' <span class="badge danger">lotado</span>' : ''}</span>
          <span class="num"><b>${r.pax}</b> <span class="muted small">pax</span></span>
          <span class="pct">${pct(r.pct)} <span title="meta">/ ${pct(r.share)}</span></span>
          <span class="chk" title="marcados">${r.checked_pax ? '✓ ' + r.checked_pax : ''}</span>
        </div>`).join('')}</div>
      <div class="foot">
        ${m.published ? `<span class="badge ok">${icon('check')} Lista publicada</span>` : `<span class="badge warn">Lista às ${publishAt(m)}</span>`}
        <span class="grow" style="flex:1"></span>
        ${checked ? `<span class="muted">${checked} marcados</span>` : ''}
        ${link ? `<a class="btn sm" href="${link}">Abrir</a>` : ''}
      </div>
    </div>`;
  }

  function publishAt(m) {
    const [h, mi] = m.start.split(':').map(Number);
    const t = h * 60 + mi - m.notify_before_min;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  await load();
  timer = setInterval(() => { if (!document.querySelector('.modal-bg')) load().catch(() => {}); }, 60000);
  return () => clearInterval(timer);
}
