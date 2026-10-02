'use strict';
// Importação de reservas (Excel/CSV/API) com detecção automática das colunas.
// Formato de referência: planilha "DIVISÃO" do Resort Termas Romanas
//   Reserva ("50893 ANR TUR") | Entrada | Saída | Pensão | Apto ("101C") | Pax (total, inclui crianças) | Chd
//   + uma coluna por refeição/restaurante/dia ("JANTAR DI GIORDANA QUARTA-FEIRA 30/09") com o pax enviado.
const { db, tx, notify, maxPaxRoom } = require('./db');
const { normKey, parseDate, parseBoard, toInt, BOARDS, roomKey, normRoom, addDays, MEALS, isISODate, roomError, canonRoom } = require('./util');
const { syncMany, isEligible, boardHas } = require('./meals');

// Apelidos aceitos para cada coluna (comparados sem acento, minúsculo, sem espaços)
const FIELDS = {
  reservation_number: ['reserva', 'nreserva', 'nreserv', 'numeroreserva', 'numerodareserva', 'numreserva', 'nres', 'codreserva', 'codigoreserva', 'localizador', 'reservation', 'reservationnumber', 'idreserva', 'res'],
  guest_name: ['nomecompleto', 'nome', 'hospede', 'nomehospede', 'nomedohospede', 'cliente', 'nomecliente', 'titular', 'guest', 'guestname', 'name', 'grupo', 'agencia'],
  checkin: ['entrada', 'dataentrada', 'datadeentrada', 'dtentrada', 'checkin', 'chegada', 'datachegada', 'arrival', 'in'],
  checkout: ['saida', 'datasaida', 'datadesaida', 'dtsaida', 'checkout', 'partida', 'datapartida', 'departure', 'out'],
  room: ['quarto', 'numeroquarto', 'numerodoquarto', 'nquarto', 'uh', 'apto', 'apartamento', 'room', 'roomnumber'],
  board: ['pensao', 'tipopensao', 'tipodepensao', 'regime', 'regimealimentar', 'plano', 'board', 'mealplan'],
  adults: ['adultos', 'adulto', 'adt', 'adl', 'adults', 'qtdadultos', 'qtdeadultos'],
  pax: ['pessoas', 'qtdpessoas', 'qtdepessoas', 'quantidadepessoas', 'pax', 'hospedes', 'qtdhospedes', 'totalpax'],
  children: ['criancas', 'crianca', 'chd', 'chds', 'children', 'qtdcriancas', 'qtdecriancas', 'cri', 'crian'],
};
const CONTAINS = {
  reservation_number: ['reserva'],
  checkin: ['entrada', 'checkin', 'chegada'],
  checkout: ['saida', 'checkout', 'partida'],
  room: ['quarto', 'apto'],
  board: ['pensao', 'regime'],
  children: ['crianc', 'chd'],
  adults: ['adult'],
  pax: ['pessoas', 'pax'],
  guest_name: ['nome', 'hospede'],
};
const ORDER = ['reservation_number', 'checkin', 'checkout', 'room', 'board', 'children', 'adults', 'pax', 'guest_name'];

function mapHeaders(header) {
  const keys = header.map(normKey);
  const map = {};
  const used = new Set();
  // títulos longos (ex.: "JANTAR DI GIORDANA 30/09") não são colunas de dados da reserva
  const isMealHeader = (k) => /^(cafe|almoco|jantar|janta)/.test(k) && k.length > 8;
  for (const f of ORDER) {
    const i = keys.findIndex((k, idx) => !used.has(idx) && k && FIELDS[f].includes(k));
    if (i >= 0) { map[f] = i; used.add(i); }
  }
  for (const f of ORDER) {
    if (map[f] !== undefined) continue;
    const i = keys.findIndex((k, idx) => !used.has(idx) && k && !isMealHeader(k) && CONTAINS[f].some((c) => k.includes(c)));
    if (i >= 0) { map[f] = i; used.add(i); }
  }
  return map;
}

