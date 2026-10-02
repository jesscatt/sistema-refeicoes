'use strict';
// Leitor de planilhas sem dependências: .xlsx (zip + XML) e .csv.
// Arquivos .xls antigos (binários) não são suportados: salve como .xlsx ou .csv.
const zlib = require('node:zlib');

const { isXls, readXlsSheets } = require('./xls');

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Arquivo não é um .xlsx válido.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    files[name] = () => {
      const ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + ln + le, off + 30 + ln + le + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('Compressão não suportada no .xlsx');
    };
  }
  return files;
}

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&';
    if (e === 'quot') return '"'; if (e === 'apos') return "'";
    if (e[1] === 'x' || e[1] === 'X') return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(parseInt(e.slice(1), 10));
  });
}

function textOf(xml) {
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1];
  return decodeXml(out);
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sharedStrings(read) {
  const shared = [];
  const ss = read('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(ss))) shared.push(textOf(m[1]));
  }
  return shared;
}

// Lê uma aba: valores (rows[linha][coluna]) e fórmulas ({ 'B5': 'A5*43' })
function parseSheet(sheet, shared) {
  const rows = [];
  const formulas = {};
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g; // inclui linhas vazias <row .../>
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const rn = rm[1].match(/\br="(\d+)"/);
    if (rn) while (rows.length < Number(rn[1]) - 1) rows.push([]);
    const row = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, idx = 0;
    while ((cm = cRe.exec(rm[2] || ''))) {
      const attrs = cm[1], inner = cm[2] || '';
      const r = attrs.match(/\br="([A-Z]+\d+)"/);
      if (r) idx = colIndex(r[1]);
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      const f = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
      if (f && r) formulas[r[1]] = decodeXml(f[1]);
      let val = null;
      if (t === 's') val = v ? shared[+v[1]] ?? '' : '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'str' || t === 'e') val = v ? decodeXml(v[1]) : '';
      else if (t === 'b') val = v ? v[1] === '1' : null;
      else if (v) { const n = Number(v[1]); val = Number.isFinite(n) ? n : decodeXml(v[1]); }
      row[idx] = val;
      idx++;
    }
    rows.push(row);
  }
  return { rows, formulas };
}

// Todas as abas, na ordem do workbook: [{ name, rows, formulas }]
function readXlsxSheets(buf) {
  if (isXls(buf)) return readXlsSheets(buf); // .xls (Excel 97–2003)
  const files = unzip(buf);
  const read = (name) => (files[name] ? files[name]().toString('utf8') : null);
  const shared = sharedStrings(read);
  const wb = read('xl/workbook.xml') || '', rels = read('xl/_rels/workbook.xml.rels') || '';
  const out = [];
  const re = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(wb))) {
    const name = decodeXml((m[1].match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (m[1].match(/r:id="([^"]+)"/) || [])[1];
    const rel = rid && rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`));
    const tgt = rel && rel[0].match(/Target="([^"]+)"/);
    if (!tgt) continue;
    const path = tgt[1].startsWith('/') ? tgt[1].slice(1) : 'xl/' + tgt[1].replace(/^\.\//, '');
    const xml = read(path);
    if (xml) out.push({ name, ...parseSheet(xml, shared) });
  }
  return out;
}

function readXlsx(buf) {
  const sheets = readXlsxSheets(buf);
  if (!sheets.length) throw new Error('Não foi encontrada a primeira aba da planilha.');
  return sheets[0].rows;
}

function readCsv(buf) {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readSpreadsheet(buf, filename = '') {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) return readXlsx(buf);
  if (isXls(buf)) {
    const sheets = readXlsSheets(buf);
    const first = sheets.find((x) => !x.hidden && x.rows.some((r) => r && r.some((v) => v !== null && v !== undefined && v !== ''))) || sheets[0];
    if (!first) throw new Error('Não foi encontrada a primeira aba da planilha.');
    return first.rows;
  }
  if (/\.xlsx$/i.test(filename)) throw new Error('Arquivo .xlsx inválido.');
  return readCsv(buf);
}

module.exports = { readSpreadsheet, readXlsx, readXlsxSheets, readCsv };
