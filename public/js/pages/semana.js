import { get, esc, icon, fail, state, can, MEAL_LABEL, money, addDays, today, weekday, download, restDot } from '../ui.js';
import { readParams, syncParams } from './common.js';

// Controle da divisão por semana: pax (adultos/crianças) e valores por restaurante, para conferir o pagamento.
const monday = (iso) => { const map = { dom: 6, seg: 0, ter: 1, qua: 2, qui: 3, sex: 4, 'sáb': 5 }; return addDays(iso, -map[weekday(iso)]); };
const br = (iso) => iso.split('-').reverse().join('/');
const nf = (v) => (Number(v) || 0).toLocaleString('pt-BR');

export async function render(el) {
  const st = readParams({ from: monday(today()), to: '', restaurant_id: '' });
  if (!st.to) st.to = addDays(st.from, 6);
  let w;

  async function load() {
    syncParams(st, ['from', 'to', 'restaurant_id']);
    w = await get(`/api/control/week?from=${st.from}&to=${st.to}&restaurant_id=${st.restaurant_id}`);
    draw();
  }

  const diff = (v, money_) => {
    const x = Math.round(v * 100) / 100;
    if (!x) return '<span class="muted">0</span>';
    const t = money_ ? money(Math.abs(x)) : nf(Math.abs(x));
    return `<span class="${x > 0 ? 'diff-neg' : 'diff-pos'}" title="${x > 0 ? 'acima do previsto' : 'abaixo do previsto'}">${x > 0 ? '+' : '−'}${t}</span>`;
  };

  function draw() {
    const noPrice = w.restaurants.some((r) => r.meals.some((m) => (m.pag_adt + m.pag_chd) && !m.price_adult && !m.price_child));
    const pending = w.total.sem_real;
    const days = w.days;
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Apuração semanal</h1><p>Total de pessoas (adultos e crianças) e valor a pagar por restaurante no período. Base do pagamento: o <b>realizado</b>, ou seja, as pessoas registradas pelos restaurantes (lista e fora da lista), calculado automaticamente. A <b>previsão</b> vem da distribuição.</p></div>
      </div>
      <div class="row" style="margin-bottom:16px">
        <button class="btn sm ghost" id="prev" title="Semana anterior">‹</button>
        <input type="date" class="input sm" id="from" value="${esc(w.from)}" style="width:auto"><span class="muted">até</span>
        <input type="date" class="input sm" id="to" value="${esc(w.to)}" style="width:auto">
        <button class="btn sm ghost" id="next" title="Próxima semana">›</button>
        <button class="btn sm" id="thisweek">Esta semana</button>
        ${can('restaurante') ? '' : `<select class="input sm" id="rest" style="width:auto"><option value="">Todos os restaurantes</option>${state.meta.restaurants.map((r) => `<option value="${r.id}" ${String(r.id) === String(st.restaurant_id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`}
        <div class="grow"></div>
        <button class="btn" id="xlsx">${icon('download')} Exportar Excel</button>
      </div>
      ${noPrice ? `<div class="banner warn">${icon('info')}<span>Há refeições sem valor cadastrado, então o R$ fica zerado. ${can('admin', 'supervisor') ? 'Cadastre em <a href="#/faturamento">Faturamento → Valores</a>.' : 'Peça à supervisão para cadastrar os valores.'}</span></div>` : ''}
      ${pending ? `<div class="banner warn">${icon('alert')}<span><b>${pending} refeição(ões)</b> previstas no período sem nenhum registro do restaurante. Sem registro, a refeição não entra no valor a pagar.</span></div>` : ''}

      <div class="grid" style="grid-template-columns:repeat(${Math.min(Math.max(w.restaurants.length, 1), 3)}, minmax(0,1fr));margin-bottom:16px">
        ${w.restaurants.map((r) => { const t = r.total; return `
          <div class="card stat" style="border-top-color:${esc(r.restaurant.color)}">
            <div class="k" style="color:${esc(r.restaurant.color)}">${esc(r.restaurant.name)}</div>
            <div class="v">${nf(t.pag_adt + t.pag_chd)}<small>pessoas realizados</small></div>
            <div class="row small" style="gap:14px;margin-top:2px"><span><b>${nf(t.pag_adt)}</b> adultos</span><span><b>${nf(t.pag_chd)}</b> crianças</span></div>
            <div class="row" style="margin-top:10px;align-items:baseline"><b style="font-size:20px">${money(t.valor)}</b><span class="small muted">previsto ${money(t.valor_prev)} · ${diff(t.valor - t.valor_prev, true)}</span></div>
          </div>`; }).join('')}
      </div>
      ${w.restaurants.length > 1 ? `<div class="card pad" style="margin-bottom:16px"><div class="row"><b class="grow">Total da semana</b>
        <span><b>${nf(w.total.pag_adt + w.total.pag_chd)}</b> pax (${nf(w.total.pag_adt)} adultos · ${nf(w.total.pag_chd)} crianças)</span>
        <span class="muted">·</span><span>previsto ${nf(w.total.prev_adt + w.total.prev_chd)} pessoas · ${diff(w.total.pag_adt + w.total.pag_chd - w.total.prev_adt - w.total.prev_chd)}</span>
        <span class="muted">·</span><b style="font-size:18px">${money(w.total.valor)}</b><span class="small muted">(previsto ${money(w.total.valor_prev)} · ${diff(w.total.valor - w.total.valor_prev, true)})</span></div></div>` : ''}

      ${w.restaurants.map((r) => `
        <div class="card" style="margin-bottom:16px">
          <div class="card-head" style="border-top:4px solid ${esc(r.restaurant.color)};border-radius:var(--radius) var(--radius) 0 0"><h3 class="grow">${restDot(r.restaurant)} ${esc(r.restaurant.name)}</h3></div>
          <div class="table-wrap"><table class="t">
            <thead><tr><th>Refeição</th><th class="n">Previsto</th><th class="n">Realizado adultos</th><th class="n">Realizado crianças</th><th class="n">Realizado total</th><th class="n">Diferença (pessoas)</th><th class="n">Valor a pagar</th><th class="n">Dif. R$</th></tr></thead>
            <tbody>${r.meals.map((m) => `<tr>
              <td><b>${MEAL_LABEL[m.meal]}</b><div class="small muted">${money(m.price_adult)} adultos · ${money(m.price_child)} crianças${m.sem_real ? ` · <span style="color:#8a5a07">${m.sem_real} sem registro</span>` : ''}</div></td>
              <td class="n">${nf(m.prev_adt + m.prev_chd)}<div class="small muted">${nf(m.prev_adt)} / ${nf(m.prev_chd)}</div></td>
              <td class="n">${nf(m.pag_adt)}</td><td class="n">${nf(m.pag_chd)}</td><td class="n"><b>${nf(m.pag_adt + m.pag_chd)}</b></td>
              <td class="n">${diff(m.pag_adt + m.pag_chd - m.prev_adt - m.prev_chd)}</td>
              <td class="n"><b>${money(m.valor)}</b></td><td class="n">${diff(m.valor - m.valor_prev, true)}</td></tr>`).join('') || '<tr><td colspan="10"><div class="empty">Sem refeições no período.</div></td></tr>'}</tbody>
            <tfoot><tr><td>Total</td><td class="n">${nf(r.total.prev_adt + r.total.prev_chd)}</td>
              <td class="n">${nf(r.total.pag_adt)}</td><td class="n">${nf(r.total.pag_chd)}</td><td class="n">${nf(r.total.pag_adt + r.total.pag_chd)}</td><td class="n">${diff(r.total.pag_adt + r.total.pag_chd - r.total.prev_adt - r.total.prev_chd)}</td>
              <td class="n">${money(r.total.valor)}</td><td class="n">${diff(r.total.valor - r.total.valor_prev, true)}</td></tr></tfoot>
          </table></div>
          <details style="border-top:1px solid var(--line)"><summary style="padding:10px 18px;cursor:pointer;font-weight:600;font-size:14px">Ver por dia</summary>
            <div class="table-wrap"><table class="t">
              <thead><tr><th>Refeição</th>${days.map((d) => `<th class="n">${weekday(d)} ${br(d).slice(0, 5)}</th>`).join('')}<th class="n">Total</th></tr></thead>
              <tbody>${r.meals.map((m) => `<tr><td><b>${MEAL_LABEL[m.meal]}</b></td>${days.map((d) => { const x = m.days[d]; return `<td class="n">${x ? `${nf(x.pag_adt + x.pag_chd)}<div class="small muted">${nf(x.pag_chd)} crianças${x.sem_real ? ' · sem registro' : ''}</div>` : '<span class="muted">—</span>'}</td>`; }).join('')}
                <td class="n"><b>${nf(m.pag_adt + m.pag_chd)}</b><div class="small muted">${nf(m.pag_chd)} crianças</div></td></tr>`).join('')}</tbody>
            </table></div>
            <p class="small muted" style="padding:0 18px 12px">Pax realizados por dia (registros dos restaurantes). “sem registro” = refeição prevista sem nenhum registro.</p>
          </details>
        </div>`).join('')}`;
    const go = (from, to) => { st.from = from; st.to = to; load().catch(fail); };
    const len = Math.max(0, (new Date(w.to) - new Date(w.from)) / 86400000);
    el.querySelector('#prev').onclick = () => go(addDays(w.from, -(len + 1)), addDays(w.to, -(len + 1)));
    el.querySelector('#next').onclick = () => go(addDays(w.from, len + 1), addDays(w.to, len + 1));
    el.querySelector('#thisweek').onclick = () => { const m = monday(today()); go(m, addDays(m, 6)); };
    el.querySelector('#from').addEventListener('change', (e) => { if (e.target.value) go(e.target.value, e.target.value > st.to ? addDays(e.target.value, 6) : st.to); });
    el.querySelector('#to').addEventListener('change', (e) => { if (e.target.value) go(st.from, e.target.value); });
    el.querySelector('#rest')?.addEventListener('change', (e) => { st.restaurant_id = e.target.value; load().catch(fail); });
    el.querySelector('#xlsx').onclick = () => download(`/api/control/week.xlsx?from=${w.from}&to=${w.to}&restaurant_id=${st.restaurant_id}`);
  }

  await load();
}
