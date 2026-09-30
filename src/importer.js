'use strict';
// Importação de reservas (Excel/CSV/API) com detecção automática das colunas.
const { db, tx, notify } = require('./db');
const { normKey, parseDate, parseBoard, toInt, BOARDS } = require('./util');
const { syncMany } = require('./meals');

// Apelidos aceitos para cada coluna (comparados sem acento, minúsculo, sem espaços)
const FIELDS = {
  reservation_number: ['reserva', 'nreserva', 'nreserv', 'numeroreserva', 'numerodareserva', 'numreserva', 'nres', 'codreserva', 'codigoreserva', 'localizador', 'reservation', 'reservationnumber', 'idreserva', 'res'],
  guest_name: ['nomecompleto', 'nome', 'hospede', 'nomehospede', 'nomedohospede', 'cliente', 'nomecliente', 'titular', 'guest', 'guestname', 'name'],
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
  for (const f of ORDER) {
    const i = keys.findIndex((k, idx) => !used.has(idx) && k && FIELDS[f].includes(k));
    if (i >= 0) { map[f] = i; used.add(i); }
  }
  for (const f of ORDER) {
    if (map[f] !== undefined) continue;
    const i = keys.findIndex((k, idx) => !used.has(idx) && k && CONTAINS[f].some((c) => k.includes(c)));
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

const REQUIRED = ['reservation_number', 'guest_name', 'checkin', 'checkout', 'room', 'board'];
const LABELS = {
  reservation_number: 'Nº da reserva', guest_name: 'Nome completo', checkin: 'Entrada', checkout: 'Saída',
  room: 'Quarto', board: 'Pensão', adults: 'Adultos', pax: 'Pessoas (total)', children: 'Crianças',
};

// Normaliza e valida um registro vindo de qualquer fonte
function normalizeRecord(raw) {
  const errors = [];
  const rec = {
    reservation_number: String(raw.reservation_number ?? '').trim().replace(/\.0$/, ''),
    guest_name: String(raw.guest_name ?? '').trim().replace(/\s+/g, ' '),
    checkin: parseDate(raw.checkin),
    checkout: parseDate(raw.checkout),
    room: String(raw.room ?? '').trim().replace(/\.0$/, ''),
    board: parseBoard(raw.board),
    children: toInt(raw.children, 0),
    adults: null,
  };
  if (raw.adults !== undefined && raw.adults !== null && raw.adults !== '') rec.adults = toInt(raw.adults, 0);
  else if (raw.pax !== undefined && raw.pax !== null && raw.pax !== '') rec.adults = Math.max(0, toInt(raw.pax, 0) - rec.children);
  else rec.adults = 1;
  if (!rec.reservation_number) errors.push('sem número de reserva');
  if (!rec.guest_name) errors.push('sem nome');
  if (!rec.checkin) errors.push('data de entrada inválida');
  if (!rec.checkout) errors.push('data de saída inválida');
  if (rec.checkin && rec.checkout && rec.checkout < rec.checkin) errors.push('saída antes da entrada');
  if (!rec.room) errors.push('sem quarto');
  if (!rec.board) errors.push(`pensão "${raw.board ?? ''}" não reconhecida (use CM, MAP, MAPA ou FAP)`);
  if (rec.adults + rec.children === 0) errors.push('quantidade de pessoas zerada');
  return { rec, errors };
}

function parseRows(rows) {
  const head = findHeaderRow(rows);
  const missing = REQUIRED.filter((f) => head.map[f] === undefined);
  if (head.idx < 0 || missing.length) {
    return { ok: false, error: `Não encontrei as colunas: ${missing.map((f) => LABELS[f]).join(', ')}. Verifique o cabeçalho da planilha.`, headerRow: head.idx, mapping: head.map };
  }
  const header = rows[head.idx];
  const out = [];
  for (let i = head.idx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) continue;
    const raw = {};
    for (const [f, idx] of Object.entries(head.map)) raw[f] = r[idx];
    const { rec, errors } = normalizeRecord(raw);
    out.push({ line: i + 1, ...rec, errors });
  }
  const mapping = Object.fromEntries(Object.entries(head.map).map(([f, idx]) => [f, { label: LABELS[f], column: String(header[idx]) }]));
  return { ok: true, headerRow: head.idx + 1, mapping, rows: out };
}

/*
 * Grava registros (insert/update por número de reserva).
 * Detecta troca de quarto e avisa recepção, refeição e restaurantes.
 */
function upsertReservations(records, { source = 'excel', user = null } = {}) {
  const result = { inserted: 0, updated: 0, unchanged: 0, roomChanges: [], errors: [], ids: [] };
  tx(() => {
    for (const raw of records) {
      const { rec, errors } = raw.errors ? { rec: raw, errors: raw.errors } : normalizeRecord(raw);
      if (errors.length) { result.errors.push({ line: raw.line, reservation_number: rec.reservation_number, errors }); continue; }
      const pref = raw.pref_restaurant_id ?? null;
      const ex = db.prepare('SELECT * FROM reservations WHERE reservation_number = ?').get(rec.reservation_number);
      if (!ex) {
        const r = db.prepare(`INSERT INTO reservations(reservation_number, guest_name, checkin, checkout, room, board, adults, children, source, pref_restaurant_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(rec.reservation_number, rec.guest_name, rec.checkin, rec.checkout, rec.room, rec.board, rec.adults, rec.children, source, pref);
        result.inserted++; result.ids.push(Number(r.lastInsertRowid));
        continue;
      }
      const changed = ['guest_name', 'checkin', 'checkout', 'room', 'board', 'adults', 'children'].some((k) => String(ex[k]) !== String(rec[k]))
        || ex.status !== 'ativa' || (pref !== null && pref !== ex.pref_restaurant_id);
      if (!changed) { result.unchanged++; continue; }
      if (ex.room !== rec.room) {
        db.prepare('INSERT INTO room_changes(reservation_id, old_room, new_room, source, user_id) VALUES (?,?,?,?,?)')
          .run(ex.id, ex.room, rec.room, source, user ? user.id : null);
        result.roomChanges.push({ reservation_number: rec.reservation_number, guest_name: rec.guest_name, old_room: ex.room, new_room: rec.room });
      }
      db.prepare(`UPDATE reservations SET guest_name=?, checkin=?, checkout=?, room=?, board=?, adults=?, children=?, status='ativa',
          pref_restaurant_id = COALESCE(?, pref_restaurant_id), updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(rec.guest_name, rec.checkin, rec.checkout, rec.room, rec.board, rec.adults, rec.children, pref, ex.id);
      result.updated++; result.ids.push(ex.id);
    }
    if (result.roomChanges.length) {
      const body = result.roomChanges.slice(0, 10).map((c) => `${c.guest_name}: ${c.old_room} → ${c.new_room}`).join(' · ')
        + (result.roomChanges.length > 10 ? ` (+${result.roomChanges.length - 10})` : '');
      const title = `${result.roomChanges.length} troca(s) de quarto`;
      for (const role of ['recepcao', 'restaurante', 'refeicao']) notify({ role, kind: 'room_change', title, body, link: '#/trocas' });
    }
  });
  if (result.ids.length) syncMany(result.ids);
  return result;
}

module.exports = { parseRows, upsertReservations, normalizeRecord, mapHeaders, LABELS, BOARDS };
