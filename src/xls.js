'use strict';
/*
 * Leitor mínimo de planilhas .xls (Excel 97–2003, formato BIFF8), sem dependências.
 * Lê o contêiner OLE2 (Compound File) e os registros de células de cada aba:
 * textos (SST/LABEL), números (NUMBER/RK/MULRK), resultados de fórmulas e booleanos.
 * Retorna as abas no mesmo formato do leitor de .xlsx: [{ name, rows, formulas: {} }].
 */

const FREE = 0xffffffff, END = 0xfffffffe;

function isXls(buf) {
  return buf && buf.length > 512 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1;
}

// ---------- contêiner OLE2 ----------
function cfbStreams(buf) {
  const ssz = 1 << buf.readUInt16LE(0x1e);
  const msz = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  let difatSec = buf.readUInt32LE(0x44);
  const sector = (n) => {
    const off = (n + 1) * ssz;
    if (off + ssz > buf.length + ssz) throw new Error('Arquivo .xls corrompido.');
    return buf.subarray(off, Math.min(off + ssz, buf.length));
  };
  // lista de setores da FAT (DIFAT: 109 entradas no cabeçalho + setores extras)
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s !== FREE) fatSecs.push(s);
  }
  let guard = 0;
  while (fatSecs.length < nFat && difatSec !== END && difatSec !== FREE && guard++ < 10000) {
    const d = sector(difatSec);
    for (let i = 0; i < ssz / 4 - 1 && fatSecs.length < nFat; i++) {
      const s = d.readUInt32LE(i * 4);
      if (s !== FREE) fatSecs.push(s);
    }
    difatSec = d.readUInt32LE(ssz - 4);
  }
  const fat = [];
  for (const s of fatSecs) { const d = sector(s); for (let i = 0; i + 4 <= d.length; i += 4) fat.push(d.readUInt32LE(i)); }
  const chain = (start) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== END && s !== FREE && s < fat.length && !seen.has(s); s = fat[s]) { seen.add(s); out.push(s); }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start).map(sector));
  // diretório
  const dir = readChain(dirStart);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nlen = dir.readUInt16LE(off + 0x40);
    const type = dir[off + 0x42];
    if (!type) { entries.push(null); continue; }
    const name = dir.subarray(off, off + Math.max(0, nlen - 2)).toString('utf16le');
    entries.push({ name, type, start: dir.readUInt32LE(off + 0x74), size: dir.readUInt32LE(off + 0x78) });
  }
  const root = entries[0];
  let mini = null, miniFat = null;
  const get = (e) => {
    if (e.size < cutoff && e.type === 2) {
      if (!mini) {
        mini = readChain(root.start);
        miniFat = [];
        const mf = miniFatStart === END ? Buffer.alloc(0) : readChain(miniFatStart);
        for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
      }
      const parts = [];
      const seen = new Set();
      for (let s = e.start; s !== END && s !== FREE && s < miniFat.length && !seen.has(s); s = miniFat[s]) { seen.add(s); parts.push(mini.subarray(s * msz, s * msz + msz)); }
      return Buffer.concat(parts).subarray(0, e.size);
    }
    return readChain(e.start).subarray(0, e.size);
  };
  return { entries: entries.filter(Boolean), get };
}

