import { get, post, put, del, api, esc, icon, fail, toast, state, can, hasRole, download, MEALS, MEAL_LABEL, confirmBox, modal, today } from '../ui.js';
import { readParams, syncParams } from './common.js';

// Controle de faturamento (supervisão / setor de refeições) e controle do restaurante (administrador do restaurante).
// Substitui as planilhas "Controle semanal dos restaurantes (projeção do mês)" e "Controle de divisão" de cada restaurante.
const MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const mesLabel = (m) => `${MES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const brl = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = (v) => (Number(v) || 0).toLocaleString('pt-BR');
const br = (iso) => iso.split('-').reverse().join('/');
const MEAL_ROW = { cafe: 'Café', almoco: 'Almoço', janta: 'Jantar' };
const SRC = { sistema: 'registros do sistema', planilha: 'planilha importada', sem_dados: 'sem registros' };

export async function render(el) {
  const office = can('admin', 'supervisor', 'refeicao');
  const restAdmin = !office && hasRole(['rest_admin']);
  const priceEdit = can('admin', 'supervisor');
  const rests = state.meta.restaurants;
  const myRest = state.me.restaurant ? state.me.restaurant.id : null;
  const st = readParams({ month: '', tab: office ? 'consolidado' : 'r' + myRest });
  if (!office) st.tab = 'r' + myRest;
  let info;
  try { info = await get('/api/finance/months'); } catch (e) { el.innerHTML = `<div class="banner danger">${icon('alert')}<span>${esc(e.message)}</span></div>`; return; }
  if (!st.month || !info.months.includes(st.month)) st.month = info.months.includes(today().slice(0, 7)) ? today().slice(0, 7) : info.months[0];

  const tabs = office
    ? [['consolidado', 'Controle de faturamento'], ...rests.map((r) => ['r' + r.id, r.name]), ['precos', 'Preços e configurações'], ['historico', 'Importar histórico']]
    : [['r' + myRest, 'Controle do restaurante']];

  async function load() {
    syncParams(st, ['month', 'tab']);
    const isRest = st.tab.startsWith('r');
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>${office ? 'Controle de faturamento' : 'Controle do restaurante'}</h1>
          <p>${office ? 'Os três restaurantes no mês, controle de cada restaurante por semana, extras, vouchers e outros pontos. Os números provêm dos registros de atendimento dos restaurantes; meses anteriores vêm das planilhas importadas.' : 'Quantidades e valores do seu restaurante por semana e no mês. Os números vêm das marcações feitas no sistema.'}</p></div>
        ${st.tab === 'precos' || st.tab === 'historico' ? '' : `<select class="input sm" id="month" style="width:auto">${info.months.map((m) => `<option value="${m}" ${m === st.month ? 'selected' : ''}>${mesLabel(m)}</option>`).join('')}</select>
        <button class="btn" id="x1">${icon('download')} Exportar mês</button>
        <button class="btn" id="x2">${icon('download')} Exportar todos os meses</button>`}
      </div>
      ${tabs.length > 1 ? `<div class="seg" id="tabs" style="margin-bottom:16px;flex-wrap:wrap">${tabs.map(([k, l]) => `<button data-t="${k}" class="${st.tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>` : ''}
      <div id="body"><div class="empty">Carregando…</div></div>`;
    el.querySelectorAll('#tabs [data-t]').forEach((b) => b.addEventListener('click', () => { st.tab = b.dataset.t; load().catch(fail); }));
    el.querySelector('#month')?.addEventListener('change', (e) => { st.month = e.target.value; load().catch(fail); });
    const body = el.querySelector('#body');
    if (st.tab === 'consolidado') {
      el.querySelector('#x1').onclick = () => download('/api/finance/consolidated.xlsx?month=' + st.month);
      el.querySelector('#x2').onclick = () => download('/api/finance/consolidated.xlsx');
      return drawConsolidated(body, await get('/api/finance/consolidated?month=' + st.month));
    }
    if (isRest) {
      const id = st.tab.slice(1);
      el.querySelector('#x1').onclick = () => download(`/api/finance/restaurant.xlsx?month=${st.month}&restaurant_id=${id}`);
      el.querySelector('#x2').onclick = () => download(`/api/finance/restaurant.xlsx?restaurant_id=${id}`);
      return drawRestaurant(body, await get(`/api/finance/restaurant?month=${st.month}&restaurant_id=${id}`));
    }
    if (st.tab === 'precos') return drawPrices(body);
    if (st.tab === 'historico') return drawImport(body);
  }

  // ---------- Controle de faturamento (consolidado) ----------
  function drawConsolidated(body, c) {
    const diff = c.total - c.projection_total;
    const line = (R, l) => `<tr>
      <td>${MEAL_ROW[l.meal]}${l.price_note ? `<div class="muted small">preços: ${esc(l.price_note)}</div>` : ''}</td>
      <td class="n">${n0(l.adults)}</td><td class="n small muted">${brl(l.price_adult)}</td><td class="n">${brl(l.value_adults)}</td>
      <td class="n">${n0(l.children)}</td><td class="n small muted">${brl(l.price_child)}</td><td class="n">${brl(l.value_children)}</td>
      <td class="n"><b>${brl(l.value_adults + l.value_children)}</b></td></tr>`;
    body.innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="k">Total do mês</div><div class="v" style="font-size:24px">${brl(c.total)}</div></div>
        <div class="card stat"><div class="k">Total -${c.deduction_pct}%</div><div class="v" style="font-size:24px">${brl(c.total_net)}</div></div>
        <div class="card stat"><div class="k">Projeção do mês</div><div class="v" style="font-size:24px">${brl(c.projection_total)}</div></div>
        <div class="card stat"><div class="k">Realizado − projeção</div><div class="v" style="font-size:24px;color:${diff > 0 ? 'var(--danger)' : 'var(--ok)'}">${diff > 0 ? '+' : ''}${brl(diff)}</div></div>
      </div>
      ${c.restaurants.map((R) => `<div class="card" style="margin-bottom:14px">
        <div class="card-head"><span class="dot" style="background:${esc(R.restaurant.color)};width:12px;height:12px;border-radius:50%;display:inline-block"></span><h3 class="grow">${esc(R.restaurant.name)}</h3>
          <span class="badge ${R.source === 'sistema' ? 'ok' : R.source === 'planilha' ? 'info' : ''}">${SRC[R.source]}</span>
          <b style="font-size:17px">${brl(R.totals.total)}</b>
          <button class="btn sm" data-go="r${R.restaurant.id}">Ver semanas</button></div>
        <div class="table-wrap"><table class="t fin">
          <thead><tr><th>Realizado</th><th class="n">Adultos</th><th class="n">R$</th><th class="n">Total ADT</th><th class="n">Crianças</th><th class="n">R$</th><th class="n">Total CHD</th><th class="n">Total</th></tr></thead>
          <tbody>${R.realizado.map((l) => line(R, l)).join('')}
            ${R.extras.map((e) => `<tr class="sub"><td colspan="7">Extra · ${e.meal ? MEAL_ROW[e.meal] + ` · ${n0(e.adults)} adultos${e.children ? ` + ${n0(e.children)} crianças` : ''}` : esc(e.item)}</td><td class="n">${brl(e.value)}</td></tr>`).join('')}
            ${R.vouchers.map((v) => `<tr class="sub"><td colspan="7">Vouchers · ${v.meal ? MEAL_ROW[v.meal] + ` · ${n0(v.count)} voucher(s), ${n0(v.adults + v.children)} pessoas` : esc(v.item)}</td><td class="n">${brl(v.value)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td>Total</td><td class="n">${n0(R.realizado.reduce((s, l) => s + l.adults, 0))}</td><td></td><td class="n">${brl(R.totals.adults)}</td><td class="n">${n0(R.realizado.reduce((s, l) => s + l.children, 0))}</td><td></td><td class="n">${brl(R.totals.children)}</td><td class="n">${brl(R.totals.total)}</td></tr></tfoot>
        </table></div>
        <details style="padding:0 16px 12px"><summary class="small" style="cursor:pointer;padding:8px 0">Projeção do mês (${SRC[R.projecao.source]}): <b>${brl(R.projecao.total)}</b></summary>
          <div class="table-wrap"><table class="t fin"><thead><tr><th>Projeção</th><th class="n">Adultos</th><th class="n">R$</th><th class="n">Total ADT</th><th class="n">Crianças</th><th class="n">R$</th><th class="n">Total CHD</th><th class="n">Total</th></tr></thead>
          <tbody>${R.projecao.lines.map((l) => line(R, l)).join('')}</tbody></table></div></details>
      </div>`).join('')}
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">${icon('coin')}<h3 class="grow">Outros pontos e lançamentos</h3><span class="muted small">Di Paolo, Botequim, Day-use/Barril, eventos, ajustes</span><b>${brl(c.others_total)}</b></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Ponto / descrição</th><th>Item</th><th class="n">Valor unitário</th><th class="n">Quant.</th><th class="n">Total</th><th>Origem</th><th></th></tr></thead><tbody>
          ${c.others.map((o) => `<tr><td><b>${esc(o.outlet)}</b></td><td>${esc(o.item || '')}</td><td class="n">${o.unit_price != null ? brl(o.unit_price) : ''}</td><td class="n">${o.qty ?? ''}</td><td class="n">${brl(o.value)}</td>
            <td class="small muted">${o.source === 'manual' ? 'lançado' : 'planilha'}</td><td>${can('admin', 'supervisor', 'refeicao') ? `<button class="btn sm ghost" data-delentry="${o.id}">${icon('x')}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7"><div class="empty">Nenhum lançamento neste mês.</div></td></tr>'}
        </tbody></table></div>
        <form id="newentry" class="row" style="padding:12px 16px;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line)">
          <input class="input sm" name="outlet" placeholder="Ponto (ex.: Di Paolo)" style="width:180px" list="outlets">
          <datalist id="outlets"><option>Di Paolo</option><option>Botequim</option><option>Day-use + almoço (Barril)</option><option>Evento</option><option>Ajuste</option></datalist>
          <input class="input sm" name="item" placeholder="Item (ex.: Almoço)" style="width:150px">
          <input class="input sm" name="unit_price" type="number" step="0.01" placeholder="Valor unit." style="width:110px">
          <input class="input sm" name="qty" type="number" step="1" placeholder="Quant." style="width:90px">
          <span class="muted small">ou</span>
          <input class="input sm" name="value" type="number" step="0.01" placeholder="Valor total" style="width:120px">
          <button class="btn sm primary">${icon('plus')} Lançar</button>
        </form>
      </div>
      <div class="card pad fin-total">
        <div><span>Restaurantes</span><b>${brl(c.restaurants.reduce((s, R) => s + R.totals.total, 0))}</b></div>
        <div><span>Outros pontos</span><b>${brl(c.others_total)}</b></div>
        <div><span>Total</span><b>${brl(c.total)}</b></div>
        <div class="hl"><span>Total -${c.deduction_pct}%</span><b>${brl(c.total_net)}</b></div>
      </div>`;
    body.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { st.tab = b.dataset.go; load().catch(fail); }));
    body.querySelectorAll('[data-delentry]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmBox('Remover este lançamento?', 'Remover', true))) return;
      try { await del('/api/finance/entries/' + b.dataset.delentry); load(); } catch (e) { fail(e); }
    }));
    body.querySelector('#newentry').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await post('/api/finance/entries', { ...f, month: st.month, kind: 'outro' }); toast('Lançamento incluído.'); load(); } catch (err) { fail(err); }
    });
  }

  // ---------- Controle do restaurante (semanas) ----------
  function drawRestaurant(body, d) {
    const hoje = today();
    const pq = (q) => (q ? n0(q) : '<span class="muted">0</span>');
    body.innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="k">Total do mês</div><div class="v" style="font-size:24px">${brl(d.totals.total)}</div><div class="muted small">${esc(d.restaurant.name)} · ${mesLabel(d.month)}</div></div>
        <div class="card stat"><div class="k">Adultos</div><div class="v" style="font-size:22px">${brl(d.totals.adults)}</div><div class="muted small">${n0(d.month_lines.reduce((s, l) => s + l.adults, 0))} pessoas</div></div>
        <div class="card stat"><div class="k">Crianças (meia)</div><div class="v" style="font-size:22px">${brl(d.totals.children)}</div><div class="muted small">${n0(d.month_lines.reduce((s, l) => s + l.children, 0))} pessoas</div></div>
        <div class="card stat"><div class="k">Extras${d.restaurant.accepts_voucher ? ' e vouchers' : ''}</div><div class="v" style="font-size:20px">${brl(d.totals.extras + d.totals.vouchers)}</div></div>
      </div>
      <p class="muted small" style="margin:-4px 0 12px">Fonte: ${SRC[d.source]}. Semanas de quarta a terça dentro do mês. Criança paga meia.${d.source === 'planilha' ? ' O total do mês é o número faturado na planilha; as semanas mostram o lançamento diário.' : ''}</p>
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">${icon('coin')}<h3 class="grow">Valor de cada semana</h3></div>
        <div class="table-wrap"><table class="t fin"><thead><tr><th>Semana</th>${d.meals.map((m) => `<th class="n">${MEAL_LABEL[m]} adultos</th><th class="n">${MEAL_LABEL[m]} crianças</th>`).join('')}<th class="n">Valor</th></tr></thead>
          <tbody>${d.weeks.map((w) => `<tr${w.from <= hoje && hoje <= w.to ? ' style="background:var(--primary-l, #e6f4f7)"' : ''}><td><b>Semana ${w.n}</b> <span class="muted small">${br(w.from).slice(0, 5)} a ${br(w.to).slice(0, 5)}</span></td>
            ${w.lines.map((l) => `<td class="n">${pq(l.adults)}</td><td class="n">${pq(l.children)}</td>`).join('')}<td class="n"><b>${brl(w.value)}</b></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Mês (semanas)</td>${d.meals.map((m) => `<td class="n">${n0(d.weeks.reduce((s, w) => s + w.lines.find((l) => l.meal === m).adults, 0))}</td><td class="n">${n0(d.weeks.reduce((s, w) => s + w.lines.find((l) => l.meal === m).children, 0))}</td>`).join('')}<td class="n">${brl(d.weeks.reduce((s, w) => s + w.value, 0))}</td></tr></tfoot>
        </table></div>
      </div>
      ${d.weeks.map((w) => `<details class="card" style="margin-bottom:10px" ${w.from <= hoje && hoje <= w.to ? 'open' : ''}>
        <summary class="card-head" style="cursor:pointer;list-style:none"><h3 class="grow">Semana ${w.n} · ${br(w.from).slice(0, 5)} a ${br(w.to).slice(0, 5)}</h3><b>${brl(w.value)}</b></summary>
        <div class="table-wrap"><table class="t"><thead><tr><th>Data</th><th>Refeição</th><th class="n">Previsão</th><th class="n">Adultos</th><th class="n">Crianças</th><th class="n">Extras</th>${d.restaurant.accepts_voucher ? '<th class="n">Vouchers</th>' : ''}</tr></thead><tbody>
          ${w.days.map((day) => day.meals.map((x, i) => `<tr${i === 0 ? ' style="border-top:2px solid var(--line)"' : ''}>
            <td>${i === 0 ? `<b>${br(day.date).slice(0, 5)}</b> <span class="muted small">${day.weekday}</span>` : ''}</td><td>${MEAL_ROW[x.meal]}</td>
            <td class="n">${x.forecast ? n0(x.forecast) : '<span class="muted">—</span>'}</td>
            <td class="n">${x.source ? n0(x.adults) : '<span class="muted">—</span>'}</td><td class="n">${x.source ? n0(x.children) : '<span class="muted">—</span>'}</td>
            <td class="n">${x.extra_adults + x.extra_children ? n0(x.extra_adults + x.extra_children) : ''}</td>
            ${d.restaurant.accepts_voucher ? `<td class="n">${x.vouchers ? n0(x.vouchers) : ''}</td>` : ''}</tr>`).join('')).join('')}
        </tbody></table></div>
        <div class="table-wrap"><table class="t fin"><thead><tr><th>Semana ${w.n}</th><th class="n">Adultos</th><th class="n">R$</th><th class="n">Total</th><th class="n">Crianças</th><th class="n">R$</th><th class="n">Total</th></tr></thead><tbody>
          ${w.lines.map((l) => `<tr><td>${MEAL_ROW[l.meal]}</td><td class="n">${n0(l.adults)}</td><td class="n small muted">${brl(l.price_adult)}</td><td class="n">${brl(l.value_adults)}</td><td class="n">${n0(l.children)}</td><td class="n small muted">${brl(l.price_child)}</td><td class="n">${brl(l.value_children)}</td></tr>`).join('')}
        </tbody></table></div>
      </details>`).join('')}
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-head"><h3 class="grow">Total do mês</h3><b>${brl(d.totals.adults + d.totals.children)}</b></div>
          <div class="table-wrap"><table class="t fin"><thead><tr><th>Refeição</th><th class="n">Adultos</th><th class="n">Total</th><th class="n">Crianças</th><th class="n">Total</th></tr></thead><tbody>
            ${d.month_lines.map((l) => `<tr><td>${MEAL_ROW[l.meal]}<div class="muted small" style="white-space:nowrap">${brl(l.price_adult)} / ${brl(l.price_child)}</div>${l.price_note ? `<div class="muted small">${esc(l.price_note)}</div>` : ''}</td><td class="n">${n0(l.adults)}</td><td class="n">${brl(l.value_adults)}</td><td class="n">${n0(l.children)}</td><td class="n">${brl(l.value_children)}</td></tr>`).join('')}
          </tbody></table></div></div>
        <div class="card"><div class="card-head"><h3 class="grow">Extras${d.restaurant.accepts_voucher ? ' e vouchers' : ''}</h3><b>${brl(d.totals.extras + d.totals.vouchers)}</b></div>
          <div class="table-wrap"><table class="t fin"><tbody>
            ${d.extras.map((e) => `<tr><td>Extra · ${e.meal ? MEAL_ROW[e.meal] : esc(e.item)}</td><td class="n">${e.meal ? `${n0(e.adults)} adultos${e.children ? ` + ${n0(e.children)} crianças` : ''}` : (e.adults ? n0(e.adults) : '')}</td><td class="n small muted">${e.price_adult != null ? brl(e.price_adult) : ''}</td><td class="n">${brl(e.value)}</td></tr>`).join('')}
            ${d.vouchers.map((v) => `<tr><td>Vouchers · ${v.meal ? MEAL_ROW[v.meal] : esc(v.item)}</td><td class="n">${n0(v.count)} voucher(s)</td><td class="n small muted">${n0(v.adults + v.children)} pessoas</td><td class="n">${brl(v.value)}</td></tr>`).join('')}
            ${!d.extras.length && !d.vouchers.length ? '<tr><td><div class="empty">Nenhum extra no mês.</div></td></tr>' : ''}
          </tbody></table></div>
          ${d.restaurant.accepts_voucher ? '<div style="padding:10px 16px"><button class="btn sm" id="vlist">Consultar vouchers registrados</button></div>' : ''}</div>
      </div>`;
    body.querySelector('#vlist')?.addEventListener('click', async () => {
      try {
        const rows = await get(`/api/vouchers?month=${st.month}&restaurant_id=${d.restaurant.id}`);
        modal({ wide: true, title: `Vouchers · ${esc(d.restaurant.name)} · ${mesLabel(st.month)}`, body: rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Data</th><th>Refeição</th><th class="n">Quantidade</th><th>Observação</th><th>Registrado por</th></tr></thead><tbody>${rows.map((v) => `<tr><td>${br(v.date)}</td><td>${MEAL_LABEL[v.meal]}</td><td class="n"><b>${v.adults + v.children}</b></td><td>${esc(v.note || '')}</td><td class="small">${esc(v.user_name || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhum voucher no mês.</div>', foot: '<button class="btn" data-close>Fechar</button>' });
      } catch (e) { fail(e); }
    });
  }

  // ---------- Preços por mês e configurações ----------
  async function drawPrices(body) {
    const month = st.pmonth || today().slice(0, 7);
    const p = await get('/api/finance/prices?month=' + month);
    const dis = priceEdit ? '' : 'disabled';
    const inp = (name, v) => `<input class="input sm" type="number" step="0.01" min="0" name="${name}" value="${v ?? 0}" style="width:90px" ${dis}>`;
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h3 class="grow">Preços por refeição</h3>
          <label class="row small" style="gap:6px">Vigentes a partir de <input type="month" class="input sm" id="pmonth" value="${month}" style="width:auto"></label>
          ${priceEdit ? '<button class="btn sm primary" id="savep">Salvar preços</button>' : ''}</div>
        <p class="muted small" style="padding:0 16px">Cada restaurante tem o seu valor. Criança paga meia (em branco = metade do adulto). Extra = valor cobrado nos extras. Ao salvar, os preços valem a partir do mês escolhido; meses anteriores continuam com os preços antigos.</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>Restaurante</th><th>Refeição</th><th>Adulto</th><th>Criança</th><th>Extra adulto</th><th>Extra criança</th><th class="small">Vigência atual</th></tr></thead><tbody>
          ${p.current.map((r) => MEALS.filter((m) => r.meals[m].price_adult > 0 || (rests.find((x) => x.id === r.id) || {})[`share_${m}`] > 0).map((m, i) => `<tr data-r="${r.id}" data-m="${m}">
            <td>${i === 0 ? `<b>${esc(r.name)}</b>` : ''}</td><td>${MEAL_LABEL[m]}</td>
            <td>${inp('price_adult', r.meals[m].price_adult)}</td><td>${inp('price_child', r.meals[m].price_child)}</td>
            <td>${inp('extra_adult', r.meals[m].extra_adult)}</td><td>${inp('extra_child', r.meals[m].extra_child)}</td>
            <td class="small muted">${r.meals[m].valid_from && r.meals[m].valid_from !== '2000-01' ? 'desde ' + mesLabel(r.meals[m].valid_from) : 'padrão'}</td></tr>`).join('')).join('')}
        </tbody></table></div>
        <div class="row" style="padding:12px 16px;gap:16px;flex-wrap:wrap">${p.current.map((r) => `<label class="row small" style="gap:6px"><input type="checkbox" data-voucher="${r.id}" ${r.accepts_voucher ? 'checked' : ''} ${dis}> ${esc(r.name)} recebe voucher</label>`).join('')}</div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h3 class="grow">Configurações do controle</h3>${priceEdit ? '<button class="btn sm primary" id="saves">Salvar</button>' : ''}</div>
        <div class="row" style="padding:14px 16px;gap:16px;flex-wrap:wrap;align-items:flex-end">
          <label class="f" style="max-width:220px">Desconto no total (%)<input class="input" type="number" step="0.01" min="0" max="100" id="ded" value="${info.deduction_pct}" ${dis}></label>
          <label class="f" style="max-width:220px">Semana começa na<select class="input" id="wks" ${dis}>${['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'].map((d2, i) => `<option value="${i}" ${i === info.week_start ? 'selected' : ''}>${d2}</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="card"><div class="card-head"><h3 class="grow">Histórico de preços</h3></div>
        <div class="table-wrap" style="max-height:340px"><table class="t"><thead><tr><th>Vigência</th><th>Restaurante</th><th>Refeição</th><th class="n">Adulto</th><th class="n">Criança</th><th class="n">Extra</th></tr></thead><tbody>
          ${p.history.map((h) => `<tr><td>${h.valid_from === '2000-01' ? 'padrão' : mesLabel(h.valid_from)}</td><td>${esc(h.restaurant_name)}</td><td>${MEAL_LABEL[h.meal]}</td><td class="n">${brl(h.price_adult)}</td><td class="n">${brl(h.price_child)}</td><td class="n">${h.extra_adult ? brl(h.extra_adult) : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    body.querySelector('#pmonth').addEventListener('change', (e) => { if (e.target.value) { st.pmonth = e.target.value; drawPrices(body).catch(fail); } });
    body.querySelector('#savep')?.addEventListener('click', async () => {
      const prices = [...body.querySelectorAll('tr[data-r]')].map((tr) => ({ restaurant_id: tr.dataset.r, meal: tr.dataset.m, ...Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.name, i.value])) }));
      const vouchers = [...body.querySelectorAll('[data-voucher]')].map((c) => ({ restaurant_id: c.dataset.voucher, accepts: c.checked }));
      if (!(await confirmBox(`Salvar estes preços valendo a partir de ${mesLabel(body.querySelector('#pmonth').value)}?`, 'Salvar'))) return;
      try { await put('/api/finance/prices', { valid_from: body.querySelector('#pmonth').value, prices, vouchers }); toast('Preços salvos.'); const m = await get('/api/meta'); state.meta = m; drawPrices(body); } catch (e) { fail(e); }
    });
    body.querySelector('#saves')?.addEventListener('click', async () => {
      try { await put('/api/finance/settings', { deduction_pct: body.querySelector('#ded').value, week_start: body.querySelector('#wks').value }); info = await get('/api/finance/months'); toast('Configurações salvas.'); } catch (e) { fail(e); }
    });
  }

  // ---------- Importação do histórico ----------
  function drawImport(body) {
    body.innerHTML = `
      <div class="card pad" style="margin-bottom:14px">
        <h3 style="margin-top:0">Importar as planilhas antigas</h3>
        <p class="muted">Envie a planilha <b>Controle semanal dos restaurantes (projeção do mês)</b> e/ou a <b>Controle de divisão</b> de cada restaurante (todas as abas/meses de uma vez). Os meses importados aparecem no controle de faturamento e no controle de cada restaurante. Reenviar a mesma planilha substitui o que veio dela antes.</p>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <input type="file" id="file" accept=".xlsx,.xls" class="input" style="max-width:420px">
          <label class="row small" style="gap:6px">Restaurante (só para a planilha de divisão)<select class="input sm" id="irest" style="width:auto"><option value="">pelo nome do arquivo</option>${rests.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label>
          <button class="btn primary" id="prev">${icon('upload')} Conferir</button>
        </div>
      </div>
      <div id="res"></div>`;
    let buf = null, fname = '';
    const send = async (commit) => api('POST', '/api/finance/import', buf, { headers: { 'X-Filename': encodeURIComponent(fname), 'X-Restaurant': body.querySelector('#irest').value, 'X-Commit': commit ? '1' : '0' } });
    body.querySelector('#prev').onclick = async () => {
      const f = body.querySelector('#file').files[0];
      if (!f) { toast('Escolha a planilha.', 'err'); return; }
      buf = await f.arrayBuffer(); fname = f.name;
      try { showPreview(await send(false)); } catch (e) { fail(e); }
    };
    function showPreview(p) {
      const res = body.querySelector('#res');
      res.innerHTML = `<div class="card">
        <div class="card-head"><h3 class="grow">${p.type === 'controle' ? 'Controle de faturamento' : `Controle de divisão · ${esc(p.restaurant || '')}`} · ${p.months.length} mês(es)</h3>${p.saved ? '<span class="badge ok">importado</span>' : '<button class="btn primary" id="go">Importar</button>'}</div>
        ${p.warnings.length ? `<div class="banner warn" style="margin:0 16px 10px">${icon('alert')}<span>${p.warnings.map(esc).join('<br>')}</span></div>` : ''}
        <div class="table-wrap"><table class="t"><thead><tr><th>Mês</th><th>Aba</th>${p.type === 'controle' ? '<th class="n">Pessoas (realizado)</th><th class="n">Pessoas (projeção)</th><th class="n">Lançamentos</th><th class="n">Total</th>' : '<th class="n">Dias</th><th class="n">Pax</th><th class="n">Extras</th>'}</tr></thead><tbody>
          ${p.months.map((m) => `<tr><td><b>${mesLabel(m.month)}</b></td><td class="small muted">${esc(m.sheet)}</td>${p.type === 'controle' ? `<td class="n">${n0(m.realizado_pax)}</td><td class="n">${n0(m.projecao_pax)}</td><td class="n">${m.entries}</td><td class="n"><b>${brl(m.total)}</b></td>` : `<td class="n">${m.days}</td><td class="n">${n0(m.pax)}</td><td class="n">${m.extras}</td>`}</tr>`).join('')}
        </tbody></table></div></div>`;
      res.querySelector('#go')?.addEventListener('click', async () => {
        try { const r = await send(true); showPreview(r); info = await get('/api/finance/months'); toast(`Histórico importado: ${r.saved.months.length} mês(es).`); } catch (e) { fail(e); }
      });
    }
  }

  await load();
}
