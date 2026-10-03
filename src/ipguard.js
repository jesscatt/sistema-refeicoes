'use strict';
/*
 * Restrição de acesso por IP (rede interna do resort).
 * O sistema fica na nuvem; a rede do resort sai para a internet por um ou mais IPs públicos.
 * Com a restrição ligada, só esses IPs (ou faixas CIDR) usam o sistema. Exceções configuráveis:
 * perfis liberados fora da rede e o link do painel da TV. A API do site/Silbeck (chave de API) não é afetada.
 * Emergência: a variável de ambiente IP_RESTRICT_OFF=1 desliga a restrição.
 */
const { getSetting } = require('./db');

function ipv4ToInt(ip) {
  const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const normIp = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '').toLowerCase();

// Valida uma linha da lista: IP (v4 ou v6) ou faixa IPv4 CIDR. Retorna null se inválida.
function parseEntry(line) {
  const s = String(line || '').split('#')[0].trim();
  if (!s) return undefined;
  const c = s.match(/^([\d.]+)\/(\d{1,2})$/);
  if (c) {
    const base = ipv4ToInt(c[1]), bits = Number(c[2]);
    if (base === null || bits > 32) return null;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { text: s, v4: true, net: (base & mask) >>> 0, mask };
  }
  if (ipv4ToInt(s) !== null) return { text: s, v4: true, net: ipv4ToInt(s), mask: 0xffffffff };
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return { text: s, v6: normIp(s) };
  return null;
}

function list() {
  return String(getSetting('ip_allowlist', '')).split(/[\n,;]+/).map(parseEntry).filter(Boolean);
}

function ipInList(ip, entries = list()) {
  const n = normIp(ip);
  const v4 = ipv4ToInt(n);
  return entries.some((e) => (e.v4 ? v4 !== null && ((v4 & e.mask) >>> 0) === e.net : e.v6 === n));
}

const enabled = () => process.env.IP_RESTRICT_OFF !== '1' && getSetting('ip_restrict', '0') === '1';
const exemptRoles = () => String(getSetting('ip_exempt_roles', '')).split(',').filter(Boolean);
const tvExempt = () => getSetting('ip_exempt_tv', '0') === '1';

// Rede interna? (sempre verdadeiro quando a restrição está desligada)
const internal = (ip) => !enabled() || ipInList(ip);
// Usuário pode usar o sistema a partir deste IP?
const userAllowed = (ip, user) => internal(ip) || (user && exemptRoles().includes(user.role));

const MSG = 'Acesso permitido somente pela rede interna do resort.';

module.exports = { parseEntry, list, ipInList, enabled, exemptRoles, tvExempt, internal, userAllowed, normIp, MSG };