// ---------- BIFF8 ----------
function records(wb, from = 0) {
  const out = [];
  let p = from;
  while (p + 4 <= wb.length) {
    const type = wb.readUInt16LE(p), len = wb.readUInt16LE(p + 2);
    out.push({ type, pos: p, data: wb.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
    if (type === 0x000a && from !== 0) break; // EOF da aba
  }
  return out;
}

const rkValue = (rk) => {
  let v;
  if (rk & 2) v = rk >> 2; // inteiro de 30 bits (com sinal)
  else { const b = Buffer.alloc(8); b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4); v = b.readDoubleLE(0); }
  return rk & 1 ? v / 100 : v;
};

// Texto Unicode do BIFF8 (cch já lido); lida com quebras em registros CONTINUE
function readChars(r, cch, high) {
  let s = '';
  while (cch > 0) {
    if (r.pos >= r.buf.length) break;
    if (r.bounds.length && r.pos === r.bounds[0]) { r.bounds.shift(); high = r.buf[r.pos++] & 1; continue; }
    const limit = r.bounds.length ? r.bounds[0] : r.buf.length;
    const avail = high ? Math.floor((limit - r.pos) / 2) : limit - r.pos;
    const n = Math.min(cch, avail);
    if (n <= 0) { if (r.bounds.length && r.pos >= r.bounds[0]) { r.bounds.shift(); high = r.buf[r.pos++] & 1; continue; } break; }
    s += high ? r.buf.subarray(r.pos, r.pos + n * 2).toString('utf16le') : r.buf.subarray(r.pos, r.pos + n).toString('latin1');
    r.pos += high ? n * 2 : n;
    cch -= n;
  }
  return s;
}
function skip(r, n) {
  r.pos += n;
  while (r.bounds.length && r.bounds[0] < r.pos) r.bounds.shift();
}

function parseSst(data, conts) {
  // concatena SST + CONTINUE, guardando onde cada CONTINUE começa
  const bounds = [];
  let total = data.length;
  for (const c of conts) { bounds.push(total); total += c.length; }
  const r = { buf: Buffer.concat([data, ...conts]), pos: 8, bounds };
  const n = data.readUInt32LE(4);
  const out = [];
  for (let i = 0; i < n && r.pos < r.buf.length; i++) {
    if (r.bounds.length && r.pos === r.bounds[0]) r.bounds.shift();
    const cch = r.buf.readUInt16LE(r.pos);
    const flags = r.buf[r.pos + 2];
    r.pos += 3;
    let runs = 0, ext = 0;
    if (flags & 8) { runs = r.buf.readUInt16LE(r.pos); r.pos += 2; }
    if (flags & 4) { ext = r.buf.readUInt32LE(r.pos); r.pos += 4; }
    out.push(readChars(r, cch, flags & 1).replace(/\r\n/g, '\n'));
    skip(r, runs * 4 + ext);
  }
  return out;
}

function xlString(data, off, lenBytes = 2) {
  const cch = lenBytes === 2 ? data.readUInt16LE(off) : data[off];
  const flags = data[off + lenBytes];
  let p = off + lenBytes + 1;
  if (flags & 8) p += 2;
  if (flags & 4) p += 4;
  return (flags & 1 ? data.subarray(p, p + cch * 2).toString('utf16le') : data.subarray(p, p + cch).toString('latin1')).replace(/\r\n/g, '\n');
}

function readXlsSheets(buf) {
  const cfb = cfbStreams(buf);
  const ent = cfb.entries.find((e) => /^(Workbook|Book)$/i.test(e.name));
  if (!ent) throw new Error('Arquivo .xls sem planilha (fluxo Workbook não encontrado).');
  const wb = cfb.get(ent);
  if (wb.length < 8 || wb.readUInt16LE(0) !== 0x0809) throw new Error('Arquivo .xls inválido.');
  const ver = wb.readUInt16LE(4);
  if (ver !== 0x0600) throw new Error('Versão de .xls não suportada (anterior ao Excel 97). Salve como .xlsx.');
  const glob = records(wb);
  const sheets = [];
  let sst = [];
  for (let i = 0; i < glob.length; i++) {
    const r = glob[i];
    if (r.type === 0x0085) {
      const visible = r.data[4], kind = r.data[5];
      if (kind === 0) sheets.push({ pos: r.data.readUInt32LE(0), name: xlString(r.data, 6, 1), hidden: visible !== 0 });
    } else if (r.type === 0x00fc) {
      const conts = [];
      for (let j = i + 1; j < glob.length && glob[j].type === 0x003c; j++) conts.push(glob[j].data);
      sst = parseSst(r.data, conts);
    } else if (r.type === 0x000a) break;
  }
  return sheets.map((sh) => {
    const rows = [];
    const set = (row, col, v) => { while (rows.length <= row) rows.push([]); rows[row][col] = v; };
    let pendingStr = null;
    for (const r of records(wb, sh.pos).slice(1)) {
      const d = r.data;
      switch (r.type) {
        case 0x00fd: set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? ''); break; // LABELSST
        case 0x0203: set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6)); break; // NUMBER
        case 0x027e: set(d.readUInt16LE(0), d.readUInt16LE(2), rkValue(d.readInt32LE(6))); break; // RK
        case 0x00bd: { // MULRK
          const row = d.readUInt16LE(0); let col = d.readUInt16LE(2);
          for (let p = 4; p + 6 <= d.length - 2; p += 6) set(row, col++, rkValue(d.readInt32LE(p + 2)));
          break;
        }
        case 0x0204: case 0x00d6: set(d.readUInt16LE(0), d.readUInt16LE(2), xlString(d, 6)); break; // LABEL / RSTRING
        case 0x0205: set(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? null : !!d[6]); break; // BOOLERR
        case 0x0006: { // FORMULA (valor calculado)
          const row = d.readUInt16LE(0), col = d.readUInt16LE(2);
          if (d.readUInt16LE(12) === 0xffff) {
            const t = d[6];
            if (t === 0) pendingStr = [row, col];
            else if (t === 1) set(row, col, !!d[8]);
            else set(row, col, null);
          } else set(row, col, d.readDoubleLE(6));
          break;
        }
        case 0x0207: if (pendingStr) { set(pendingStr[0], pendingStr[1], xlString(d, 0)); pendingStr = null; } break; // STRING
        default:
      }
    }
    return { name: sh.name, hidden: sh.hidden, rows, formulas: {} };
  });
}

module.exports = { isXls, readXlsSheets };