function findHeaderRow(rows) {
  let best = { idx: -1, score: 0, map: {} };
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const map = mapHeaders((rows[i] || []).map((v) => (v == null ? '' : String(v))));
    const score = Object.keys(map).length;
    if (score > best.score) best = { idx: i, score, map };
  }
  return best;
}

const REQUIRED = ['reservation_number', 'checkin', 'checkout', 'room', 'board'];
const LABELS = {
  reservation_number: 'Nº da reserva', guest_name: 'Nome', checkin: 'Entrada', checkout: 'Saída',
  room: 'Apartamento', board: 'Pensão', adults: 'Adultos', pax: 'Pessoas (total)', children: 'Crianças',
};

// "50893 ANR TUR" -> { number: "50893", name: "ANR TUR" } · "59.699 EMANUEL VIAJES" -> "59699"
function splitReservation(v) {
  if (typeof v === 'number') return { number: String(Math.trunc(v)), name: '' };
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  const m = s.match(/^(\d[\d.]*)(?:\s*[-–:]\s*|\s+|$)(.*)$/);
  if (m) return { number: m[1].replace(/\./g, ''), name: m[2].trim() };
  return { number: s.replace(/\.0$/, ''), name: '' };
}

// Normaliza e valida um registro vindo de qualquer fonte
function normalizeRecord(raw) {
  const errors = [];
  const sr = splitReservation(raw.reservation_number);
  const rec = {
    reservation_number: sr.number,
    guest_name: String(raw.guest_name ?? '').trim().replace(/\s+/g, ' ') || sr.name,
    checkin: isISODate(raw.checkin) ? raw.checkin : parseDate(raw.checkin),
    checkout: isISODate(raw.checkout) ? raw.checkout : parseDate(raw.checkout),
    room: normRoom(raw.room),
    board: parseBoard(raw.board),
    children: toInt(raw.children, 0),
    adults: null,
    lunch_on_arrival: raw.lunch_on_arrival ? 1 : 0,
  };
  if (!rec.guest_name && rec.reservation_number) rec.guest_name = `Reserva ${rec.reservation_number}`;
  if (raw.adults !== undefined && raw.adults !== null && raw.adults !== '') rec.adults = toInt(raw.adults, 0);
  else if (raw.pax !== undefined && raw.pax !== null && raw.pax !== '') rec.adults = Math.max(0, toInt(raw.pax, 0) - rec.children);
  else rec.adults = 1;
  if (!rec.reservation_number) errors.push('sem número de reserva');
  if (!rec.checkin) errors.push('data de entrada inválida');
  if (!rec.checkout) errors.push('data de saída inválida');
  if (rec.checkin && rec.checkout && rec.checkout < rec.checkin) errors.push('saída antes da entrada');
  const re = roomError(rec.room);
  if (re) errors.push(re); else rec.room = canonRoom(rec.room);
  if (!rec.board) errors.push(`pensão "${raw.board ?? ''}" não reconhecida (use CM, MAP, MAPA ou FAP)`);
  if (rec.adults + rec.children === 0) errors.push('quantidade de pessoas zerada');
  const max = maxPaxRoom();
  if (rec.adults + rec.children > max) errors.push(`${rec.adults + rec.children} pessoas no apartamento; a política do resort é de no máximo ${max} por apartamento`);
  return { rec, errors };
}

