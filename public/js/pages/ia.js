import { post, esc, icon, fail, markdown, today } from '../ui.js';

const SUGG = [
  'Resumo do mês: quantos cafés, almoços e jantares por restaurante, separando adultos e crianças.',
  'Em quais dias o real ficou muito diferente do previsto? Onde estamos tendo prejuízo?',
  'A divisão 60/20/20 está sendo respeitada? Mostre a porcentagem real de cada restaurante.',
  'Compare este mês com os dois anteriores.',
  'Quantos clientes comeram fora da lista em cada restaurante?',
];

export async function render(el) {
  const st = { month: today().slice(0, 7), history: [] };
  function draw() {
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Assistente de relatórios</h1><p>Pergunte em português. A IA lê os números do sistema (previsto, marcado, real, valores) do mês escolhido e dos dois anteriores e monta o relatório.</p></div>
        <input type="month" class="input sm" id="month" value="${esc(st.month)}" style="width:auto"></div>
      <div class="card pad" style="margin-bottom:16px">
        <textarea class="input" id="q" rows="3" placeholder="Ex.: Quantos almoços de criança o Paradiso serviu em setembro e quanto isso custou?"></textarea>
        <div class="row" style="margin-top:10px"><div class="chips grow">${SUGG.map((s, i) => `<button class="chip" data-s="${i}">${esc(s.length > 60 ? s.slice(0, 58) + '…' : s)}</button>`).join('')}</div>
        <button class="btn primary" id="ask">${icon('spark')} Gerar relatório</button></div>
      </div>
      <div id="out">${st.history.map((h) => block(h)).join('')}</div>`;
    el.querySelector('#month').addEventListener('change', (e) => { st.month = e.target.value; });
    el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { el.querySelector('#q').value = SUGG[b.dataset.s]; el.querySelector('#q').focus(); }));
    el.querySelector('#ask').onclick = ask;
    el.querySelector('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); });
  }
  const block = (h) => `<div class="card pad" style="margin-bottom:14px"><div class="muted small" style="margin-bottom:6px">${esc(h.month)} · ${esc(h.q)}</div><div class="answer">${h.a ? markdown(h.a) : '<span class="muted">Gerando…</span>'}</div></div>`;

  async function ask() {
    const q = el.querySelector('#q').value.trim();
    if (!q) return;
    const h = { q, month: st.month, a: '' };
    st.history.unshift(h);
    draw();
    try { const r = await post('/api/ia', { question: q, month: st.month }); h.a = r.answer; }
    catch (e) {
      h.a = e.status === 501 ? '**Assistente ainda não configurado.** O administrador precisa definir a variável `ANTHROPIC_API_KEY` no servidor. Os relatórios em CSV (Faturamento e Controle) já funcionam sem a IA.' : 'Erro: ' + e.message;
    }
    draw();
  }
  draw();
}
