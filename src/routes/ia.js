'use strict';
// Assistente de relatórios com IA (Claude). Ativado quando ANTHROPIC_API_KEY está definida.
const { route, HttpError } = require('../http');
const { db, audit } = require('../db');
const { MEAL_LABEL, todayISO, monthRange, addDays } = require('../util');
const { billing, controlRows } = require('./control');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

function prevMonth(m) { return addDays(monthRange(m).first, -1).slice(0, 7); }

function buildContext(month) {
  const months = [month, prevMonth(month), prevMonth(prevMonth(month))];
  const rests = Object.fromEntries(db.prepare('SELECT id, name FROM restaurants').all().map((r) => [r.id, r.name]));
  const resumoMensal = months.map((m) => {
    const b = billing(m);
    return {
      mes: m, total_reais: b.total,
      linhas: b.lines.map((l) => ({
        restaurante: l.restaurant.name, refeicao: MEAL_LABEL[l.meal],
        previsto_adt: l.forecast_adults, previsto_chd: l.forecast_children,
        marcado_adt: l.checked_adults, marcado_chd: l.checked_children,
        real_adt: l.real_adults, real_chd: l.real_children,
        faturado_adt: l.billed_adults, faturado_chd: l.billed_children,
        preco_adt: l.price_adult, preco_chd: l.price_child, valor: l.value,
        avulsos: l.walkin_adults + l.walkin_children, dias_sem_real_informado: l.days_without_real,
      })),
    };
  });
  const diario = controlRows(month).map((r) => ({
    data: r.date, refeicao: r.meal, restaurante: rests[r.restaurant_id],
    previsto: r.forecast_adults + r.forecast_children, marcado: r.checked_adults + r.checked_children,
    real: r.real_adults === null && r.real_children === null ? null : (r.real_adults || 0) + (r.real_children || 0), fora_lista: r.fora_lista,
  }));
  const pensoes = db.prepare(`SELECT board, COUNT(*) reservas, SUM(adults) adultos, SUM(children) criancas FROM reservations
    WHERE status = 'ativa' AND checkout >= ? AND checkin <= ? GROUP BY board`).all(monthRange(month).first, monthRange(month).last);
  return { hoje: todayISO(), mes_referencia: month, regra_divisao: 'Di Giordana 60%, Paradiso 20%, Churrascaria Maestro 20% (café: Di Giordana 60%, Paradiso 40%)', resumo_mensal: resumoMensal, controle_diario_mes: diario, pensoes_no_mes: pensoes };
}

route('POST', '/api/ia', { roles: ['admin', 'supervisor', 'refeicao'] }, async ({ body, user, ip }) => {
  const question = String(body.question || '').trim().slice(0, 2000);
  if (!question) throw new HttpError(400, 'Escreva o que você quer saber.');
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(501, 'Assistente de IA ainda não configurado. Defina a variável ANTHROPIC_API_KEY no servidor.');
  const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : todayISO().slice(0, 7);
  const context = buildContext(month);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: 'Você é o analista de refeições de um hotel com três restaurantes. Responda em português do Brasil, de forma objetiva, '
        + 'usando somente os dados fornecidos em JSON. Quando fizer contas, mostre os números usados. Use tabelas em Markdown quando ajudar. '
        + 'Aponte diferenças entre previsto, marcado e real, desvios da divisão 60/20/20 e riscos de prejuízo. Se faltar dado, diga qual.',
      messages: [{ role: 'user', content: `Dados do sistema:\n${JSON.stringify(context)}\n\nPergunta: ${question}` }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new HttpError(502, 'Falha no serviço de IA: ' + (data.error && data.error.message ? data.error.message : resp.status));
  const answer = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  audit(user, 'ia_consulta', { month, question: question.slice(0, 200) }, ip);
  return { answer, month };
});
