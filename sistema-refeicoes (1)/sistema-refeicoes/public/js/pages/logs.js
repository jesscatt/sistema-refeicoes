import { get, esc, fail } from '../ui.js';

const LABELS = {
  login: 'Entrou', logout: 'Saiu', login_falhou: 'Falha de login', senha_alterada: 'Trocou a senha',
  reserva_criada: 'Criou reserva', reserva_alterada: 'Alterou reserva', reserva_cancelada: 'Cancelou reserva', reserva_reativada: 'Reativou reserva',
  importacao_planilha: 'Importou planilha', distribuicao_refeita: 'Redistribuiu', cliente_movido: 'Moveu cliente', lista_publicada: 'Publicou lista', lista_publicada_auto: 'Lista publicada (automática)',
  refeicao_marcada: 'Marcou refeição', marcacao_desfeita: 'Desfez marcação', avulso_registrado: 'Consumo à parte',
  controle_real_alterado: 'Informou real', faturamento_fechado: 'Fechou faturamento', faturamento_reaberto: 'Reabriu faturamento', faturamento_exportado: 'Exportou faturamento',
  relatorio_diario_exportado: 'Exportou controle diário', precos_alterados: 'Alterou valores', usuario_criado: 'Criou usuário', usuario_alterado: 'Alterou usuário', senha_resetada: 'Gerou nova senha',
  restaurante_alterado: 'Alterou restaurante', horarios_alterados: 'Alterou horários', chave_api_criada: 'Criou chave de API', chave_api_revogada: 'Revogou chave de API',
  integracao_configurada: 'Configurou integração', api_reservas: 'Reservas via API', silbeck_sincronizado: 'Sincronizou Silbeck', ia_consulta: 'Consultou IA', exportou_reservas: 'Exportou reservas',
};

export async function render(el) {
  const st = { q: '', from: '', to: '' };
  el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Logs de auditoria</h1><p>Tudo o que foi feito no sistema, por quem e quando (últimos 500 registros do filtro).</p></div></div>
    <div class="card pad" style="margin-bottom:14px"><div class="row">
      <input class="input" id="q" placeholder="Buscar ação, usuário ou detalhe" style="max-width:320px">
      <label class="row small" style="gap:6px">De <input type="date" class="input sm" id="from" style="width:auto"></label>
      <label class="row small" style="gap:6px">até <input type="date" class="input sm" id="to" style="width:auto"></label>
    </div></div>
    <div class="card"><div class="table-wrap" style="max-height:70vh"><table class="t"><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  async function load() {
    const rows = await get(`/api/audit?q=${encodeURIComponent(st.q)}&from=${st.from}&to=${st.to}`);
    el.querySelector('#tb').innerHTML = rows.map((r) => `<tr><td class="small" style="white-space:nowrap">${esc(r.created_at)}</td><td>${esc(r.username || 'sistema')}</td>
      <td><b>${esc(LABELS[r.action] || r.action)}</b></td><td class="small muted" style="max-width:520px;word-break:break-word">${esc(r.details || '')}</td><td class="small muted">${esc(r.ip || '')}</td></tr>`).join('')
      || '<tr><td colspan="5"><div class="empty">Nada encontrado.</div></td></tr>';
  }
  let deb;
  el.querySelector('#q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { st.q = e.target.value; load().catch(fail); }, 250); });
  el.querySelector('#from').addEventListener('change', (e) => { st.from = e.target.value; load().catch(fail); });
  el.querySelector('#to').addEventListener('change', (e) => { st.to = e.target.value; load().catch(fail); });
  await load();
}