// ---------- Datas com dia e mês trocados ----------
// O Excel às vezes grava "01/10/2026" como 10 de janeiro (dia/mês invertidos). Para datas
// ambíguas (dia ≤ 12) escolhemos a leitura mais próxima das demais datas da planilha.
function serialToISO(v) { return typeof v === 'number' ? parseDate(v) : null; }
function swapISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (d > 12 || d === m) return null;
  const s = `${y}-${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
  return isISODate(s) ? s : null;
}
function daysAbs(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.abs(Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000;
}
function dateCandidates(v) {
  if (typeof v === 'number') {
    const iso = serialToISO(v);
    if (!iso) return [];
    const sw = swapISO(iso);
    return sw ? [iso, sw] : [iso];
  }
  const iso = parseDate(v);
  return iso ? [iso] : [];
}
function medianDate(list) {
  if (!list.length) return null;
  const s = [...list].sort();
  return s[Math.floor(s.length / 2)];
}

// ---------- Colunas de divisão (refeição + restaurante + dia) ----------
function restaurantMatchers() {
  return db.prepare('SELECT id, code, name FROM restaurants WHERE active = 1').all().map((r) => {
    const toks = String(r.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 4);
    return { ...r, toks: [...toks, String(r.code).toUpperCase()] };
  });
}

function parseMealHeader(text, matchers, refDate) {
  const s = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const meal = /^\s*CAFE/.test(s) ? 'cafe' : /^\s*ALMOCO/.test(s) ? 'almoco' : /^\s*JANTA/.test(s) ? 'janta' : null;
  if (!meal) return null;
  const words = s.split(/[^A-Z]+/);
  const rest = matchers.find((r) => r.toks.some((t) => t.length >= 4 ? s.includes(t) : words.includes(t)));
  const dm = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!rest || !dm) return null;
  const dd = +dm[1], mm = +dm[2];
  let date;
  if (dm[3]) { let y = +dm[3]; if (y < 100) y += 2000; date = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; }
  else {
    // sem ano: o mais próximo das datas das reservas (cobre virada de ano)
    const y0 = refDate ? +refDate.slice(0, 4) : new Date().getFullYear();
    date = [y0 - 1, y0, y0 + 1].map((y) => `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`)
      .filter(isISODate).sort((a, b) => (refDate ? daysAbs(a, refDate) - daysAbs(b, refDate) : 0))[0];
  }
  if (!isISODate(date)) return null;
  return { meal, restaurant_id: rest.id, restaurant_code: rest.code, date };
}

function parseRows(rows) {
  const head = findHeaderRow(rows);
  const missing = REQUIRED.filter((f) => head.map[f] === undefined);
  if (head.idx < 0 || missing.length) {
    return { ok: false, error: `Não encontrei as colunas: ${missing.map((f) => LABELS[f]).join(', ')}. Verifique o cabeçalho da planilha.`, headerRow: head.idx, mapping: head.map };
  }
  const header = rows[head.idx];
  const dataRows = [];
  for (let i = head.idx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) continue;
    dataRows.push({ i, r });
  }
  // datas de referência = as que não deixam dúvida
  const sure = [];
  for (const { r } of dataRows) for (const f of ['checkin', 'checkout']) {
    const c = dateCandidates(r[head.map[f]]);
    if (c.length === 1) sure.push(c[0]);
  }
  const ref = medianDate(sure);

  // colunas de divisão: procura títulos de refeição nas linhas acima e na própria linha de cabeçalho
  const matchers = restaurantMatchers();
  const used = new Set(Object.values(head.map));
  const distCols = [];
  const width = Math.max(...rows.slice(0, head.idx + 1).map((x) => (x || []).length), 0);
  for (let c = 0; c < width; c++) {
    if (used.has(c)) continue;
    for (let rIdx = head.idx; rIdx >= 0; rIdx--) {
      const p = parseMealHeader((rows[rIdx] || [])[c], matchers, ref);
      if (p) { distCols.push({ col: c, ...p, title: String(rows[rIdx][c]) }); break; }
    }
  }

  const out = [];
  for (const { i, r } of dataRows) {
    const raw = {};
    for (const [f, idx] of Object.entries(head.map)) raw[f] = r[idx];
    const notes = [];
    let dateFixed = false, boardGuess = null;
    // escolhe a melhor leitura das datas (entrada <= saída, perto das demais)
    const ci = dateCandidates(raw.checkin), co = dateCandidates(raw.checkout);
    if (ci.length && co.length) {
      let best = null;
      for (const a of ci) for (const b of co) {
        if (b < a) continue;
        const score = (ref ? daysAbs(a, ref) + daysAbs(b, ref) : 0) + daysAbs(a, b) / 1000;
        if (!best || score < best.score) best = { a, b, score };
      }
      if (best) {
        if (best.a !== ci[0] || best.b !== co[0]) dateFixed = true;
        raw.checkin = best.a; raw.checkout = best.b;
      }
    }
    const dist = [];
    for (const dc of distCols) {
      const v = r[dc.col];
      const n = typeof v === 'number' ? v : toInt(v, 0);
      if (n > 0) dist.push({ date: dc.date, meal: dc.meal, restaurant_id: dc.restaurant_id, pax: n });
    }
    // planilha manda almoço no dia da chegada -> exceção do grupo
    if (dist.some((d) => d.meal === 'almoco' && d.date === raw.checkin)) raw.lunch_on_arrival = 1;
    const { rec, errors } = normalizeRecord(raw);
    // se a pensão veio errada mas a divisão mostra as refeições, sugere a pensão pelas colunas
    if (!rec.board && dist.length) {
      const ms = new Set(dist.map((d) => d.meal));
      const guess = ms.has('almoco') && ms.has('janta') ? 'FAP' : ms.has('janta') ? 'MAP' : ms.has('almoco') ? 'MAPA' : 'CM';
      boardGuess = guess;
      notes.push(`pensão "${raw.board}" inválida; pela divisão parece ${guess}`);
    }
    out.push({ line: i + 1, ...rec, errors, notes, dist, date_fixed: dateFixed, board_guess: boardGuess });
  }
  const mapping = Object.fromEntries(Object.entries(head.map).map(([f, idx]) => [f, { label: LABELS[f], column: String(header[idx]) }]));
  const slots = [...new Map(distCols.map((d) => [`${d.date}|${d.meal}`, { date: d.date, meal: d.meal }])).values()];
  return { ok: true, headerRow: head.idx + 1, mapping, rows: out, distribution: distCols.length ? { columns: distCols.map(({ col, ...x }) => x), slots } : null };
}

// Confere a divisão da planilha contra as regras de pensão
function checkDistribution(rows, slots) {
  if (!slots || !slots.length) return;
  const fmt = (list) => list.sort((a, b) => a.date.localeCompare(b.date)).map((d) => `${label(d.meal)} ${br(d.date)}`).join(', ');
  for (const r of rows) {
    if (r.errors && r.errors.length) continue;
    const res = { ...r, status: 'ativa' };
    const have = new Set((r.dist || []).map((d) => `${d.date}|${d.meal}`));
    const notIncluded = [], outOfStay = [], missing = [];
    for (const d of r.dist || []) {
      if (isEligible(res, d.date, d.meal)) continue;
      (boardHas(r.board, d.meal) ? outOfStay : notIncluded).push(d);
    }
    for (const s of slots) if (isEligible(res, s.date, s.meal) && !have.has(`${s.date}|${s.meal}`)) missing.push(s);
    const warn = [];
    if (notIncluded.length) warn.push(`planilha dá refeição que a pensão ${r.board} não inclui: ${fmt(notIncluded)}`);
    if (outOfStay.length) warn.push(`planilha dá refeição fora dos dias da estadia: ${fmt(outOfStay)}`);
    if (missing.length) warn.push(`pensão inclui, mas a planilha não mandou: ${fmt(missing)}`);
    if (warn.length) r.notes = [...(r.notes || []), ...warn];
  }
}
const label = (m) => ({ cafe: 'café', almoco: 'almoço', janta: 'jantar' }[m]);
const br = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

/*
 * Plano de importação (usado na conferência e na gravação).
 * Chave = número da reserva + quarto. Dentro da mesma reserva (grupo), quartos que sumiram e
 * quartos novos com as mesmas datas e pax são tratados como TROCA DE QUARTO.
 */
function planImport(records, { cancelMissing = false } = {}) {
  const items = [];
  const seen = new Map();
  for (const rec of records) {
    if (rec.errors && rec.errors.length) { items.push({ rec, action: 'erro' }); continue; }
    const k = `${rec.reservation_number}|${roomKey(rec.room)}`;
    if (seen.has(k)) { const prev = seen.get(k); prev.action = 'duplicada'; prev.rec.warning = 'reserva e apartamento repetidos na planilha (prevalece a última linha)'; }
    const it = { rec, action: null };
    seen.set(k, it);
    items.push(it);
  }
  const byNum = new Map();
  for (const it of items) if (!it.action) {
    if (!byNum.has(it.rec.reservation_number)) byNum.set(it.rec.reservation_number, []);
    byNum.get(it.rec.reservation_number).push(it);
  }
  const removed = [];
  const fields = ['guest_name', 'checkin', 'checkout', 'room', 'board', 'adults', 'children', 'lunch_on_arrival'];
  const getAll = db.prepare('SELECT * FROM reservations WHERE reservation_number = ?');
  for (const [num, list] of byNum) {
    const existing = getAll.all(num);
    const free = new Set(existing.map((e) => e.id));
    const pending = [];
    for (const it of list) {
      const ex = existing.find((e) => free.has(e.id) && roomKey(e.room) === roomKey(it.rec.room));
      if (ex) { it.existing = ex; free.delete(ex.id); } else pending.push(it);
    }
    // troca de quarto: mesmo grupo, mesmas datas e pax
    for (const it of pending) {
      const r = it.rec;
      const ex = existing.find((e) => free.has(e.id) && e.status === 'ativa' && e.checkin === r.checkin && e.checkout === r.checkout && e.adults + e.children === r.adults + r.children);
      if (ex) { it.existing = ex; free.delete(ex.id); }
    }
    const stillNew = pending.filter((it) => !it.existing);
    const leftActive = existing.filter((e) => free.has(e.id) && e.status === 'ativa');
    if (stillNew.length === 1 && leftActive.length === 1) { stillNew[0].existing = leftActive[0]; free.delete(leftActive[0].id); }
    for (const it of list) {
      const ex = it.existing;
      if (!ex) { it.action = 'nova'; continue; }
      const changed = fields.some((k) => (k === 'room' ? roomKey(ex.room) !== roomKey(it.rec.room) : String(ex[k] ?? 0) !== String(it.rec[k] ?? 0))) || ex.status !== 'ativa';
      it.action = changed ? 'alterada' : 'igual';
      if (roomKey(ex.room) !== roomKey(it.rec.room)) it.old_room = ex.room;
    }
    if (cancelMissing) for (const e of existing) if (free.has(e.id) && e.status === 'ativa') removed.push(e);
  }
  return { items, removed };
}

/*
 * Grava registros. Detecta troca de quarto e avisa recepção, refeição e restaurantes.
 * opts.cancelMissing: cancela quartos de reservas presentes na planilha que não vieram mais.
 * opts.useDistribution: aplica a divisão que veio na planilha (trava o restaurante de cada refeição).
 */
function upsertReservations(records, { source = 'excel', user = null, cancelMissing = false, useDistribution = false } = {}) {
  const result = { inserted: 0, updated: 0, unchanged: 0, cancelled: 0, roomChanges: [], errors: [], ids: [], distApplied: 0, distSkipped: 0 };
  const normalized = records.map((raw) => {
    if (raw.errors && raw.errors.length) return { ...raw };
    const { rec, errors } = normalizeRecord(raw);
    return { ...rec, line: raw.line, errors, dist: raw.dist || [], pref_restaurant_id: raw.pref_restaurant_id ?? null };
  });
  const plan = planImport(normalized, { cancelMissing });
  tx(() => {
    for (const it of plan.items) {
      const rec = it.rec;
      if (it.action === 'erro') { result.errors.push({ line: rec.line, reservation_number: rec.reservation_number, errors: rec.errors }); continue; }
      if (it.action === 'duplicada') continue;
      const pref = rec.pref_restaurant_id ?? null;
      if (it.action === 'nova') {
        const r = db.prepare(`INSERT INTO reservations(reservation_number, guest_name, checkin, checkout, room, board, adults, children, source, pref_restaurant_id, lunch_on_arrival)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(rec.reservation_number, rec.guest_name, rec.checkin, rec.checkout, rec.room, rec.board, rec.adults, rec.children, source, pref, rec.lunch_on_arrival ? 1 : 0);
        rec.id = Number(r.lastInsertRowid);
        result.inserted++; result.ids.push(rec.id);
        continue;
      }
      const ex = it.existing;
      rec.id = ex.id;
      if (it.action === 'igual' && !(pref !== null && pref !== ex.pref_restaurant_id)) { result.unchanged++; if (useDistribution && rec.dist.length) result.ids.push(ex.id); continue; }
      if (it.old_room) {
        db.prepare('INSERT INTO room_changes(reservation_id, old_room, new_room, source, user_id) VALUES (?,?,?,?,?)')
          .run(ex.id, ex.room, rec.room, source, user ? user.id : null);
        result.roomChanges.push({ reservation_number: rec.reservation_number, guest_name: rec.guest_name, old_room: ex.room, new_room: rec.room });
      }
      db.prepare(`UPDATE reservations SET guest_name=?, checkin=?, checkout=?, room=?, board=?, adults=?, children=?, status='ativa',
          lunch_on_arrival = ?, pref_restaurant_id = COALESCE(?, pref_restaurant_id), updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(rec.guest_name, rec.checkin, rec.checkout, rec.room, rec.board, rec.adults, rec.children, rec.lunch_on_arrival ? 1 : 0, pref, ex.id);
      result.updated++; result.ids.push(ex.id);
    }
    for (const e of plan.removed) {
      db.prepare("UPDATE reservations SET status = 'cancelada', updated_at = datetime('now','localtime') WHERE id = ?").run(e.id);
      result.cancelled++; result.ids.push(e.id);
    }
    if (result.roomChanges.length) {
      const body = result.roomChanges.slice(0, 10).map((c) => `${c.guest_name}: ${c.old_room} → ${c.new_room}`).join(' · ')
        + (result.roomChanges.length > 10 ? ` (+${result.roomChanges.length - 10})` : '');
      const title = `${result.roomChanges.length} troca(s) de apartamento na importação`;
      for (const role of ['recepcao', 'restaurante', 'refeicao']) notify({ role, kind: 'room_change', title, body, link: '#/trocas' });
    }
  });
  if (result.ids.length) syncMany(result.ids);
  if (useDistribution) {
    tx(() => {
      const getRes = db.prepare('SELECT * FROM reservations WHERE id = ?');
      const up = db.prepare(`INSERT INTO assignments(reservation_id, date, meal, restaurant_id, locked, origin) VALUES (?,?,?,?,1,'planilha')
        ON CONFLICT(reservation_id, date, meal) DO UPDATE SET restaurant_id = excluded.restaurant_id, locked = 1, origin = 'planilha'`);
      const attended = db.prepare('SELECT 1 FROM attendance WHERE reservation_id = ? AND date = ? AND meal = ?');
      for (const it of plan.items) {
        const rec = it.rec;
        if (!rec.id || !rec.dist || !rec.dist.length) continue;
        const res = getRes.get(rec.id);
        for (const d of rec.dist) {
          if (!isEligible(res, d.date, d.meal) || attended.get(rec.id, d.date, d.meal)) { result.distSkipped++; continue; }
          up.run(rec.id, d.date, d.meal, d.restaurant_id);
          result.distApplied++;
        }
      }
    });
  }
  return result;
}

module.exports = { parseRows, upsertReservations, normalizeRecord, mapHeaders, planImport, checkDistribution, splitReservation, LABELS, BOARDS };
