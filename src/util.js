'use strict';
// Utilidades gerais: datas (sempre ISO yyyy-mm-dd, sem fuso), normalização de texto e CSV.

const MEALS = ['cafe', 'almoco', 'janta'];
const MEAL_LABEL = { cafe: 'Café da manhã', almoco: 'Almoço', janta: 'Jantar' };

// Tipos de pensão -> refeições incluídas
const BOARDS = {
  SA: { label: 'Sem alimentação', meals: [] },
  CM: { label: 'Café da manhã', meals: ['cafe'] },
  MAP: { label: 'Meia pensão (café + jantar)', meals: ['cafe', 'janta'] },
  MAPA: { label: 'Meia pensão (café + almoço)', meals: ['cafe', 'almoco'] },
  FAP: { label: 'Pensão completa', meals: ['cafe', 'almoco', 'janta'] },
};

function pad(n) { return String(n).padStart(2, '0'); }

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowHM(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowLocal(d = new Date()) {
  return `${todayISO(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

function monthRange(month) {
  // month = 'yyyy-mm'
  const [y, m] = month.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`;
  const last = addDays(`${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01`, -1);
  return { first, last };
}

function hmToMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function minToHM(min) { min = ((min % 1440) + 1440) % 1440; return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }

// Converte datas vindas do Excel/CSV/API para ISO
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) {
    // número serial do Excel (base 1899-12-30)
    if (v < 20000 || v > 80000) return null;
    return addDays('1899-12-30', Math.floor(v));
  }
  let s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseDate(Number(s));
  s = s.split(/[ T]/)[0];
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const iso = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    return isISODate(iso) ? iso : null;
  }
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const iso = `${y}-${pad(+m[2])}-${pad(+m[1])}`;
    return isISODate(iso) ? iso : null;
  }
  return null;
}

function normKey(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseBoard(v) {
  const s = String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  if (!s) return null;
  const tok = s.split(/[^A-Z]+/).filter(Boolean)[0] || '';
  if (tok === 'MAPA') return 'MAPA';
  if (tok === 'MAP') return 'MAP';
  if (tok === 'FAP' || tok === 'PC' || s.startsWith('PENSAO COMPLETA') || s.startsWith('ALL')) return 'FAP';
  if (tok === 'CM' || tok === 'BB' || tok === 'CAFE' || s.startsWith('CAFE')) return 'CM';
  if (tok === 'SA' || tok === 'RO' || s.startsWith('SEM')) return 'SA';
  return null;
}

function toInt(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV no padrão do Excel brasileiro: ";" e BOM UTF-8
function toCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(';')];
  for (const r of rows) lines.push(r.map((v) => (typeof v === 'number' ? String(v).replace('.', ',') : csvEscape(v))).join(';'));
  return '﻿' + lines.join('\r\n');
}

module.exports = {
  MEALS, MEAL_LABEL, BOARDS, pad, todayISO, nowHM, nowLocal, isISODate, addDays, daysBetween,
  monthRange, hmToMin, minToHM, parseDate, normKey, parseBoard, toInt, toCSV,
};
