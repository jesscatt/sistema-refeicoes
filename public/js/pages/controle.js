import { get, put, esc, icon, fail, toast, can, state, MEALS, MEAL_LABEL, weekday, download, today } from '../ui.js';
import { readParams, syncParams } from './common.js';

export async function render(el) {
  const st = readParams({ month: today().slice(0, 7), restaurant_id: state.me.restaurant ? String(state.me.restaurant.id) : String(state.meta.restaurants[0].id) });
  let d;

  async function load() {
    syncParams(st, ['month', 'restaurant_id']);
    d = await get(`/api/control?month=${st.month}&restaurant_id=${st.restaurant_id}`);
    draw();
  }

  function draw() {
    const rest = state.meta.restaurants.find((r) => r.id === Number(d.restaurant_id || st.restaurant_id));
    const meals = MEALS.filter((m) => rest[`share_${m}`] > 0 || d.rows.some((r) => r.meal === m));
    const editable = can('admin', 'refeicao', 'restaurante') && !d.closed;
    const [y, mo] = st.month.split('-').map(Number);
    const ndays = new Date(y, mo, 0).getDate();
    const days = Array.from({ length: ndays }, (_, i) => `${st.month}-${String(i + 1).padStart(2, '0')}`);
    const get1 = (date, meal) => d.rows.find((r) => r.date === date && r.meal === meal) || { forecast_adults: 0, forecast_children: 0, checked_adults: 0, checked_children: 0, real_adults: null, real_children: null };
    const tot = Object.fromEntries(meals.map((m) => [m, { f: 0, c: 0, ra: 0, rc: 0, hasReal: 0 }]));
    for (const r of d.rows) if (tot[r.meal]) {
      const t = tot[r.meal];
      t.f += r.forecast_adults + r.forecast_children; t.c += r.checked_adults + r.checked_children;
      if (r.real_adults !== null || r.real_children !== null) { t.ra += r.real_adults || 0; t.rc += r.real_children || 0; t.hasReal++; }
    }
    const diff = (real, prev) => { const x = real - prev; return `<span class="${x > 0 ? 'diff-pos' : x < 0 ? 'diff-neg' : ''}">${x > 0 ? '+' : ''}${x}</span>`; };
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Previsto x realizado</h1><p>Uma planilha só: a <b>previsão</b> vem da distribuição, o <b>marcado</b> vem da marcação no restaurante e o <b>real</b> é o número que o restaurante informa. Somas do mês no rodapé.</p></div>
        <input type="month" class="input sm" id="month" value="${esc(st.month)}" style="width:auto">
        ${can('restaurante') ? '' : `<select class="input sm" id="rest" style="width:auto">${state.meta.restaurants.map((r) => `<option value="${r.id}" ${r.id === rest.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`}
        ${can('admin', 'supervisor') ? `<button class="btn" id="csv">${icon('download')} Relatório diário (todos)</button>` : ''}
      </div>
      ${d.closed ? `<div class="banner info">${icon('lock')}<span>Mês fechado pela supervisão em ${esc(d.closed.closed_at)}${d.closed.closed_by_name ? ' por ' + esc(d.closed.closed_by_name) : ''}. Os valores não podem mais ser alterados.</span></div>` : ''}
      ${editable ? `<p class="muted small">Digite o número real de adultos e crianças servidos. Salva sozinho ao sair do campo. Em branco = ainda não informado (o faturamento usa o marcado no sistema).</p>` : ''}
      <div class="card"><div class="table-wrap" style="max-height:72vh"><table class="t ctl">
        <thead>
          <tr><th rowspan="2">Dia</th>${meals.map((m) => `<th class="grp" colspan="5">${MEAL_LABEL[m]}</th>`).join('')}</tr>
          <tr>${meals.map(() => '<th class="n gs">Prev.</th><th class="n">Marc.</th><th class="n">Real adt</th><th class="n">Real chd</th><th class="n">Dif.</th>').join('')}</tr>
        </thead>
        <tbody>${days.map((date) => {
          const wd = weekday(date);
          return `<tr class="${wd === 'sáb' || wd === 'dom' ? 'weekend' : ''}"><td><b>${date.slice(8)}</b> <span class="muted small">${wd}</span></td>
          ${meals.map((m) => {
            const r = get1(date, m);
            const prev = r.forecast_adults + r.forecast_children, chk = r.checked_adults + r.checked_children;
            const hasReal = r.real_adults !== null || r.real_children !== null;
            const inp = (k, v, ph) => editable ? `<input inputmode="numeric" data-date="${date}" data-meal="${m}" data-k="${k}" value="${v ?? ''}" placeholder="${ph}">` : (v ?? '<span class="muted">—</span>');
            return `<td class="n gs" title="${r.forecast_adults} adt + ${r.forecast_children} chd">${prev || '<span class="muted">0</span>'}</td>
              <td class="n" title="${r.checked_adults} adt + ${r.checked_children} chd">${chk || '<span class="muted">0</span>'}${r.fora_lista ? `<sup title="fora da lista" style="color:var(--mustard)">${r.fora_lista}</sup>` : ''}</td>
              <td class="n">${inp('real_adults', r.real_adults, r.checked_adults || '')}</td>
              <td class="n">${inp('real_children', r.real_children, r.checked_children || '')}</td>
              <td class="n">${hasReal ? diff((r.real_adults || 0) + (r.real_children || 0), prev) : ''}</td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td>Mês</td>${meals.map((m) => { const t = tot[m]; return `<td class="n gs">${t.f}</td><td class="n">${t.c}</td><td class="n">${t.hasReal ? t.ra : '—'}</td><td class="n">${t.hasReal ? t.rc : '—'}</td><td class="n">${t.hasReal ? diff(t.ra + t.rc, t.f) : ''}</td>`; }).join('')}</tr></tfoot>
      </table></div></div>`;
    el.querySelector('#month').addEventListener('change', (e) => { if (e.target.value) { st.month = e.target.value; load().catch(fail); } });
    el.querySelector('#rest')?.addEventListener('change', (e) => { st.restaurant_id = e.target.value; load().catch(fail); });
    el.querySelector('#csv')?.addEventListener('click', () => download('/api/reports/daily.csv?month=' + st.month));
    el.querySelectorAll('input[data-k]').forEach((inp) => {
      inp.dataset.orig = inp.value;
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      inp.addEventListener('change', async () => {
        const tr = inp.closest('tr');
        const a = tr.querySelector(`input[data-meal="${inp.dataset.meal}"][data-k="real_adults"]`);
        const c = tr.querySelector(`input[data-meal="${inp.dataset.meal}"][data-k="real_children"]`);
        if (a.value !== '' && c.value === '') c.value = '0';
        if (c.value !== '' && a.value === '') a.value = '0';
        try {
          await put('/api/control', { date: inp.dataset.date, meal: inp.dataset.meal, restaurant_id: Number(st.restaurant_id), real_adults: a.value, real_children: c.value });
          [a, c].forEach((x) => { x.classList.add('saved'); setTimeout(() => x.classList.remove('saved'), 1200); });
          const row = d.rows.find((r) => r.date === inp.dataset.date && r.meal === inp.dataset.meal);
          const v = (x) => (x.value === '' ? null : Number(x.value));
          if (row) { row.real_adults = v(a); row.real_children = v(c); }
          else d.rows.push({ date: inp.dataset.date, meal: inp.dataset.meal, restaurant_id: Number(st.restaurant_id), forecast_adults: 0, forecast_children: 0, checked_adults: 0, checked_children: 0, real_adults: v(a), real_children: v(c) });
        } catch (e) { fail(e); inp.value = inp.dataset.orig; }
      });
    });
  }

  await load();
}
