import { get, put, api, esc, icon, fail, toast, confirmBox, dt } from '../ui.js';

// Gestão do painel da TV: envio dos relatórios do Silbeck (PDF), metas das unidades e vendedores
const MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const mesLabel = (m) => `${MES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const brl = (v) => (v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%');
const dmy = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const fmt = (v) => (v == null ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export async function render(el) {
  let d;
  async function load() { d = await get('/api/tv/admin'); draw(); }

  function draw() {
    const link = `${location.origin}/tv.html?key=${encodeURIComponent(d.key)}`;
    el.innerHTML = `
      <div class="page-head">
        <div class="grow"><h1>Painel da TV</h1><p>Faturamento e ocupação do mês atual e dos três meses seguintes, metas das unidades e ranking de vendas. Os dados vêm dos relatórios do Silbeck enviados em PDF.</p></div>
        <a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener">${icon('home')} Abrir painel da TV</a>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head">${icon('upload')}<h3 class="grow">Envio dos relatórios do Silbeck</h3></div>
        <div style="padding:0 18px 16px">
          <p class="muted small" style="margin-top:0">Envie em PDF a <b>Previsão de Faturamento/Ocupação</b> (um arquivo por mês: atual e três seguintes) e a <b>Lista de Walk-ins/Reservas por Funcionário</b>. É possível selecionar vários arquivos de uma vez; cada novo envio substitui o anterior do mesmo mês ou do relatório de vendas.</p>
          <div class="row" style="gap:10px"><input type="file" id="pdfs" accept="application/pdf,.pdf" multiple class="input" style="max-width:520px"><button class="btn primary" id="send">${icon('upload')} Enviar relatórios</button></div>
          <div id="res" style="margin-top:12px"></div>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><h3 class="grow">Faturamento e ocupação (Silbeck)</h3></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>Mês</th><th class="n">Faturamento previsto</th><th class="n">Ocupação (apartamentos)</th><th class="n">Ocupação (leitos)</th><th>Relatório</th></tr></thead><tbody>
            ${d.months.map((m) => `<tr><td><b>${mesLabel(m.month)}</b></td><td class="n">${brl(m.revenue)}</td><td class="n">${pct(m.apts_pct)}</td><td class="n">${pct(m.beds_pct)}</td><td class="small muted">${m.generated_at ? 'gerado em ' + esc(dt(m.generated_at)) : '<span style="color:var(--danger)">não enviado</span>'}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3 class="grow">Ranking de vendas</h3><span class="muted small">${d.sales.period_from ? `Período: ${dmy(d.sales.period_from)} a ${dmy(d.sales.period_to)}` : 'Relatório de vendas não enviado'}</span></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>Posição</th><th>Vendedor</th><th class="n">Room nights</th><th class="n">Valor</th></tr></thead><tbody>
            ${d.sales.ranking.map((r, i) => `<tr><td>${i + 1}º</td><td><b>${esc(r.name)}</b>${r.full_names.length ? `<div class="small muted">${r.full_names.map(esc).join(', ')}</div>` : '<div class="small muted">não consta no relatório</div>'}</td><td class="n">${r.room_nights || 0}</td><td class="n">${brl(r.value)}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="row" style="padding:12px 16px;gap:8px;border-top:1px solid var(--line)">
            <label class="f grow" style="margin:0">Vendedores do cliente final (separados por vírgula)<input class="input" id="sellers" value="${esc(d.sellers)}"></label>
            <button class="btn" id="save-sellers" style="align-self:flex-end">Salvar</button>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 class="grow">Valores e metas por unidade</h3><span class="muted small">Resort em branco = faturamento previsto do Silbeck</span></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Mês</th>${d.unit_rows[0].units.map((u) => `<th>${esc(u.label)} · realizado</th><th>${esc(u.label)} · meta</th>`).join('')}<th>Meta de vendas</th><th></th></tr></thead><tbody>
          ${d.unit_rows.map((row) => `<tr data-month="${row.month}"><td><b>${mesLabel(row.month)}</b></td>
            ${row.units.map((u) => `<td><input class="input sm" data-unit="${u.unit}" data-k="value" value="${fmt(u.value)}" placeholder="${u.unit === 'resort' ? 'Silbeck' : '0,00'}" style="width:120px"></td><td><input class="input sm" data-unit="${u.unit}" data-k="goal" value="${fmt(u.goal)}" placeholder="0,00" style="width:120px"></td>`).join('')}
            <td><input class="input sm" data-k="sales_goal" value="${fmt(row.sales_goal)}" placeholder="0,00" style="width:120px"></td>
            <td><button class="btn sm primary" data-save="${row.month}">Salvar</button></td></tr>`).join('')}
        </tbody></table></div>
      </div>

      <div class="card pad">
        <h3 style="margin-top:0">Link do painel para a TV</h3>
        <p class="muted small">Abra este endereço no navegador da TV. O painel não exige login e se atualiza sozinho a cada minuto. Ao gerar um novo link, o anterior deixa de funcionar.</p>
        <div class="row" style="gap:8px"><input class="input" id="link" value="${esc(link)}" readonly style="max-width:720px"><button class="btn" id="copy">Copiar link</button><button class="btn danger" id="newkey">Gerar novo link</button></div>
      </div>`;

    el.querySelector('#send').onclick = async () => {
      const files = [...el.querySelector('#pdfs').files];
      if (!files.length) { toast('Selecione os arquivos PDF.', 'err'); return; }
      const out = [];
      for (const f of files) {
        try {
          const r = await api('POST', '/api/tv/upload', await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } });
          out.push(r.type === 'previsao' ? `<div class="banner ok" style="margin:6px 0">${icon('check')}<span><b>${esc(f.name)}</b>: previsão de ${mesLabel(r.month)} · ${brl(r.revenue)} · ocupação ${pct(r.apts_pct)}</span></div>`
            : `<div class="banner ok" style="margin:6px 0">${icon('check')}<span><b>${esc(f.name)}</b>: vendas de ${dmy(r.period_from)} a ${dmy(r.period_to)} · ${r.sellers} vendedores · total ${brl(r.total)}</span></div>`);
        } catch (e) { out.push(`<div class="banner danger" style="margin:6px 0">${icon('alert')}<span><b>${esc(f.name)}</b>: ${esc(e.message)}</span></div>`); }
      }
      const html = out.join('');
      await load();
      el.querySelector('#res').innerHTML = html;
    };
    el.querySelector('#save-sellers').onclick = async () => {
      try { await put('/api/tv/settings', { sellers: el.querySelector('#sellers').value }); toast('Vendedores salvos.'); load(); } catch (e) { fail(e); }
    };
    el.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      const units = d.unit_rows[0].units.map((u) => ({ unit: u.unit, value: tr.querySelector(`[data-unit="${u.unit}"][data-k="value"]`).value, goal: tr.querySelector(`[data-unit="${u.unit}"][data-k="goal"]`).value }));
      try { await put('/api/tv/units', { month: tr.dataset.month, units, sales_goal: tr.querySelector('[data-k="sales_goal"]').value }); toast(`Valores de ${mesLabel(tr.dataset.month)} salvos.`); load(); } catch (e) { fail(e); }
    }));
    el.querySelector('#copy').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Link copiado.'), () => toast('Não foi possível copiar.', 'err'));
    el.querySelector('#newkey').onclick = async () => {
      if (!(await confirmBox('Deseja gerar um novo link? O link atual deixará de funcionar na TV.', 'Gerar novo link', true))) return;
      try { await put('/api/tv/settings', { new_key: true }); toast('Novo link gerado.'); load(); } catch (e) { fail(e); }
    };
  }

  await load();
}
