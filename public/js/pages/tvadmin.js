import { get, put, post, api, esc, icon, fail, toast, confirmBox, dt, hasRole } from '../ui.js';

// Gestão do painel da TV: envio dos relatórios do Silbeck (PDF), metas das unidades e vendedores
const MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const mesLabel = (m) => `${MES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const brl = (v) => (v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%');
const dmy = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const fmt = (v) => (v == null ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export async function render(el) {
  let d, sb, mi = 0;
  async function load() { [d, sb] = await Promise.all([get('/api/tv/admin'), get('/api/tv/silbeck')]); draw(); }

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

      <div class="card" style="margin-bottom:16px">
        <div class="card-head">${icon('swap')}<h3 class="grow">Integração com a API do Silbeck</h3>
          <span class="badge ${sb.auto ? 'ok' : ''}">${sb.auto ? `Busca automática a cada ${sb.interval_min} min` : 'Busca automática desligada'}</span></div>
        <div style="padding:0 18px 16px">
          <p class="muted small" style="margin-top:0">Com a API, o painel busca sozinho a <b>previsão de faturamento e ocupação</b> dos quatro meses (consulta Ocupação) e as <b>vendas por funcionário</b> do mês, pelas reservas cadastradas no período (consulta Lista de Reservas). O envio de PDFs continua disponível.</p>
          ${hasRole(['admin']) ? `<div class="grid g2" style="gap:10px">
            <label class="f" style="margin:0">Endereço da API<input class="input" id="sb-url" value="${esc(sb.url)}"></label>
            <label class="f" style="margin:0">client_id<input class="input" id="sb-id" value="${esc(sb.client_id || '')}" autocomplete="off"></label>
            <label class="f" style="margin:0">client_secret<input class="input" id="sb-secret" type="password" autocomplete="new-password" placeholder="${sb.has_secret ? '•••••••• (salvo — deixe em branco para manter)' : 'informe o client_secret'}"></label>
            <div class="row" style="gap:12px;align-items:flex-end">
              <label class="row" style="gap:6px;margin:0"><input type="checkbox" id="sb-auto" ${sb.auto ? 'checked' : ''}> Buscar automaticamente a cada</label>
              <input class="input" id="sb-int" type="number" min="10" max="1440" value="${sb.interval_min}" style="width:90px"> <span class="muted small">minutos</span>
            </div>
          </div>` : '<p class="small muted">Somente o administrador altera as credenciais da API.</p>'}
          <div class="row" style="gap:8px;margin-top:12px">
            ${hasRole(['admin']) ? '<button class="btn" id="sb-save">Salvar configuração</button>' : ''}
            <button class="btn" id="sb-test">Testar conexão</button>
            <button class="btn primary" id="sb-sync">Buscar dados agora</button>
          </div>
          <div class="small" style="margin-top:10px">${sb.last_sync ? `Última busca: <b>${esc(dt(sb.last_sync))}</b> · ` : ''}<span style="color:${String(sb.last_result || '').startsWith('Erro') ? 'var(--danger)' : 'inherit'}">${esc(sb.last_result || 'Nenhuma busca realizada.')}</span></div>
          <div id="sb-res" style="margin-top:8px"></div>
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
          ${d.sales.groups.map((g) => `<div style="padding:4px 16px 0"><b>${esc(g.label)}</b> <span class="muted small">· total ${brl(g.total)}</span></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>Vendedor</th><th class="n">Diárias</th><th class="n">Valor</th></tr></thead><tbody>
            ${g.ranking.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.full_names.length ? `<div class="small muted">${r.full_names.map(esc).join(', ')}</div>` : '<div class="small muted">não consta no relatório</div>'}</td><td class="n">${(r.room_nights || 0).toLocaleString('pt-BR')}</td><td class="n">${brl(r.value)}</td></tr>`).join('')}
          </tbody></table></div>`).join('')}
          <div style="padding:12px 16px;border-top:1px solid var(--line);display:grid;gap:8px">
            <label class="f" style="margin:0">Vendedores do cliente final (separados por vírgula)<input class="input" id="sellers-final" value="${esc(d.sellers.final)}"></label>
            <label class="f" style="margin:0">Vendedores das agências (separados por vírgula)<input class="input" id="sellers-agencia" value="${esc(d.sellers.agencia)}"></label>
            <div><button class="btn" id="save-sellers">Salvar vendedores</button></div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 class="grow">Valores e previsões por unidade</h3>
          <div class="seg" id="mtabs">${d.unit_rows.map((r, i) => `<button data-mi="${i}" class="${i === mi ? 'on' : ''}">${mesLabel(r.month)}</button>`).join('')}</div></div>
        ${(() => { const row = d.unit_rows[mi]; const n = (v) => Number(v) || 0;
          const sold = (u) => (u.silbeck != null ? u.silbeck : u.value);
          const tot = row.units.filter((u) => u.active).reduce((t, u) => ({ v: t.v + n(sold(u)), o: t.o + n(u.other_value), g: t.g + n(u.goal) }), { v: 0, o: 0, g: 0 });
          return `<div class="table-wrap"><table class="t" id="utab" data-month="${row.month}"><thead><tr><th>Exibir</th><th>${mesLabel(row.month).toUpperCase()}</th><th>Vendido até agora<div class="small muted" style="text-transform:none;font-weight:500">Resort: relatório de vendas do Silbeck</div></th><th>Antecipações / outras receitas</th><th>Descrição da receita</th><th>Previsão (meta)</th><th class="n">Falta</th></tr></thead><tbody>
          ${row.units.map((u) => `<tr data-unit="${u.unit}" style="${u.active ? '' : 'opacity:.45'}"><td><label class="row" style="gap:6px" title="Exibir esta unidade no painel da TV"><input type="checkbox" data-active ${u.active ? 'checked' : ''}> ${u.active ? 'Ativa' : 'Desativada'}</label></td><td><b>${esc(u.label)}</b></td>
            <td>${u.silbeck != null ? `<input class="input sm" value="${fmt(u.silbeck)}" disabled title="Total do relatório de Walk-ins/Reservas do mês" style="width:150px"><div class="small muted">relatório de vendas</div>` : `<input class="input sm" data-k="value" value="${fmt(u.value)}" placeholder="0,00" style="width:150px">`}</td>
            <td><input class="input sm" data-k="other_value" value="${fmt(u.other_value)}" placeholder="0,00" style="width:150px"></td>
            <td><input class="input sm" data-k="other_note" value="${esc(u.other_note || '')}" placeholder="Ex.: venda de terreno" style="width:180px"></td>
            <td><input class="input sm" data-k="goal" value="${fmt(u.goal)}" placeholder="0,00" style="width:150px"></td>
            <td class="n">${u.goal == null ? '—' : brl(Math.max(0, n(u.goal) - n(sold(u))))}</td></tr>`).join('')}
          </tbody><tfoot><tr><td></td><td><b>TOTAL</b></td><td><b>${brl(tot.v)}</b></td><td><b>${brl(tot.o)}</b></td><td></td><td><b>${brl(tot.g + tot.o)}</b><div class="small muted">previsões + antecipações</div></td><td class="n"><b>${brl(Math.max(0, tot.g - tot.v))}</b></td></tr></tfoot></table></div>
          <div class="row" style="padding:12px 16px;gap:12px;border-top:1px solid var(--line);align-items:flex-end">
            <label class="f" style="margin:0;max-width:220px">Meta de vendas do mês<input class="input" id="sgoal" value="${fmt(row.sales_goal)}" placeholder="0,00"></label>
            <span class="grow muted small">Desmarque <b>Exibir</b> para desativar uma unidade: ela deixa de aparecer no painel da TV e de entrar nos totais, em todos os meses.</span><button class="btn primary" id="usave">Salvar ${mesLabel(row.month)}</button></div>`; })()}
      </div>

      <div class="card pad">
        <h3 style="margin-top:0">Link do painel para a TV</h3>
        <p class="muted small">Abra este endereço no navegador da TV. O painel não exige login e se atualiza sozinho a cada minuto. Ao gerar um novo link, o anterior deixa de funcionar.</p>
        <div class="row" style="gap:8px"><input class="input" id="link" value="${esc(link)}" readonly style="max-width:720px"><button class="btn" id="copy">Copiar link</button><button class="btn danger" id="newkey">Gerar novo link</button></div>
      </div>`;

    const sbRes = (html) => { el.querySelector('#sb-res').innerHTML = html; };
    const sbSave = el.querySelector('#sb-save');
    if (sbSave) sbSave.onclick = async () => {
      try {
        await put('/api/tv/silbeck', { url: el.querySelector('#sb-url').value, client_id: el.querySelector('#sb-id').value, client_secret: el.querySelector('#sb-secret').value, auto: el.querySelector('#sb-auto').checked, interval_min: el.querySelector('#sb-int').value });
        toast('Configuração da API salva.'); load();
      } catch (e) { fail(e); }
    };
    el.querySelector('#sb-test').onclick = async () => {
      sbRes('<span class="muted small">Testando conexão…</span>');
      try {
        const r = await post('/api/tv/silbeck/test');
        sbRes(`<div class="banner ok">${icon('check')}<span>Conexão realizada${r.ms >= 1000 ? ` em ${(r.ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : ''}. Hoje: ${r.today.apts_occ ?? '—'} apartamentos ocupados (${pct(r.today.apts_pct)}) · ${brl(r.today.revenue)} em diárias.</span></div><details class="small" style="margin-top:6px"><summary>Resposta recebida da API</summary><pre style="white-space:pre-wrap;max-height:220px;overflow:auto">${esc(r.sample)}</pre></details>`);
      } catch (e) { sbRes(`<div class="banner danger">${icon('alert')}<span>${esc(e.message)}</span></div>`); }
    };
    el.querySelector('#sb-sync').onclick = async () => {
      sbRes('<span class="muted small">Buscando dados no Silbeck… pode levar alguns segundos.</span>');
      try {
        const r = await post('/api/tv/silbeck/sync');
        await load();
        sbRes(`<div class="banner ok">${icon('check')}<span>Dados atualizados: ${r.months.map((m) => `${mesLabel(m.month)} ${brl(m.revenue)}`).join(' · ')} · vendas de ${dmy(r.sales.period_from)} a ${dmy(r.sales.period_to)}: ${r.sales.sellers} funcionários, ${brl(r.sales.total)}.</span></div>`);
      } catch (e) { sbRes(`<div class="banner danger">${icon('alert')}<span>${esc(e.message)}</span></div>`); }
    };
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
      try { await put('/api/tv/settings', { sellers: { final: el.querySelector('#sellers-final').value, agencia: el.querySelector('#sellers-agencia').value } }); toast('Vendedores salvos.'); load(); } catch (e) { fail(e); }
    };
    el.querySelectorAll('[data-active]').forEach((c) => c.addEventListener('change', () => { const tr = c.closest('tr'); tr.style.opacity = c.checked ? '' : '.45'; c.parentElement.lastChild.textContent = c.checked ? ' Ativa' : ' Desativada'; }));
    el.querySelectorAll('#mtabs [data-mi]').forEach((b) => b.addEventListener('click', () => { mi = Number(b.dataset.mi); draw(); }));
    el.querySelector('#usave').onclick = async () => {
      const tab = el.querySelector('#utab');
      const units = [...tab.querySelectorAll('tr[data-unit]')].map((tr) => ({ unit: tr.dataset.unit, active: tr.querySelector('[data-active]').checked, ...Object.fromEntries([...tr.querySelectorAll('input[data-k]')].map((i) => [i.dataset.k, i.value])) }));
      try { await put('/api/tv/units', { month: tab.dataset.month, units, sales_goal: el.querySelector('#sgoal').value }); toast(`Valores de ${mesLabel(tab.dataset.month)} salvos.`); load(); } catch (e) { fail(e); }
    };
    el.querySelector('#copy').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Link copiado.'), () => toast('Não foi possível copiar.', 'err'));
    el.querySelector('#newkey').onclick = async () => {
      if (!(await confirmBox('Deseja gerar um novo link? O link atual deixará de funcionar na TV.', 'Gerar novo link', true))) return;
      try { await put('/api/tv/settings', { new_key: true }); toast('Novo link gerado.'); load(); } catch (e) { fail(e); }
    };
  }

  await load();
}
