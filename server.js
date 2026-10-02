'use strict';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const http = require('node:http');
const path = require('node:path');

require('./src/db');
if (process.env.SEED_DEMO === '1') require('./scripts/seed-demo');
require('./src/routes/auth');
require('./src/routes/reservations');
require('./src/routes/service');
require('./src/routes/control');
require('./src/routes/admin');
require('./src/routes/ia');
require('./src/routes/portal');
require('./src/routes/finance');
require('./src/routes/tv');
const { apiKeyAuth, silbeckTick } = require('./src/routes/integration');
const { handle } = require('./src/http');
const { startScheduler } = require('./src/publish');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  handle(req, res, PUBLIC, apiKeyAuth);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Sistema de Refeições rodando em http://localhost:${PORT}  (fuso ${process.env.TZ})`);
    startScheduler();
    setInterval(silbeckTick, 60 * 1000);
  });
}

module.exports = server;
