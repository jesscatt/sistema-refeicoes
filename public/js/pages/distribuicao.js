import { get, post, esc, icon, MEAL_FULL, toast, fail, state, can, boardTag, paxTxt, dayLabel, pct, confirmBox, download } from '../ui.js';
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
        <div class="grow"><h1>Distribuição</h1><p>${MEAL_FULL[d.meal]} · ${esc(dayLabel(d.date))} · ${total} pax em ${d.rows.length} reservas</p></div>
        ${dateBar({ date: d.date, meal: d.meal })}
      </div>
      <div class="row" style="margin-bottom:16px">
        ${d.published ? `<span class="badge ok">${icon('check')} Publicada ${esc(d.published.published_at.slice(11, 16))}${d.published.auto ? ' (automática)' : d.published.published_by_name ? ' por ' + esc(d.published.published_by_name) : ''}</span>` : '<span class="badge warn">Lista ainda não publicada</span>'}
        <div class="grow"></div>
        ${edit ? `<button class="btn" id="rebal">${icon('refresh')} Redistribuir</button>
          <button class="btn primary" id="pub">${icon('send')} ${d.published ? 'Republicar e avisar' : 'Publicar e avisar restaurantes'}</button>` : ''}
        <button class="btn" id="csv">${icon('download')} CSV</button>
        <button class="btn" id="print">${icon('print')} Imprimir listas</button>
      </div>
      ${edit ? `<p class="muted small" style="margin-top:-6px">“Redistribuir” refaz a divisão só de quem não foi travado (${icon('lock').replace('<svg', '<svg style="width:13px;height:13px;vertical-align:-2px"')}) nem marcado. Mover alguém manualmente trava o cliente naquele restaurante.</p>` : ''}
      <div class="dist-cols" style="grid-template-columns:repeat(${Math.max(serving.length, 1)}, minmax(0,1fr))">
        ${serving.map((r) => col(r, total, shareTot, serving)).join('') || '<div class="card empty">Nenhum restaurante serve esta refeição.</div>'}
      </div>`;
    bindDateBar(el, st, () => load().catch(fail));
    el.querySelector('#csv').onclick = () => download(`/api/distribution/export.csv?date=${d.date}&meal=${d.meal}`);
    el.querySelector('#print').onclick = printAll;
    el.querySelector('#rebal')?.addEventListener('click', async () => {
      if (!(await confirmBox('Refazer a divisão de quem não está travado nem marcado? Os cartões já entregues podem mudar.', 'Redistribuir'))) return;
      try { const r = await post('/api/distribution/rebalance', { date: d.date, meal: d.meal }); toast(`${r.moved} reserva(s) mudaram de restaurante.`); load(); } catch (e) { fail(e); }
    });
    el.querySelector('#pub')?.addEventListener('click', async () => {
      try { const r = await post('/api/distribution/publish', { date: d.date, meal: d.meal }); toast(`Lista publicada: ${r.total} pax. Restaurantes avisados.`); load(); } catch (e) { fail(e); }
    });
    el.querySelectorAll('select[data-asg]').forEach((s) => s.addEventListener('change', async () => {
      try { await post('/api/distribution/move', { assignment_id: Number(s.dataset.asg), restaurant_id: Number(s.value) }); toast('Cliente movido e travado.'); load(); } catch (e) { fail(e); load(); }
    }));
    el.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/api/distribution/unlock', { assignment_id: Number(b.dataset.unlock) }); load(); } catch (e) { fail(e); }
    }));
  }

  function col(r, total, shareTot, serving) {
    const rows = d.rows.filter((x) => x.restaurant_id === r.id);
    const target = r.share / shareTot;
    return `<div class="card dist-col" style="--c:${esc(r.color)}">
      <div class="card-head"><div class="grow"><h3>${esc(r.name)}</h3><div class="meta">${r.pax} pax (${r.adults} adt · ${r.children} chd) · ${rows.length} reservas${r.cap ? ` · capacidade ${r.cap}` : ''}</div></div>
        <div style="text-align:right"><b style="font-family:var(--serif);font-size:22px">${pct(r.pct)}</b><div class="meta">meta ${pct(target)}</div></div></div>
      <div class="target"><i style="width:${Math.min(100, r.pct * 100)}%"></i><b style="left:${target * 100}%"></b></div>
      ${r.full ? '<div class="banner danger" style="margin:0 14px 10px">Capacidade atingida</div>' : ''}
      <div class="list-scroll">${rows.map((g) => `
        <div class="guest">
          <span class="room">${esc(g.room)}</span>
          <span style="min-width:0"><div class="nm">${esc(g.guest_name)}</div><div class="sub">${paxTxt(g.adults, g.children)} · ${boardTag(g.board)}${g.origin !== 'auto' && g.origin !== 'manual' ? ` · via ${esc(g.origin)}` : ''}
            ${g.att_status ? ` · <b style="color:var(--ok)">✓ ${g.att_restaurant_id === r.id ? 'veio' : 'foi a outro'}</b>` : ''}</div></span>
          <span class="row" style="gap:4px">
            ${g.locked ? (edit ? `<button class="icon-btn" title="Destravar" data-unlock="${g.assignment_id}" style="color:var(--primary)">${icon('lock')}</button>` : `<span title="Travado" style="color:var(--primary)">${icon('lock')}</span>`) : ''}
            ${edit && !g.att_status ? `<select data-asg="${g.assignment_id}" aria-label="Mover">${serving.map((o) => `<option value="${o.id}" ${o.id === r.id ? 'selected' : ''}>${esc(o.code)}</option>`).join('')}</select>` : ''}
          </span>
        </div>`).join('') || '<div class="empty">Ninguém aqui.</div>'}</div>
    </div>`;
  }

  function printAll() {
    const area = document.getElementById('print-area');
    area.innerHTML = d.summary.filter((r) => r.serves).map((r) => {
      const rows = d.rows.filter((x) => x.restaurant_id === r.id);
      return `<div class="plist"><h2>${esc(r.name)} — ${MEAL_FULL[d.meal]} ${esc(dayLabel(d.date))}</h2><p>${rows.length} reservas · ${r.pax} pax</p>
        <table><thead><tr><th></th><th>Quarto</th><th>Nome</th><th>Adt</th><th>Chd</th><th>Pensão</th></tr></thead><tbody>
        ${rows.map((g) => `<tr><td><span class="box"></span></td><td><b>${esc(g.room)}</b></td><td>${esc(g.guest_name)}</td><td>${g.adults}</td><td>${g.children}</td><td>${esc(g.board)}</td></tr>`).join('')}
        </tbody></table></div>`;
    }).join('');
    window.print();
  }

  await load();
}
