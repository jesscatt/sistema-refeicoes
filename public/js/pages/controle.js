import { dt, get, esc, icon, fail, can, state, MEALS, MEAL_LABEL, weekday, download, today } from '../ui.js';
import { readParams, syncParams } from './common.js';

// Previsto x realizado (somente consulta): previsto = distribuição; realizado = registros dos restaurantes.
export async function render(el) {
  const st = readParams({ month: today().slice(0, 7), restaurant_id: String(state.meta.restaurants[0].id) });
  let d;

  async function load() {
    syncParams(st, ['month', 'restaurant_id']);
    d = await get(`/api/control?month=${st.month}&restaurant_id=${st.restaurant_id}`);
    draw();
  }

  function draw() {
    const rest = state.meta.restaurants.find((r) => r.id === Number(d.restaurant_id || st.restaurant_id));
    const meals = MEALS.filter((m) => rest[`share_${m}`] > 0 || d.rows.some((r) => r.meal === m));
    const [y, mo] = st.month.split('-').map(Number);
    const ndays = new Date(y, mo, 0).getDate();
    const days = Array.from({ length: ndays }, (_, i) => `${st.month}-${String(i + 1).padStart(2, '0')}`);
    const zero = { forecast_adults: 0, forecast_children: 0, checked_adults: 0, checked_children: 0, fora_lista: 0 };
    const get1 = (date, meal) => d.rows.find((r) => r.date === date && r.meal === meal) || zero;
    const tot = Object.fromEntries(meals.map((m) => [m, { pa: 0, pc: 0, ra: 0, rc: 0, sem: 0 }]));
    for (const r of d.rows) if (tot[r.meal]) {
      const t = tot[r.meal];
      t.pa += r.forecast_adults; t.pc += r.forecast_children; t.ra += r.checked_adults; t.rc += r.checked_children;
      if (r.forecast_adults + r.forecast_children > 0 && r.checked_adults + r.checked_children === 0 && r.date < today()) t.sem++;
    }
    const diff = (real, prev) => { const x = real - prev; return `<span class="${x > 0 ? 'diff-neg' : x < 0 ? 'diff-pos' : 'muted'}">${x > 0 ? '+' : ''}${x}</span>`; };
    const semTotal = Object.values(tot).reduce((s, t) => s + t.sem, 0);
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Previsto x realizado</h1><p><b>Previsto</b>: pessoas previstas na distribuição. <b>Realizado</b>: pessoas registradas pelos restaurantes (lista e fora da lista), apurado automaticamente e sem edição manual.</p></div>
        <input type="month" class="input sm" id="month" value="${esc(st.month)}" style="width:auto">
        <select class="input sm" id="rest" style="width:auto">${state.meta.restaurants.map((r) => `<option value="${r.id}" ${r.id === rest.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        ${can('admin', 'supervisor') ? `<button class="btn" id="csv">${icon('download')} Relatório diário</button>` : ''}
      </div>
      ${d.closed ? `<div class="banner info">${icon('lock')}<span>Mês fechado pela supervisão em ${esc(dt(d.closed.closed_at))}${d.closed.closed_by_name ? ' por ' + esc(d.closed.closed_by_name) : ''}.</span></div>` : ''}
      ${semTotal ? `<div class="banner warn">${icon('alert')}<span><b>${semTotal} refeição(ões)</b> com previsão e sem nenhum registro do restaurante neste mês. Sem registro, a refeição não entra no faturamento.</span></div>` : ''}
      <div class="card"><div class="table-wrap" style="max-height:72vh"><table class="t ctl">
        <thead>
          <tr><th rowspan="2">Dia</th>${meals.map((m) => `<th class="grp" colspan="5">${MEAL_LABEL[m]}</th>`).join('')}</tr>
          <tr>${meals.map(() => '<th class="n gs">Adultos previstos</th><th class="n">Crianças previstas</th><th class="n">Adultos realizados</th><th class="n">Crianças realizadas</th><th class="n">Diferença</th>').join('')}</tr>
        </thead>
        <tbody>${days.map((date) => {
          const wd = weekday(date);
          const wdA = wd.toUpperCase();
          return `<tr class="${wd === 'sáb' || wd === 'dom' ? 'weekend' : ''}"><td><b>${date.slice(8)}</b> <span class="muted small">${wdA}</span></td>
          ${meals.map((m) => {
            const r = get1(date, m);
            const prev = r.forecast_adults + r.forecast_children, real = r.checked_adults + r.checked_children;
            const none = prev > 0 && real === 0 && date < today();
            const z = (v) => (v ? v : '<span class="muted">0</span>');
            return `<td class="n gs">${z(r.forecast_adults)}</td><td class="n">${z(r.forecast_children)}</td>
              <td class="n" ${none ? 'style="background:var(--mustard-l)" title="sem registro do restaurante"' : ''}>${z(r.checked_adults)}${r.fora_lista ? `<sup title="${r.fora_lista} apartamento(s) fora da lista" style="color:var(--mustard)">${r.fora_lista}</sup>` : ''}</td>
              <td class="n">${z(r.checked_children)}</td>
              <td class="n">${prev || real ? diff(real, prev) : ''}</td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td>Mês</td>${meals.map((m) => { const t = tot[m]; return `<td class="n gs">${t.pa}</td><td class="n">${t.pc}</td><td class="n">${t.ra}</td><td class="n">${t.rc}</td><td class="n">${diff(t.ra + t.rc, t.pa + t.pc)}</td>`; }).join('')}</tr></tfoot>
      </table></div></div>
      <p class="muted small">O número sobrescrito no realizado indica apartamentos atendidos fora da lista. Células em amarelo: refeição prevista sem nenhum registro.</p>`;
    el.querySelector('#month').addEventListener('change', (e) => { if (e.target.value) { st.month = e.target.value; load().catch(fail); } });
    el.querySelector('#rest').addEventListener('change', (e) => { st.restaurant_id = e.target.value; load().catch(fail); });
    el.querySelector('#csv')?.addEventListener('click', () => download('/api/reports/daily.csv?month=' + st.month));
  }

  await load();
}
