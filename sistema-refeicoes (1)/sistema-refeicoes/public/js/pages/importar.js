import { api, post, esc, icon, fail, toast, boardTag, br, download, roomHtml } from '../ui.js';

export async function render(el) {
  let preview = null;

  function drawStart() {
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Importar planilha de hóspedes</h1>
        <p>Envie o Excel (.xlsx) ou CSV exportado do sistema do hotel. As colunas são reconhecidas pelo nome: nº da reserva, nome completo, entrada, saída, quarto (ou UH), pensão (ou regime), adultos (ou pessoas) e crianças.</p></div>
        <button class="btn" id="tpl">${icon('download')} Modelo de planilha</button></div>
      <label class="dropzone" id="dz">
        ${icon('upload')}
        <h2 style="margin-top:8px">Arraste a planilha aqui</h2>
        <p class="muted">ou clique para escolher o arquivo (.xlsx ou .csv)</p>
        <input type="file" id="file" accept=".xlsx,.csv,.txt" hidden>
      </label>
      <div class="grid g3" style="margin-top:18px">
        <div class="card pad"><h3>1. Conferir</h3><p class="muted small">Antes de gravar, você vê cada linha: nova, alterada, sem mudança ou com erro.</p></div>
        <div class="card pad"><h3>2. Trocas de quarto</h3><p class="muted small">Se uma reserva já existente vier com outro quarto, a troca é registrada e recepção e restaurantes são avisados.</p></div>
        <div class="card pad"><h3>3. Divisão automática</h3><p class="muted small">Novos hóspedes entram na divisão 60/20/20 (café 60/40). Quem já tinha restaurante continua onde está.</p></div>
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

  function drawPreview() {
    const rows = preview.rows;
    const c = (a) => rows.filter((r) => r.action === a).length;
    const badge = { nova: '<span class="badge ok">nova</span>', alterada: '<span class="badge warn">alterada</span>', igual: '<span class="badge">sem mudança</span>', erro: '<span class="badge danger">erro</span>' };
    const trocas = rows.filter((r) => r.old_room);
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Conferir importação</h1><p>${esc(preview.filename)} · cabeçalho na linha ${preview.headerRow}</p></div>
        <button class="btn" id="back">Escolher outro arquivo</button>
        <button class="btn primary" id="go" ${c('nova') + c('alterada') ? '' : 'disabled'}>${icon('check')} Importar ${c('nova') + c('alterada')} reserva(s)</button></div>
      <div class="stats">
        <div class="card stat"><div class="k">Novas</div><div class="v">${c('nova')}</div></div>
        <div class="card stat"><div class="k">Alteradas</div><div class="v">${c('alterada')}</div></div>
        <div class="card stat"><div class="k">Sem mudança</div><div class="v">${c('igual')}</div></div>
        <div class="card stat"><div class="k">Com erro</div><div class="v" style="color:${c('erro') ? 'var(--danger)' : 'inherit'}">${c('erro')}</div></div>
      </div>
      ${trocas.length ? `<div class="banner warn">${icon('swap')}<span><b>${trocas.length} troca(s) de quarto</b> detectada(s): ${trocas.slice(0, 6).map((r) => `${esc(r.guest_name)} ${esc(r.old_room)} → ${esc(r.room)}`).join(' · ')}${trocas.length > 6 ? '…' : ''}</span></div>` : ''}
      ${c('erro') ? `<div class="banner danger">${icon('alert')}<span>Linhas com erro não serão importadas. Corrija na planilha e envie de novo, se precisar.</span></div>` : ''}
      <div class="card pad" style="margin-bottom:14px"><b>Colunas reconhecidas:</b> ${Object.values(preview.mapping).map((m) => `<span class="badge" style="margin:2px">${esc(m.label)} ← “${esc(m.column)}”</span>`).join('')}</div>
      <div class="card"><div class="table-wrap" style="max-height:60vh"><table class="t">
        <thead><tr><th>Linha</th><th></th><th>Reserva</th><th>Nome</th><th>Entrada</th><th>Saída</th><th>Quarto</th><th>Pensão</th><th class="n">Adt</th><th class="n">Chd</th><th>Observação</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="muted">${r.line}</td><td>${badge[r.action]}</td><td>${esc(r.reservation_number)}</td><td>${esc(r.guest_name)}</td>
          <td>${esc(br(r.checkin))}</td><td>${esc(br(r.checkout))}</td>
          <td class="room">${r.old_room ? `<span class="muted" style="text-decoration:line-through">${esc(r.old_room)}</span> ` : ''}${roomHtml(r.room)}</td>
          <td>${r.board ? boardTag(r.board) : ''}</td><td class="n">${r.adults ?? ''}</td><td class="n">${r.children ?? ''}</td>
          <td class="small" style="color:var(--danger)">${esc(r.errors.join('; '))}${r.warning ? `<span style="color:#8a5a07">${esc(r.warning)}</span>` : ''}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
    el.querySelector('#back').onclick = drawStart;
    el.querySelector('#go').onclick = commit;
  }

  async function commit() {
    const btn = el.querySelector('#go');
    btn.disabled = true; btn.textContent = 'Importando…';
    try {
      const rows = preview.rows.filter((r) => r.action === 'nova' || r.action === 'alterada');
      const r = await post('/api/import/commit', { filename: preview.filename, rows });
      toast(`${r.inserted} novas, ${r.updated} atualizadas${r.roomChanges.length ? `, ${r.roomChanges.length} troca(s) de quarto avisada(s)` : ''}.`, 'ok', 'Importação concluída');
      el.innerHTML = `<div class="card pad" style="text-align:center;padding:40px">
        <h1>Importação concluída</h1>
        <p class="muted">${r.inserted} reservas novas · ${r.updated} atualizadas · ${r.unchanged} sem mudança${r.errors.length ? ` · ${r.errors.length} com erro` : ''}</p>
        ${r.roomChanges.length ? `<p>${r.roomChanges.length} troca(s) de quarto registradas e avisadas.</p>` : ''}
        <div class="row" style="justify-content:center;margin-top:16px"><a class="btn" href="#/distribuicao">Ver distribuição</a><a class="btn" href="#/recepcao">Ver recepção</a><button class="btn primary" id="again">Importar outra</button></div></div>`;
      el.querySelector('#again').onclick = drawStart;
    } catch (e) { fail(e); btn.disabled = false; }
  }

  drawStart();
}
