import { api, post, esc, icon, fail, toast, boardTag, br, download, roomHtml, canSee } from '../ui.js';

export async function render(el) {
  let preview = null;

  function drawStart() {
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Importação de reservas</h1>
        <p>Envie a planilha de divisão (.xlsx) ou o CSV do sistema do hotel. As colunas são reconhecidas pelo nome: Reserva (pode vir com o nome do grupo junto, ex.: “50893 ANR TUR”), Entrada, Saída, Pensão, Apartamento/Apartamento, Pax e Chd. Se a planilha já tiver as colunas de divisão por restaurante, o sistema também lê.</p></div>
        <button class="btn" id="tpl">${icon('download')} Modelo de planilha</button></div>
      <label class="dropzone" id="dz">
        ${icon('upload')}
        <h2 style="margin-top:8px">Arraste a planilha para esta área</h2>
        <p class="muted">ou clique para escolher o arquivo (.xlsx ou .csv)</p>
        <input type="file" id="file" accept=".xlsx,.csv,.txt" hidden>
      </label>
      <div class="grid g3" style="margin-top:18px">
        <div class="card pad"><h3>1. Conferir</h3><p class="muted small">Antes de gravar, você vê cada linha: nova, alterada, sem mudança ou com erro.</p></div>
        <div class="card pad"><h3>2. Trocas de apartamento</h3><p class="muted small">Se uma reserva já existente vier com outro apartamento, a troca é registrada e recepção e restaurantes são avisados.</p></div>
        <div class="card pad"><h3>3. Divisão</h3><p class="muted small">Utiliza a divisão informada na planilha ou realiza a divisão automaticamente (60/20/20), sempre com o grupo inteiro no mesmo restaurante e alternando os restaurantes ao longo da estadia.</p></div>
      </div>`;
    const dz = el.querySelector('#dz'), fi = el.querySelector('#file');
    fi.addEventListener('change', () => fi.files[0] && upload(fi.files[0]));
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    el.querySelector('#tpl').onclick = () => download('/api/import/modelo.csv');
  }

  async function upload(file) {
    el.querySelector('#dz').innerHTML = `<h2>Lendo ${esc(file.name)}…</h2>`;
    try {
      const buf = await file.arrayBuffer();
      preview = await api('POST', '/api/import/preview', buf, { headers: { 'X-Filename': encodeURIComponent(file.name) } });
      drawPreview();
    } catch (e) { fail(e); drawStart(); }
  }

  const MEALN = { cafe: 'café', almoco: 'almoço', janta: 'jantar' };
  let filter = 'todos';

  function drawPreview() {
    const rows = preview.rows;
    const c = (a) => rows.filter((r) => r.action === a).length;
    const badge = { nova: '<span class="badge ok">nova</span>', alterada: '<span class="badge warn">alterada</span>', igual: '<span class="badge">sem mudança</span>', erro: '<span class="badge danger">erro</span>', duplicada: '<span class="badge">repetida</span>' };
    const trocas = rows.filter((r) => r.old_room);
    const fixedDates = rows.filter((r) => r.date_fixed).length;
    const withNotes = rows.filter((r) => (r.notes && r.notes.length) || r.warning);
    const dist = preview.distribution;
    const loa = [...new Map(rows.filter((r) => r.lunch_on_arrival && !r.errors.length).map((r) => [r.reservation_number, r.guest_name])).values()];
    const toImport = c('nova') + c('alterada');
    const shown = rows.filter((r) => filter === 'todos' || (filter === 'avisos' ? (r.notes && r.notes.length) || r.warning : filter === 'erros' ? r.errors.length : r.action === filter));
    const slotTxt = dist ? (() => { const s = [...dist.slots].sort((a, b) => a.date.localeCompare(b.date)); const f = s[0], l = s[s.length - 1]; return `de ${MEALN[f.meal]} ${br(f.date).slice(0, 5)} a ${MEALN[l.meal]} ${br(l.date).slice(0, 5)}`; })() : '';
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Conferência da importação</h1><p>${esc(preview.filename)} · cabeçalho na linha ${preview.headerRow} · ${rows.length} apartamentos em ${preview.groups} reservas</p></div>
        <button class="btn" id="back">Escolher outro arquivo</button>
        <button class="btn primary" id="go">${icon('check')} Importar</button></div>
      <div class="stats">
        <div class="card stat"><div class="k">Apartamentos novos</div><div class="v">${c('nova')}</div></div>
        <div class="card stat"><div class="k">Alterados</div><div class="v">${c('alterada')}</div></div>
        <div class="card stat"><div class="k">Sem mudança</div><div class="v">${c('igual')}</div></div>
        <div class="card stat"><div class="k">Com erro</div><div class="v" style="color:${c('erro') ? 'var(--danger)' : 'inherit'}">${c('erro')}</div></div>
      </div>
      ${fixedDates ? `<div class="banner info">${icon('info')}<span><b>${fixedDates} linha(s)</b> tinham a data gravada pelo Excel com dia e mês trocados (ex.: 01/10 lido como 10/01). O sistema corrigiu automaticamente.</span></div>` : ''}
      ${dist ? `<div class="card pad" style="margin-bottom:14px">
          <div class="row"><div class="grow"><b>A planilha já traz a divisão por restaurante</b> <span class="muted">· ${dist.columns.length} colunas, ${slotTxt}</span></div></div>
          <label class="row" style="margin-top:10px;gap:8px;cursor:pointer"><input type="checkbox" id="use-dist" ${preview.useDist !== false ? 'checked' : ''}>
            <span>Usar a divisão da planilha — cada apartamento fica travado no restaurante que está na planilha. Desmarque para o sistema dividir sozinho pela regra 60/20/20.</span></label>
          ${loa.length ? `<p class="small" style="margin:10px 0 0"><b>Almoço no dia da chegada</b> (detectado na planilha): ${loa.map(esc).join(' · ')}</p>` : ''}
        </div>` : ''}
      ${trocas.length ? `<div class="banner warn">${icon('swap')}<span><b>${trocas.length} troca(s) de apartamento</b>: ${trocas.slice(0, 6).map((r) => `${esc(r.guest_name)} ${esc(r.old_room)} → ${esc(r.room)}`).join(' · ')}${trocas.length > 6 ? '…' : ''}</span></div>` : ''}
      ${preview.removed && preview.removed.length ? `<div class="card pad" style="margin-bottom:14px;border-color:#e8c47e">
          <b>${preview.removed.length} apartamento(s) de reservas desta planilha não aparecem mais nela:</b>
          <div class="small" style="margin:6px 0">${preview.removed.slice(0, 12).map((x) => `${esc(x.guest_name)} · ${roomHtml(x.room)}`).join(' &nbsp;·&nbsp; ')}${preview.removed.length > 12 ? ' …' : ''}</div>
          <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" id="cancel-missing" ${preview.cancelMissing !== false ? 'checked' : ''}> <span>Cancelar esses apartamentos (saem das listas futuras)</span></label>
        </div>` : ''}
      ${c('erro') ? `<div class="banner danger">${icon('alert')}<span>Linhas com erro não são importadas. Quando o sistema consegue sugerir a correção, escolha abaixo na própria linha.</span></div>` : ''}
      <div class="card pad" style="margin-bottom:14px"><b>Colunas reconhecidas:</b> ${Object.values(preview.mapping).map((m) => `<span class="badge" style="margin:2px">${esc(m.label)} ← “${esc(m.column)}”</span>`).join('')}</div>
      <div class="card">
        <div class="card-head"><div class="seg" id="flt">${[['todos', `Todos (${rows.length})`], ['nova', `Novos (${c('nova')})`], ['alterada', `Alterados (${c('alterada')})`], ['avisos', `Com aviso (${withNotes.length})`], ['erros', `Erros (${c('erro')})`]].map(([k, l]) => `<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="table-wrap" style="max-height:60vh"><table class="t">
        <thead><tr><th>Linha</th><th></th><th>Reserva</th><th>Nome / grupo</th><th>Entrada</th><th>Saída</th><th>Apartamento</th><th>Pensão</th><th class="n">Adt</th><th class="n">Chd</th><th>Observação</th></tr></thead>
        <tbody>${shown.map((r) => `<tr data-line="${r.line}">
          <td class="muted">${r.line}</td><td>${badge[r.action] || ''}</td><td>${esc(r.reservation_number)}</td><td>${esc(r.guest_name)}${r.lunch_on_arrival ? ' <span class="badge info" title="Almoço no dia da chegada">almoço na chegada</span>' : ''}</td>
          <td>${esc(br(r.checkin))}</td><td>${esc(br(r.checkout))}</td>
          <td class="room">${r.old_room ? `<span class="muted" style="text-decoration:line-through">${esc(r.old_room)}</span> ` : ''}${roomHtml(r.room)}</td>
          <td>${r.board ? boardTag(r.board) : (r.errors.some((e) => /^pensão/.test(e)) ? `<select class="input sm" data-fixboard style="width:auto"><option value="">${r.board_guess ? `usar ${r.board_guess}?` : 'corrigir…'}</option>${['CM', 'MAP', 'MAPA', 'FAP'].map((b) => `<option value="${b}">${b}${b === r.board_guess ? ' (sugerida)' : ''}</option>`).join('')}</select>` : '')}</td>
          <td class="n">${r.adults ?? ''}</td><td class="n">${r.children ?? ''}</td>
          <td class="small">${r.errors.length ? `<div style="color:var(--danger)">${esc(r.errors.join('; '))}</div>` : ''}${r.warning ? `<div style="color:#8a5a07">${esc(r.warning)}</div>` : ''}${(r.notes || []).map((n) => `<div style="color:#8a5a07">${esc(n)}</div>`).join('')}</td></tr>`).join('')
          || '<tr><td colspan="11"><div class="empty">Nada neste filtro.</div></td></tr>'}</tbody>
      </table></div></div>`;
    const go = el.querySelector('#go');
    go.disabled = !(toImport || (dist && rows.some((r) => r.action === 'igual')) || (preview.removed || []).length);
    el.querySelector('#back').onclick = drawStart;
    go.onclick = commit;
    el.querySelector('#use-dist')?.addEventListener('change', (e) => { preview.useDist = e.target.checked; });
    el.querySelector('#cancel-missing')?.addEventListener('change', (e) => { preview.cancelMissing = e.target.checked; });
    el.querySelectorAll('#flt [data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; drawPreview(); }));
    el.querySelectorAll('select[data-fixboard]').forEach((sel) => {
      const apply = () => {
        const row = rows.find((r) => String(r.line) === sel.closest('tr').dataset.line);
        if (!sel.value) return;
        row.board = sel.value;
        row.errors = row.errors.filter((e) => !/^pensão/.test(e));
        row.notes = (row.notes || []).filter((n) => !/^pensão ".*" inválida/.test(n));
        if (!row.errors.length) row.action = 'nova';
        drawPreview();
      };
      sel.addEventListener('change', apply);
    });
  }

  async function commit() {
    const btn = el.querySelector('#go');
    btn.disabled = true; btn.textContent = 'Importando…';
    try {
      const rows = preview.rows.filter((r) => !r.errors.length);
      const r = await post('/api/import/commit', {
        filename: preview.filename, rows,
        use_distribution: !!preview.distribution && preview.useDist !== false,
        cancel_missing: preview.cancelMissing !== false,
      });
      toast(`${r.inserted} novos, ${r.updated} atualizados${r.roomChanges.length ? `, ${r.roomChanges.length} troca(s) de apartamento avisada(s)` : ''}.`, 'ok', 'Importação concluída');
      el.innerHTML = `<div class="card pad" style="text-align:center;padding:40px">
        <h1>Importação concluída</h1>
        <p class="muted">${r.inserted} apartamentos novos · ${r.updated} atualizados · ${r.unchanged} sem mudança${r.cancelled ? ` · ${r.cancelled} cancelados` : ''}${r.errors.length ? ` · ${r.errors.length} com erro` : ''}</p>
        ${r.distApplied ? `<p>Divisão da planilha aplicada em ${r.distApplied} refeições${r.distSkipped ? ` (${r.distSkipped} não aplicadas porque a pensão não inclui)` : ''}.</p>` : ''}
        ${r.roomChanges.length ? `<p>${r.roomChanges.length} troca(s) de apartamento registradas e avisadas.</p>` : ''}
        <div class="row" style="justify-content:center;margin-top:16px">${canSee('distribuicao') ? '<a class="btn" href="#/distribuicao">Distribuição de hóspedes</a>' : ''}${canSee('recepcao') ? '<a class="btn" href="#/recepcao">Consulta de refeições</a>' : ''}<button class="btn primary" id="again">Importar outra</button></div></div>`;
      el.querySelector('#again').onclick = drawStart;
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Importar'; }
  }

  drawStart();
}
