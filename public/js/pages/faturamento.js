import { get, post, put, esc, icon, fail, toast, can, MEAL_LABEL, money, today, download, confirmBox, modal, restDot } from '../ui.js';
import { readParams, syncParams } from './common.js';

export async function render(el) {
  const st = readParams({ month: today().slice(0, 7) });
  const boss = can('admin', 'supervisor');

  async function load() {
    syncParams(st, ['month']);
    const b = await get('/api/billing?month=' + st.month);
    const byRest = {};
    for (const l of b.lines) {
      const k = l.restaurant.id;
      byRest[k] = byRest[k] || { r: l.restaurant, value: 0, pax: 0 };
      byRest[k].value += l.value; byRest[k].pax += l.billed_adults + l.billed_children;
    }
    const maxV = Math.max(1, ...Object.values(byRest).map((x) => x.value));
    const noPrice = b.lines.some((l) => (l.billed_adults || l.billed_children) && !l.price_adult && !l.price_child);
    const pending = b.lines.reduce((s, l) => s + l.days_without_real, 0);
    const sum = (k) => b.lines.reduce((s, l) => s + l[k], 0);
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Faturamento</h1><p>Quantidades por restaurante, refeição e número de pessoas (adultos e crianças). Base de cálculo: o <b>realizado</b>, isto é, as pessoas registradas pelos restaurantes (lista e fora da lista), calculado automaticamente.</p></div>
        <input type="month" class="input sm" id="month" value="${esc(st.month)}" style="width:auto">
        ${boss ? `<button class="btn" id="prices">${icon('coin')} Valores</button><button class="btn" id="csv">${icon('download')} Relatório oficial</button>` : ''}
        ${boss && !b.closed ? `<button class="btn primary" id="close">${icon('lock')} Fechar mês</button>` : ''}
        ${can('admin') && b.closed ? `<button class="btn danger" id="reopen">Reabrir mês</button>` : ''}
      </div>
      ${b.closed ? `<div class="banner info">${icon('lock')}<span>Mês fechado em ${esc(b.closed.closed_at)}${b.closed.closed_by_name ? ' por ' + esc(b.closed.closed_by_name) : ''}. Os números abaixo são os do fechamento${b.live && b.live.total !== b.total ? ` (hoje o sistema calcularia ${money(b.live.total)})` : ''}.</span></div>` : ''}
      ${!b.closed && pending ? `<div class="banner warn">${icon('alert')}<span>${pending} refeição(ões) previstas sem nenhum registro dos restaurantes; elas não entram no faturamento.</span></div>` : ''}
      ${noPrice ? `<div class="banner warn">${icon('info')}<span>Há refeições sem valor cadastrado. ${boss ? 'Clique em “Valores” para informar.' : 'Peça à supervisão para cadastrar os valores.'}</span></div>` : ''}
      <div class="stats">
        <div class="card stat"><div class="k">Total do mês</div><div class="v">${money(b.total)}</div></div>
        <div class="card stat"><div class="k">Pax realizados</div><div class="v">${sum('billed_adults') + sum('billed_children')}<small>${sum('billed_adults')} adultos · ${sum('billed_children')} crianças</small></div></div>
        <div class="card stat"><div class="k">Previsto</div><div class="v">${sum('forecast_adults') + sum('forecast_children')}<small>pessoas</small></div></div>
        <div class="card stat"><div class="k">Consumo à parte</div><div class="v">${sum('walkin_adults') + sum('walkin_children')}<small>pessoas (fora da conta)</small></div></div>
      </div>
      <div class="card pad" style="margin-bottom:16px"><div class="bars">
        ${Object.values(byRest).map((x) => `<div class="b"><span class="row" style="gap:8px">${restDot(x.r)}<b>${esc(x.r.name)}</b></span><div class="track"><i style="width:${(x.value / maxV) * 100}%;background:${esc(x.r.color)}"></i></div><span class="num"><b>${money(x.value)}</b></span></div>`).join('')}
      </div></div>
      <div class="card"><div class="table-wrap"><table class="t">
        <thead><tr><th>Restaurante</th><th>Refeição</th><th class="n">Previsto</th><th class="n">Realizado adultos</th><th class="n">Realizado crianças</th><th class="n">Diferença (pessoas)</th><th class="n">Valor adt</th><th class="n">Valor chd</th><th class="n">Total</th></tr></thead>
        <tbody>${b.lines.map((l) => `<tr>
          <td><span class="row" style="gap:8px">${restDot(l.restaurant)}${esc(l.restaurant.name)}</span></td><td>${MEAL_LABEL[l.meal]}</td>
          <td class="n">${l.forecast_adults + l.forecast_children}</td>
          <td class="n">${l.billed_adults}</td><td class="n">${l.billed_children}</td><td class="n">${l.billed_adults + l.billed_children - l.forecast_adults - l.forecast_children}</td>
          <td class="n">${money(l.price_adult)}</td><td class="n">${money(l.price_child)}</td><td class="n"><b>${money(l.value)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2">Total</td><td class="n">${sum('forecast_adults') + sum('forecast_children')}</td>
          <td class="n">${sum('billed_adults')}</td><td class="n">${sum('billed_children')}</td><td class="n">${sum('billed_adults') + sum('billed_children') - sum('forecast_adults') - sum('forecast_children')}</td><td></td><td></td><td class="n">${money(b.total)}</td></tr></tfoot>
      </table></div></div>`;
    el.querySelector('#month').addEventListener('change', (e) => { if (e.target.value) { st.month = e.target.value; load().catch(fail); } });
    el.querySelector('#csv')?.addEventListener('click', () => download('/api/billing/export.csv?month=' + st.month));
    el.querySelector('#prices')?.addEventListener('click', () => { location.hash = '#/financeiro?tab=precos'; });
    el.querySelector('#close')?.addEventListener('click', async () => {
      if (!(await confirmBox(`Fechar o faturamento de ${st.month.split('-').reverse().join('/')}? Os números ficam congelados e os restaurantes não podem mais alterar o controle deste mês.`, 'Fechar mês'))) return;
      try { await post('/api/billing/close', { month: st.month }); toast('Mês fechado.'); load(); } catch (e) { fail(e); }
    });
    el.querySelector('#reopen')?.addEventListener('click', async () => {
      if (!(await confirmBox('Reabrir o mês? O fechamento atual será descartado.', 'Reabrir', true))) return;
      try { await post('/api/billing/reopen', { month: st.month }); toast('Mês reaberto.'); load(); } catch (e) { fail(e); }
    });
  }

  async function pricesModal() {
    const prices = await get('/api/prices');
    const { el: m, close } = modal({
      title: 'Valores por refeição',
      body: `<p class="muted" style="margin-top:0">Valor pago ao restaurante por pessoa (adulto e criança).</p>
        <table class="t"><thead><tr><th>Restaurante</th><th>Refeição</th><th>Adulto (R$)</th><th>Criança (R$)</th></tr></thead><tbody>
        ${prices.map((p) => `<tr data-r="${p.restaurant_id}" data-m="${p.meal}"><td>${esc(p.name)}</td><td>${MEAL_LABEL[p.meal]}</td>
          <td><input class="input sm" type="number" step="0.01" min="0" name="a" value="${p.price_adult}"></td>
          <td><input class="input sm" type="number" step="0.01" min="0" name="c" value="${p.price_child}"></td></tr>`).join('')}</tbody></table>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Salvar</button>',
    });
    m.querySelector('[data-ok]').onclick = async () => {
      const list = [...m.querySelectorAll('tr[data-r]')].map((tr) => ({ restaurant_id: Number(tr.dataset.r), meal: tr.dataset.m, price_adult: tr.querySelector('[name=a]').value, price_child: tr.querySelector('[name=c]').value }));
      try { await put('/api/prices', { prices: list }); toast('Valores salvos.'); close(); load(); } catch (e) { fail(e); }
    };
  }

  await load();
}
