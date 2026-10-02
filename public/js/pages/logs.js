import { dt, get, esc, fail } from '../ui.js';

const LABELS = {
  login: 'Acesso ao sistema', logout: 'Saída do sistema', login_falhou: 'Falha de acesso', senha_alterada: 'Alteração de senha',
  reserva_criada: 'Inclusão de reserva', reserva_alterada: 'Alteração de reserva', reserva_cancelada: 'Cancelamento de reserva', reserva_reativada: 'Reativação de reserva',
  importacao_planilha: 'Importação de planilha', distribuicao_refeita: 'Redistribuição', cliente_movido: 'Transferência de restaurante', lista_publicada: 'Publicação de lista', lista_publicada_auto: 'Publicação automática de lista',
  refeicao_marcada: 'Registro de atendimento', marcacao_desfeita: 'Cancelamento de atendimento', avulso_registrado: 'Consumo cobrado à parte',
  controle_real_alterado: 'Informação de realizado', faturamento_fechado: 'Fechamento do faturamento', faturamento_reaberto: 'Reabertura do faturamento', faturamento_exportado: 'Exportação do faturamento',
  relatorio_diario_exportado: 'Exportação do controle diário', precos_alterados: 'Alteração de preços', usuario_criado: 'Inclusão de usuário', usuario_alterado: 'Alteração de usuário', senha_resetada: 'Geração de senha provisória',
  restaurante_alterado: 'Alteração de restaurante', horarios_alterados: 'Alteração de horários', chave_api_criada: 'Inclusão de chave de API', chave_api_revogada: 'Revogação de chave de API',
  integracao_configurada: 'Configuração de integração', api_reservas: 'Reservas via API', silbeck_sincronizado: 'Sincronização com o Silbeck', ia_consulta: 'Consulta ao assistente de relatórios', exportou_reservas: 'Exportação de reservas',
  voucher_recebido: 'Registro de voucher', voucher_removido: 'Exclusão de voucher', extra_lancado: 'Registro de refeição extra', extra_removido: 'Exclusão de refeição extra',
  lancamento_financeiro: 'Lançamento financeiro', lancamento_financeiro_removido: 'Exclusão de lançamento financeiro', historico_importado: 'Importação de histórico',
  controle_faturamento_exportado: 'Exportação do controle de faturamento', controle_restaurante_exportado: 'Exportação do controle do restaurante', financeiro_configurado: 'Configuração do controle financeiro', politica_alterada: 'Alteração de política',
};

export async function render(el) {
  const st = { q: '', from: '', to: '' };
  el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Auditoria</h1><p>Registro de todas as operações realizadas no sistema, com usuário e horário (últimos 500 registros do filtro).</p></div></div>
    <div class="card pad" style="margin-bottom:14px"><div class="row">
      <input class="input" id="q" placeholder="Buscar ação, usuário ou detalhe" style="max-width:320px">
      <label class="row small" style="gap:6px">De <input type="date" class="input sm" id="from" style="width:auto"></label>
      <label class="row small" style="gap:6px">até <input type="date" class="input sm" id="to" style="width:auto"></label>
    </div></div>
    <div class="card"><div class="table-wrap" style="max-height:70vh"><table class="t"><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  async function load() {
    const rows = await get(`/api/audit?q=${encodeURIComponent(st.q)}&from=${st.from}&to=${st.to}`);
    el.querySelector('#tb').innerHTML = rows.map((r) => `<tr><td class="small" style="white-space:nowrap">${esc(dt(r.created_at))}</td><td>${esc(r.username || 'sistema')}</td>
      <td><b>${esc(LABELS[r.action] || r.action)}</b></td><td class="small muted" style="max-width:520px;word-break:break-word">${esc(r.details || '')}</td><td class="small muted">${esc(r.ip || '')}</td></tr>`).join('')
      || '<tr><td colspan="5"><div class="empty">Nada encontrado.</div></td></tr>';
  }
  let deb;
  el.querySelector('#q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { st.q = e.target.value; load().catch(fail); }, 250); });
  el.querySelector('#from').addEventListener('change', (e) => { st.from = e.target.value; load().catch(fail); });
  el.querySelector('#to').addEventListener('change', (e) => { st.to = e.target.value; load().catch(fail); });
  await load();
}
