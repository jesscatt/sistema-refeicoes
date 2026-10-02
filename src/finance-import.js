'use strict';
/*
 * Importação do histórico das planilhas antigas:
 *  A) "CONTROLE SEMANAL RESTAURANTES (PROJEÇÃO DO MÊS)": uma aba por mês com Di Giordana, Paradiso e
 *     Churrascaria (adultos e crianças por refeição, preço na fórmula), extras, Di Paolo, Botequim, Barril
 *     e o bloco "Projeção".
 *  B) "CONTROLE DE DIVISÃO <RESTAURANTE>": uma aba por mês, semanas lado a lado com DATA, REFEIÇÃO,
 *     PREVISÃO, ADULTOS e CRIANÇAS, totais do mês e extras.
 */
const { db, tx } = require('./db');
const { colName } = require('./xlsx-write');
const { readXlsxSheets } = require('./xlsx');
const { parseDate, isISODate } = require('./util');

const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const num = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : null;
};
const mealOf = (v) => {
  const s = norm(v);
  if (/^(quantidade )?cafe/.test(s)) return 'cafe';
  if (/^(quantidade )?almoco/.test(s)) return 'almoco';
  if (/^(quantidade )?jantar|^janta/.test(s)) return 'janta';
  return null;
};

// "Outubro 2025" -> {m: 10, y: 2025}; "Março " -> {m: 3}
function monthFromName(name) {
  const s = norm(name);
  const m = MONTHS.findIndex((x) => s.startsWith(x) || s.includes(x));
  if (m < 0) return null;
  const y = (s.match(/(20\d\d)/) || [])[1];
  return { m: m + 1, y: y ? Number(y) : null };
}

// Atribui o ano às abas sem ano seguindo a ordem das abas
function sheetMonths(sheets, fallbackYear) {
  let last = null;
  return sheets.map((sh) => {
    const mm = monthFromName(sh.name);
    if (!mm) return null;
    let y = mm.y;
    if (!y) y = last ? (mm.m <= last.m ? last.y + 1 : last.y) : fallbackYear;
    last = { m: mm.m, y };
    return `${y}-${String(mm.m).padStart(2, '0')}`;
  });
}

const cell = (sh, r, c) => (sh.rows[r] || [])[c];
const priceOf = (sh, r, c) => { // fórmula "A5*43" na célula ao lado do valor
  const f = sh.formulas[colName(c + 1) + (r + 1)];
  const m = f && f.replace(/\s/g, '').match(/^\(?[A-Z]+\d+\)?\*\(?([\d.]+)\)?$/i);
  if (m) return Number(m[1]);
  const q = num(cell(sh, r, c)), v = num(cell(sh, r, c + 1));
  return q && v ? Math.round((v / q) * 100) / 100 : null;
};

function restIds() {
  const rs = db.prepare('SELECT id, code, name FROM restaurants').all();
  const find = (re) => (rs.find((r) => re.test(norm(r.name))) || {}).id;
  return { DG: find(/giordana/), PAR: find(/paradiso/), MAE: find(/churrasc|maestro/) };
}

function detect(sheets) {
  for (const sh of sheets.slice(0, 3)) {
    for (const row of sh.rows.slice(0, 6)) {
      const t = row.map(norm);
      if (t.includes('data') && t.some((x) => x.startsWith('previsao'))) return 'divisao';
      if (t.some((x) => x.includes('giordana')) && t.some((x) => x.includes('paradiso'))) return 'controle';
    }
  }
  return null;
}

// ---------- A) Controle de faturamento ----------
const outletName = (t) => {
  const s = norm(t);
  if (/di paolo/.test(s)) return 'Di Paolo';
  if (/botequim/.test(s)) return 'Botequim';
  if (/barril|day.?use/.test(s)) return 'Day-use + almoço (Barril)';
  return String(t).trim().replace(/\s+/g, ' ').replace(/:$/, '');
};
const isMainLabel = (s) => /^(di giordana|paradiso|churrascaria|maestro|adultos|criancas|quantidade|total mes)/.test(s);

