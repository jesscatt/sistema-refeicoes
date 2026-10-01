import { get, post, esc, icon, MEAL_FULL, toast, fail, state, can, boardTag, paxTxt, dayLabel, pct, confirmBox, download, roomHtml, modal, addDays } from '../ui.js';
import { dateBar, bindDateBar, readParams, syncParams } from './common.js';

export async function render(el) {
  const st = readParams({ date: '', meal: '' });
  const edit = can('admin', 'refeicao');
  let d;

  async function load() {
    d = await get(`/api/distribution?date=${st.date}&meal=${st.meal}`);
    st.date = d.date; st.meal = d.meal;
    syncParams(st, ['date', 'meal']);
    draw();
  }

  function draw() {
    const serving = d.summary.filter((r) => r.serves);
    const total = d.summary.reduce((s, r) => s + r.pax, 0);
    const shareTot = serving.reduce((s, r) => s + r.share, 0) || 1;
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Distribuição de hóspedes</h1><p>${MEAL_FULL[d.meal]} · ${esc(dayLabel(d.date))} · ${total} pax em ${d.rows.length} quartos</p></div>
        ${dateBar({ date: d.date, meal: d.meal })}
      </div>
      <div class="row" style="margin-bottom:16px">
        ${d.published ? `<span class="badge ok">${icon('check')} Publicada ${esc(d.published.published_at.slice(11, 16))}${d.published.auto ? ' (automática)' : d.published.published_by_name ? ' por ' + esc(d.published.published_by_name) : ''}</span>` : '<span class="badge warn">Lista ainda não publicada</span>'}
        <div class="grow"></div>
        ${edit ? `<button class="btn" id="rebal">${icon('refresh')} Redistribuir</button>
          <button class="btn primary" id="pub">${icon('send')} ${d.published ? 'Republicar e avisar' : 'Publicar e avisar restaurantes'}</button>` : ''}
        <button class="btn" id="xlsx">${icon('sheet')} Planilha de divisão</button>
        <button class="btn" id="csv">${icon('download')} CSV</button>
        <button class="btn" id="print">${icon('print')} Imprimir listas</button>
      </div>
      ${edit ? `<p class="muted small" style="margin-top:-6px">“Redistribuir” refaz a divisão só de quem não foi travado (${icon('lock').replace('<svg', '<svg style="width:13px;height:13px;vertical-align:-2px"')}) nem marcado. Mover alguém manualmente leva o grupo inteiro e trava naquele restaurante.</p>` : ''}
      <div class="dist-cols" style="grid-template-columns:repeat(${Math.max(serving.length, 1)}, minmax(0,1fr))">
        ${serving.map((r) => col(r, total, shareTot, serving)).join('') || '<div class="card empty">Nenhum restaurante serve esta refeição.</div>'}
      </div>`;
    bindDateBar(el, st, () => load().catch(fail));
    el.querySelector('#csv').onclick = () => download(`/api/distribution/export.csv?date=${d.date}&meal=${d.meal}`);
    el.querySelector('#xlsx').onclick = () => {
      const { el: m, close } = modal({
        title: 'Planilha de divisão (.xlsx)',
        body: `<p class="muted" style="margin-top:0">Mesmo formato da planilha de hoje: uma coluna por refeição, restaurante e dia, com o pax de cada quarto e os totais.</p>
          <div class="form-grid"><label class="f">De<input class="input" type="date" name="from" value="${esc(d.date)}"></label>
          <label class="f">Até<input class="input" type="date" name="to" value="${esc(addDays(d.date, 4))}"></label></div>`,
        foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Baixar</button>',
      });
      m.querySelector('[data-ok]').onclick = () => { download(`/api/distribution/export.xlsx?from=${m.querySelector('[name=from]').value}&to=${m.querySelector('[name=to]').value}`); close(); };
    };
    el.querySelector('#print').onclick = printAll;
    el.querySelector('#rebal')?.addEventListener('click', async () => {
      if (!(await confirmBox('Refazer a divisão de quem não está travado nem marcado? Os cartões já entregues podem mudar.', 'Redistribuir'))) return;
      try { const r = await post('/api/distribution/rebalance', { date: d.date, meal: d.meal }); toast(`${r.moved} reserva(s) mudaram de restaurante.`); load(); } catch (e) { fail(e); }
    });
    el.querySelector('#pub')?.addEventListener('click', async () => {
      try { const r = await post('/api/distribution/publish', { date: d.date, meal: d.meal }); toast(`Lista publicada: ${r.total} pax. Restaurantes avisados.`); load(); } catch (e) { fail(e); }
    });
    el.querySelectorAll('select[data-asg]').forEach((s) => s.addEventListener('change', async () => {
      try { await post('/api/distribution/move', { assignment_id: Number(s.dataset.asg), restaurant_id: Number(s.value) }); toast('Movido e travado (o grupo inteiro foi junto).'); load(); } catch (e) { fail(e); load(); }
    }));
    el.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/api/distribution/unlock', { assignment_id: Number(b.dataset.unlock) }); load(); } catch (e) { fail(e); }
    }));
  }

  function col(r, total, shareTot, serving) {
    const rows = d.rows.filter((x) => x.restaurant_id === r.id);
    const target = r.share / shareTot;
    // agrupa os quartos da mesma reserva (grupo)
    const groups = [];
    const byNum = new Map();
    for (const g of rows) {
      if (!byNum.has(g.reservation_number)) { const o = { num: g.reservation_number, name: g.guest_name, rooms: [] }; byNum.set(g.reservation_number, o); groups.push(o); }
      byNum.get(g.reservation_number).rooms.push(g);
    }
    groups.sort((a, b) => b.rooms.length - a.rooms.length || String(a.name).localeCompare(String(b.name)));
    const line = (g, inGroup) => `
        <div class="guest ${inGroup ? 'in-group' : ''}">
          <span class="room">${roomHtml(g.room)}</span>
          <span style="min-width:0"><div class="nm">${inGroup ? `${paxTxt(g.adults, g.children)}` : esc(g.guest_name)}</div><div class="sub">${inGroup ? boardTag(g.board) : `${paxTxt(g.adults, g.children)} · ${boardTag(g.board)}`}${g.origin === 'planilha' ? ' · da planilha' : g.origin !== 'auto' && g.origin !== 'manual' ? ` · via ${esc(g.origin)}` : ''}
            ${g.att_status ? ` · <b style="color:var(--ok)">✓ ${g.att_restaurant_id === r.id ? 'veio' : 'foi a outro'}</b>` : ''}</div></span>
          <span class="row" style="gap:4px">${!inGroup ? actions(g, r, serving) : ''}</span>
        </div>`;
    const body = groups.map((G) => {
      if (G.rooms.length === 1) return line(G.rooms[0], false);
      const pax = G.rooms.reduce((s, x) => s + x.adults + x.children, 0);
      const head = G.rooms[0];
      return `<details class="grp">
        <summary class="guest grp-head">
          <span class="room"><span class="badge info">${G.rooms.length} qtos</span></span>
          <span style="min-width:0"><div class="nm"><b>${esc(G.name)}</b></div><div class="sub">grupo ${esc(G.num)} · ${pax} pax${G.rooms.some((x) => x.att_status) ? ` · <b style="color:var(--ok)">${G.rooms.filter((x) => x.att_status).length} marcados</b>` : ''}</div></span>
          <span class="row" style="gap:4px">${actions(head, r, serving)}</span>
        </summary>
        ${G.rooms.map((x) => line(x, true)).join('')}
      </details>`;
    }).join('');
    return `<div class="card dist-col" style="--c:${esc(r.color)}">
      <div class="card-head"><div class="grow"><h3>${esc(r.name)}</h3><div class="meta">${r.pax} pax (${r.adults} adt · ${r.children} chd) · ${rows.length} quartos · ${groups.length} reservas${r.cap ? ` · capacidade ${r.cap}` : ''}</div></div>
        <div style="text-align:right"><b style="font-size:22px">${pct(r.pct)}</b><div class="meta">meta ${pct(target)}</div></div></div>
      <div class="target"><i style="width:${Math.min(100, r.pct * 100)}%"></i><b style="left:${target * 100}%"></b></div>
      ${r.full ? '<div class="banner danger" style="margin:0 14px 10px">Capacidade atingida</div>' : ''}
      <div class="list-scroll">${body || '<div class="empty">Ninguém aqui.</div>'}</div>
    </div>`;
  }

  function actions(g, r, serving) {
    return `${g.locked ? (edit ? `<button class="icon-btn" title="Destravar o grupo" data-unlock="${g.assignment_id}" style="color:var(--primary)">${icon('lock')}</button>` : `<span title="Travado" style="color:var(--primary)">${icon('lock')}</span>`) : ''}
      ${edit && !g.att_status ? `<select data-asg="${g.assignment_id}" aria-label="Mover o grupo" title="Mover (o grupo inteiro vai junto)">${serving.map((o) => `<option value="${o.id}" ${o.id === r.id ? 'selected' : ''}>${esc(o.code)}</option>`).join('')}</select>` : ''}`;
  }

  function printAll() {
    const area = document.getElementById('print-area');
    area.innerHTML = d.summary.filter((r) => r.serves).map((r) => {
      const rows = d.rows.filter((x) => x.restaurant_id === r.id);
      return `<div class="plist"><h2>${esc(r.name)} — ${MEAL_FULL[d.meal]} ${esc(dayLabel(d.date))}</h2><p>${rows.length} reservas · ${r.pax} pax</p>
        <table><thead><tr><th></th><th>Quarto</th><th>Nome</th><th>Adt</th><th>Chd</th><th>Pensão</th></tr></thead><tbody>
        ${rows.map((g) => `<tr><td><span class="box"></span></td><td><b>${roomHtml(g.room)}</b></td><td>${esc(g.guest_name)}</td><td>${g.adults}</td><td>${g.children}</td><td>${esc(g.board)}</td></tr>`).join('')}
        </tbody></table></div>`;
    }).join('');
    window.print();
  }

  await load();
}
