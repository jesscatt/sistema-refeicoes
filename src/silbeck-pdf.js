'use strict';
/*
 * Leitura dos relatórios em PDF do Silbeck (SB Hotel) para o painel da TV:
 *  - "Previsão de Faturamento/Ocupação (01/10/2026 à 31/10/2026)": total de diárias (R$) e ocupação do mês
 *  - "Lista de Walk-ins/Reservas por Funcionário (dd/mm/aaaa à dd/mm/aaaa)": vendas por vendedor
 * O texto do PDF é extraído com o pdftotext (pacote poppler-utils).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function pdfText(buf) {
  if (!buf || buf.length < 5 || buf.slice(0, 5).toString() !== '%PDF-') throw new Error('O arquivo enviado não é um PDF.');
  const tmp = path.join(os.tmpdir(), `silbeck-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', tmp, '-'], { encoding: 'utf8', timeout: 20000, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('O leitor de PDF (pdftotext) não está instalado no servidor.');
    throw new Error('Não foi possível ler o PDF: ' + (e.message || e));
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

const num = (s) => { const n = Number(String(s).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const iso = (dmy) => { const m = String(dmy).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const NUM = /-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?/g;

function generatedAt(text) {
  const m = text.match(/Gerado por:.*?em\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
  return m ? `${iso(m[1])} ${m[2]}` : null;
}

// Previsão de Faturamento/Ocupação
function parseForecast(text) {
  const h = text.match(/Previs[ãa]o de Faturamento\/Ocupa[çc][ãa]o\s*\((\d{2}\/\d{2}\/\d{4})\s*[àa]\s*(\d{2}\/\d{2}\/\d{4})\)/i);
  if (!h) return null;
  const from = iso(h[1]), to = iso(h[2]);
  const totalLine = text.split('\n').find((l) => /^\s*Total\s+\d/.test(l));
  if (!totalLine) throw new Error('Não foi encontrada a linha de total no relatório de previsão.');
  const n = (totalLine.match(NUM) || []).map(num);
  if (n.length < 11) throw new Error('A linha de total do relatório de previsão está incompleta.');
  const [bedsTotal, bedsOcc, bedsPct, , adrBed, aptsTotal, aptsOcc, aptsPct, , adrApt, revenue] = n;
  const stay = (text.match(/Perman[êe]ncia M[ée]dia:\s*([\d,]+)/i) || [])[1];
  // linhas diárias (para o gráfico do mês)
  const days = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*(\d{2})\/(\d{2})\s+[A-ZÇ]{3}\s+(.*)$/);
    if (!m) continue;
    const v = (m[3].match(NUM) || []).map(num);
    if (v.length >= 11) days.push({ date: `${from.slice(0, 4)}-${m[2]}-${m[1]}`, apts_occ: v[6], apts_pct: v[7], revenue: v[10] });
  }
  return {
    type: 'previsao', month: from.slice(0, 7), period_from: from, period_to: to,
    revenue, apts_total: aptsTotal, apts_occ: aptsOcc, apts_pct: aptsPct, beds_total: bedsTotal, beds_occ: bedsOcc, beds_pct: bedsPct,
    adr_apt: adrApt, adr_bed: adrBed, stay_avg: stay ? num(stay) : null, days, generated_at: generatedAt(text),
  };
}

// Lista de Walk-ins/Reservas por Funcionário
function parseSales(text) {
  const h = text.match(/Walk-?\s?ins\/Reservas por Funcion[áa]rio\s*\((\d{2}\/\d{2}\/\d{4})\s*[àa]\s*(\d{2}\/\d{2}\/\d{4})\)/i);
  if (!h) return null;
  const sellers = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*([A-ZÀ-Ý][A-ZÀ-Ý0-9 .'\-]*?[A-ZÀ-Ý])\s{2,}(-?[\d.,]+(?:\s+-?[\d.,]+){20,})\s*$/);
    if (!m || /^TOTAIS?$/i.test(m[1].trim())) continue;
    const v = (m[2].match(NUM) || []).map(num);
    if (v.length < 21) continue;
    const t = v.slice(-7); // bloco "Total": RN total, RN período, Q. apto, PAX RN total, PAX RN período, Q. apto, diárias (R$)
    const w = v.slice(0, 7), r = v.slice(7, 14);
    sellers.push({ name: m[1].trim().replace(/\s+/g, ' '), room_nights: t[0], apts: t[2], pax_rn: t[3], value: t[6], walkin_value: w[6], reservas_value: r[6] });
  }
  const tl = (text.match(/Total L[íi]quido:\s*([\d.,]+)/i) || [])[1];
  return { type: 'vendas', period_from: iso(h[1]), period_to: iso(h[2]), sellers, total: tl ? num(tl) : sellers.reduce((s, x) => s + x.value, 0), generated_at: generatedAt(text) };
}

function parseSilbeckPdf(buf) {
  const text = pdfText(buf);
  const r = parseForecast(text) || parseSales(text);
  if (!r) throw new Error('Relatório não reconhecido. Envie a "Previsão de Faturamento/Ocupação" ou a "Lista de Walk-ins/Reservas por Funcionário" do Silbeck.');
  return r;
}

module.exports = { parseSilbeckPdf, parseForecast, parseSales, pdfText };