function parseControlSheet(sh, R) {
  const rows = sh.rows;
  const C = (r, c) => cell(sh, r, c);
  const restCols = [];
  for (let r = 0; r < rows.length; r++) {
    const cols = [];
    (rows[r] || []).forEach((v, c) => {
      const s = norm(v);
      if (/^di giordana/.test(s)) cols.push({ c, rest: R.DG });
      else if (/^paradiso/.test(s)) cols.push({ c, rest: R.PAR });
      else if (/^churrascaria|^maestro/.test(s)) cols.push({ c, rest: R.MAE });
    });
    if (cols.length >= 2) restCols.push({ r, cols });
  }
  const projRow = rows.findIndex((row) => norm((row || [])[0]).startsWith('projecao'));
  const stop = projRow >= 0 ? projRow : rows.length;
  const blocks = restCols.map((b, i) => ({ ...b, end: (restCols[i + 1] ? restCols[i + 1].r : rows.length), kind: projRow >= 0 && b.r > projRow ? 'projecao' : 'realizado' }));
  // Quantidades: rótulo "QUANTIDADE ..." e, logo abaixo, uma ou mais linhas de quantidade (uma por preço)
  const lines = [];
  for (const b of blocks) {
    for (const { c, rest } of b.cols) {
      let who = 'adults';
      const seen = {};
      for (let r = b.r + 1; r < b.end; r++) {
        const v = norm(C(r, c));
        if (v === 'adultos') who = 'adults';
        else if (v.startsWith('criancas')) who = 'children';
        const meal = mealOf(C(r, c));
        if (!meal || !v.startsWith('quantidade')) continue;
        const k = `${meal}|${who}`;
        if (seen[k]) continue;
        seen[k] = 1;
        const parts = [];
        for (let rr = r + 1; rr < b.end && typeof C(rr, c) === 'number'; rr++) parts.push({ qty: C(rr, c), price: priceOf(sh, rr, c) });
        if (!parts.length) continue;
        const qty = parts.reduce((s2, x) => s2 + x.qty, 0);
        const value = Math.round(parts.reduce((s2, x) => s2 + x.qty * (x.price || 0), 0) * 100) / 100;
        lines.push({ kind: b.kind, restaurant_id: rest, meal, who, qty, value, price: parts[parts.length - 1].price, prices: parts.map((x) => x.price) });
      }
    }
  }
  // Seções de extras e outros pontos (antes de "Projeção"), em cada coluna (A = Di Giordana/outros, D = Paradiso, G = Churrascaria)
  const entries = [];
  const first = blocks.length ? blocks[0].r : 0;
  const groups = blocks.length ? blocks[0].cols : [{ c: 0, rest: R.DG }];
  for (const { c, rest } of groups) {
    let title = null, header = null;
    for (let r = first + 1; r < stop; r++) {
      const raw = C(r, c);
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const t = norm(raw);
      if (isMainLabel(t)) { title = null; header = null; continue; }
      if (t === 'refeicao') {
        const h1 = norm(C(r, c + 1));
        header = { unit: h1.startsWith('valor'), value: h1 === 'total' };
        if (!title) title = { kind: c === 0 ? 'outro' : 'extra', outlet: c === 0 ? 'Day-use + almoço (Barril)' : 'Extras', restaurant_id: c === 0 ? null : rest };
        continue;
      }
      if (/^(total|soma)/.test(t)) { header = null; title = null; continue; }
      if (/^extras/.test(t)) { title = { kind: 'extra', outlet: c === 0 ? 'Extras Di Giordana' : 'Extras', restaurant_id: c === 0 ? R.DG : rest, direct: true }; header = null; continue; }
      if (title && (header || title.direct)) {
        let unit = null, qty = null, value = null;
        if (header && header.unit) { unit = num(C(r, c + 1)); qty = num(C(r, c + 2)); value = unit != null && qty != null ? Math.round(unit * qty * 100) / 100 : null; }
        else { value = num(C(r, c + 1)); }
        if (value) { entries.push({ kind: title.kind, restaurant_id: title.restaurant_id, outlet: title.outlet, item: String(raw).trim(), unit_price: unit, qty, value }); continue; }
        if (header || (title.direct && (mealOf(raw) || /chd/.test(t)))) continue; // item sem valor
      }
      // texto solto = título de uma nova seção
      const isExtraSec = c !== 0;
      title = { kind: isExtraSec ? 'extra' : 'outro', outlet: outletName(raw), restaurant_id: isExtraSec ? rest : null };
      header = null;
    }
  }
  // Conferência com os totais da planilha (valores calculados pelo Excel): diferenças viram "Ajuste da planilha"
  const realLines = lines.filter((l) => l.kind === 'realizado');
  const warnings = [];
  const brl = (v) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (blocks.length && realLines.length) {
    for (const { c, rest } of blocks[0].cols) {
      let tm = null;
      for (let r = blocks[0].r; r < stop; r++) if (/^total mes \(adulto/.test(norm(C(r, c)).replace(/\s+/g, ' '))) { tm = num(C(r + 1, c)); if (tm == null) tm = num(C(r, c + 1)); break; }
      if (tm == null) continue;
      const base = realLines.filter((l) => l.restaurant_id === rest).reduce((s2, l) => s2 + l.value, 0);
      const mine = base + entries.filter((e) => e.restaurant_id === rest).reduce((s2, e) => s2 + e.value, 0);
      const d = Math.round((tm - mine) * 100) / 100;
      // algumas abas somam os extras no total do restaurante, outras só no total geral
      if (Math.abs(d) >= 0.01 && Math.abs(tm - base) >= 0.01) {
        entries.push({ kind: 'extra', restaurant_id: rest, outlet: 'Ajuste da planilha', item: 'Diferença no total do restaurante', unit_price: null, qty: null, value: d });
        warnings.push(`${sh.name.trim()}: diferença de ${brl(d)} no total do restaurante; lançada como "Ajuste da planilha".`);
      }
    }
    let grand = null;
    for (let r = blocks[0].r; r < stop; r++) { const row = rows[r] || []; if (/^total$/.test(norm(row[0])) && typeof row[1] === 'number' && row[1] > 1000) grand = row[1]; }
    if (grand != null) {
      const all = realLines.reduce((s2, l) => s2 + l.value, 0) + entries.reduce((s2, e) => s2 + e.value, 0);
      const d = Math.round((grand - all) * 100) / 100;
      if (Math.abs(d) >= 0.01) {
        entries.push({ kind: 'outro', restaurant_id: null, outlet: 'Ajuste da planilha', item: 'Diferença no total geral', unit_price: null, qty: null, value: d });
        warnings.push(`${sh.name.trim()}: diferença de ${brl(d)} no total geral; lançada como "Ajuste da planilha".`);
      }
    }
  }
  return { lines, entries, warnings };
}

// ---------- B) Divisão de um restaurante ----------
function parseDivisionSheet(sh, month) {
  const rows = sh.rows;
  const hdrRow = rows.findIndex((row) => (row || []).some((v) => norm(v) === 'data'));
  if (hdrRow < 0) return { days: [], totals: [], extras: [], warnings: [] };
  const starts = (rows[hdrRow] || []).map((v, c) => (norm(v) === 'data' ? c : -1)).filter((c) => c >= 0);
  const [y, m] = month.split('-').map(Number);
  const days = [], warnings = [];
  for (const c of starts) {
    let date = null;
    for (let r = hdrRow + 1; r < rows.length; r++) {
      const a = cell({ rows }, r, c), bm = cell({ rows }, r, c + 1);
      if (/informa/.test(norm(a)) || /informa/.test(norm(bm)) || norm(bm) === 'refeicao') break;
      if (a != null && a !== '') {
        let iso = typeof a === 'number' ? parseDate(a) : null;
        const mt = String(a).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (mt) iso = `${mt[3]}-${mt[2].padStart(2, '0')}-${mt[1].padStart(2, '0')}`;
        if (iso && isISODate(iso)) {
          if (Number(iso.slice(0, 4)) !== y || Number(iso.slice(5, 7)) !== m) {
            const fixed = `${month}-${iso.slice(8, 10)}`;
            warnings.push(`${sh.name.trim()}: data ${iso.split('-').reverse().join('/')} fora do mês; considerada ${fixed.split('-').reverse().join('/')}`);
            iso = isISODate(fixed) ? fixed : null;
          }
          date = iso;
        }
      }
      const meal = mealOf(bm);
      if (!date || !meal) continue;
      const fc = num(cell({ rows }, r, c + 2)), ad = num(cell({ rows }, r, c + 3)), ch = num(cell({ rows }, r, c + 4));
      if (fc == null && ad == null && ch == null) continue;
      days.push({ date, meal, forecast: fc == null ? null : Math.round(fc), adults: Math.round(ad || 0), children: Math.round(ch || 0) });
    }
  }
  // Totais do mês ("Informações Total Mês" e "... - CRIANÇAS") e extras
  const totals = [], extras = [];
  let mode = null;
  for (let r = 0; r < rows.length; r++) {
    const a = norm(cell({ rows }, r, 0));
    if (/^informacoes total mes - criancas/.test(a)) { mode = 'children'; continue; }
    if (/^informacoes total mes/.test(a)) { mode = 'adults'; continue; }
    if (/^extras/.test(a)) { mode = 'extra'; continue; }
    if (/^informacoes total/.test(a)) { mode = null; continue; }
    if (!mode || a === 'refeicao' || a.startsWith('total')) continue;
    const meal = mealOf(cell({ rows }, r, 0));
    const unit = num(cell({ rows }, r, 1)), qty = num(cell({ rows }, r, 2));
    if (mode === 'extra') {
      const item = String(cell({ rows }, r, 0)).trim();
      if ((meal || /chd/.test(a)) && unit && qty && !extras.some((e) => e.item === item && e.unit_price === unit && e.qty === qty)) extras.push({ item, unit_price: unit, qty, value: Math.round(unit * qty * 100) / 100 });
      continue;
    }
    if (meal && qty != null) {
      // a mesma refeição pode aparecer em mais de uma linha (troca de preço no mês)
      const t = totals.find((x) => x.meal === meal && x.who === mode && x.row === r - 1);
      if (t) { t.qty += qty; t.value += qty * (unit || 0); t.price = unit; t.row = r; }
      else totals.push({ meal, who: mode, qty, price: unit, value: qty * (unit || 0), row: r });
    }
  }
  return { days, totals, extras, warnings };
}

// Lê o arquivo e monta a prévia (nada é gravado)
function parseFile(buf, filename = '', opts = {}) {
  const sheets = readXlsxSheets(buf);
  const type = detect(sheets);
  if (!type) throw new Error('Não reconheci a planilha. Envie o "Controle semanal dos restaurantes" ou o "Controle de divisão" de um restaurante.');
  const R = restIds();
  const yearHint = Number((String(filename).match(/(20\d\d)/) || [])[1]) || new Date().getFullYear();
  const ms = sheetMonths(sheets, yearHint);
  const out = { type, months: [], warnings: [] };
  if (type === 'controle') {
    sheets.forEach((sh, i) => {
      if (!ms[i]) { out.warnings.push(`Aba "${sh.name}" ignorada (nome não é um mês).`); return; }
      const p = parseControlSheet(sh, R);
      if (!p.lines.length) { out.warnings.push(`Aba "${sh.name}" sem quantidades.`); return; }
      out.warnings.push(...p.warnings);
      out.months.push({ month: ms[i], sheet: sh.name.trim(), lines: p.lines, entries: p.entries });
    });
  } else {
    const n = norm(filename + ' ' + sheets.map((s) => s.name).join(' '));
    let rest = Number(opts.restaurant_id) || (/paradiso/.test(n) ? R.PAR : /churrasc|maestro/.test(n) ? R.MAE : /giordana/.test(n) ? R.DG : null);
    if (!rest) throw new Error('Não identifiquei o restaurante pelo nome do arquivo. Escolha o restaurante e envie de novo.');
    out.restaurant_id = rest;
    sheets.forEach((sh, i) => {
      if (!ms[i]) { out.warnings.push(`Aba "${sh.name}" ignorada (nome não é um mês).`); return; }
      const p = parseDivisionSheet(sh, ms[i]);
      out.warnings.push(...p.warnings);
      if (!p.days.length && !p.totals.length) return;
      out.months.push({ month: ms[i], sheet: sh.name.trim(), ...p });
    });
  }
  out.months.sort((a, b) => a.month.localeCompare(b.month));
  return out;
}

// Grava (substitui o que veio antes da mesma planilha para os mesmos meses)
function commitFile(parsed, user) {
  const res = { months: parsed.months.map((m) => m.month), daily: 0, monthly: 0, entries: 0, prices: 0 };
  tx(() => {
    if (parsed.type === 'controle') {
      const insM = db.prepare(`INSERT INTO hist_month(month, restaurant_id, meal, kind, adults, children, price_adult, price_child, value_adults, value_children, price_note, source) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'planilha-controle')
        ON CONFLICT(month, restaurant_id, meal, kind) DO UPDATE SET adults = excluded.adults, children = excluded.children, price_adult = excluded.price_adult, price_child = excluded.price_child,
          value_adults = excluded.value_adults, value_children = excluded.value_children, price_note = excluded.price_note, source = excluded.source`);
      const insE = db.prepare("INSERT INTO finance_entries(month, restaurant_id, kind, outlet, item, unit_price, qty, value, source, user_id) VALUES (?,?,?,?,?,?,?,?, 'planilha-controle', ?)");
      const priceRows = [];
      for (const m of parsed.months) {
        db.prepare("DELETE FROM finance_entries WHERE month = ? AND source = 'planilha-controle'").run(m.month);
        const agg = new Map();
        for (const l of m.lines) {
          if (!l.restaurant_id) continue;
          const k = `${l.kind}|${l.restaurant_id}|${l.meal}`;
          const a = agg.get(k) || { kind: l.kind, restaurant_id: l.restaurant_id, meal: l.meal, adults: 0, children: 0, pa: null, pc: null, va: null, vc: null, notes: [] };
          a[l.who] = l.qty;
          if (l.who === 'adults') { a.pa = l.price; a.va = l.value; } else { a.pc = l.price; a.vc = l.value; }
          if (l.prices.length > 1) a.notes.push(`${l.who === 'adults' ? 'ADT' : 'CHD'}: ${l.prices.join(' e ')}`);
          agg.set(k, a);
        }
        for (const a of agg.values()) {
          insM.run(m.month, a.restaurant_id, a.meal, a.kind, Math.round(a.adults), Math.round(a.children), a.pa, a.pc ?? (a.pa != null ? a.pa / 2 : null), a.va, a.vc, a.notes.join(' · ') || null);
          res.monthly++;
          if (a.kind === 'realizado' && a.pa) priceRows.push({ month: m.month, restaurant_id: a.restaurant_id, meal: a.meal, pa: a.pa, pc: a.pc ?? a.pa / 2 });
        }
        for (const e of m.entries) { insE.run(m.month, e.restaurant_id, e.kind, e.outlet, e.item, e.unit_price, e.qty, e.value, user ? user.id : null); res.entries++; }
      }
      // Histórico de preços: registra a vigência quando o preço muda
      priceRows.sort((a, b) => a.month.localeCompare(b.month));
      for (const p of priceRows) {
        const cur = db.prepare('SELECT * FROM price_history WHERE restaurant_id = ? AND meal = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1').get(p.restaurant_id, p.meal, p.month);
        if (cur && Math.abs(cur.price_adult - p.pa) < 0.005 && Math.abs(cur.price_child - p.pc) < 0.005) continue;
        const ref = cur || db.prepare('SELECT * FROM price_history WHERE restaurant_id = ? AND meal = ? ORDER BY valid_from DESC LIMIT 1').get(p.restaurant_id, p.meal) || { extra_adult: 0, extra_child: 0 };
        db.prepare(`INSERT INTO price_history(restaurant_id, meal, valid_from, price_adult, price_child, extra_adult, extra_child, updated_by) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(restaurant_id, meal, valid_from) DO UPDATE SET price_adult = excluded.price_adult, price_child = excluded.price_child`)
          .run(p.restaurant_id, p.meal, p.month, p.pa, p.pc, ref.extra_adult, ref.extra_child, user ? user.id : null);
        res.prices++;
        // o mês seguinte volta ao preço que valia depois (se houver uma vigência posterior já cadastrada, ela continua valendo)
      }
    } else {
      const rest = parsed.restaurant_id;
      const insD = db.prepare(`INSERT INTO hist_daily(date, restaurant_id, meal, forecast, adults, children, source) VALUES (?,?,?,?,?,?, 'planilha-divisao')
        ON CONFLICT(date, restaurant_id, meal) DO UPDATE SET forecast = excluded.forecast, adults = excluded.adults, children = excluded.children, source = excluded.source`);
      for (const m of parsed.months) {
        db.prepare("DELETE FROM hist_daily WHERE restaurant_id = ? AND substr(date, 1, 7) = ?").run(rest, m.month);
        for (const d of m.days) { insD.run(d.date, rest, d.meal, d.forecast, d.adults, d.children); res.daily++; }
        // total do mês da planilha de divisão só entra se o controle de faturamento ainda não foi importado
        const agg = {};
        for (const t of m.totals) { agg[t.meal] = agg[t.meal] || { adults: 0, children: 0, pa: null, pc: null, va: null, vc: null }; agg[t.meal][t.who] = t.qty; if (t.who === 'adults') { agg[t.meal].pa = t.price; agg[t.meal].va = t.value; } else { agg[t.meal].pc = t.price; agg[t.meal].vc = t.value; } }
        for (const [meal, a] of Object.entries(agg)) {
          const ex = db.prepare("SELECT source FROM hist_month WHERE month = ? AND restaurant_id = ? AND meal = ? AND kind = 'realizado'").get(m.month, rest, meal);
          if (ex && ex.source === 'planilha-controle') continue;
          db.prepare(`INSERT INTO hist_month(month, restaurant_id, meal, kind, adults, children, price_adult, price_child, value_adults, value_children, source) VALUES (?,?,?, 'realizado', ?,?,?,?,?,?, 'planilha-divisao')
            ON CONFLICT(month, restaurant_id, meal, kind) DO UPDATE SET adults = excluded.adults, children = excluded.children, price_adult = excluded.price_adult, price_child = excluded.price_child,
              value_adults = excluded.value_adults, value_children = excluded.value_children, source = excluded.source`)
            .run(m.month, rest, meal, Math.round(a.adults), Math.round(a.children), a.pa, a.pc, a.va, a.vc);
          res.monthly++;
        }
        // extras da planilha de divisão só se o controle não trouxe extras desse restaurante no mês
        db.prepare("DELETE FROM finance_entries WHERE month = ? AND restaurant_id = ? AND source = 'planilha-divisao'").run(m.month, rest);
        const hasCtl = db.prepare("SELECT 1 FROM finance_entries WHERE month = ? AND restaurant_id = ? AND kind = 'extra' AND source = 'planilha-controle'").get(m.month, rest);
        if (!hasCtl) for (const e of m.extras) {
          db.prepare("INSERT INTO finance_entries(month, restaurant_id, kind, outlet, item, unit_price, qty, value, source, user_id) VALUES (?,?, 'extra', 'Extras', ?,?,?,?, 'planilha-divisao', ?)")
            .run(m.month, rest, e.item, e.unit_price, e.qty, e.value, user ? user.id : null);
          res.entries++;
        }
      }
    }
  });
  return res;
}

module.exports = { parseFile, commitFile, detect, monthFromName, sheetMonths };
