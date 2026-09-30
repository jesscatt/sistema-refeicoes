'use strict';
// Publicação das listas de refeição e agendamento automático (aviso 40 min antes).
const { db, notify, audit } = require('./db');
const { MEAL_LABEL, todayISO, nowLocal, hmToMin, addDays } = require('./util');
const { daySummary, isPublished, rebalance } = require('./meals');

function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}`; }

function publishList(date, meal, user = null, auto = false) {
  // Garante que ninguém ficou sem restaurante antes de publicar
  const orphans = db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN restaurants r ON r.id = a.restaurant_id
    WHERE a.date = ? AND a.meal = ? AND r.share_${meal} = 0`).get(date, meal).n;
  if (orphans) rebalance(date, meal);
  const already = isPublished(date, meal);
  db.prepare(`INSERT INTO meal_lists(date, meal, published_at, published_by, auto) VALUES (?,?,?,?,?)
    ON CONFLICT(date, meal) DO UPDATE SET published_at = excluded.published_at, published_by = excluded.published_by, auto = excluded.auto`)
    .run(date, meal, nowLocal(), user ? user.id : null, auto ? 1 : 0);
  const sum = daySummary(date, meal).filter((r) => r.serves);
  const mt = db.prepare('SELECT * FROM meal_times WHERE meal = ?').get(meal);
  const label = `${MEAL_LABEL[meal]} ${fmtDate(date)}`;
  const verb = already ? 'atualizada' : 'pronta';
  for (const r of sum) {
    notify({
      role: 'restaurante', restaurant_id: r.id, kind: 'list_ready',
      title: `Lista do ${label} ${verb}`,
      body: `${r.name}: ${r.pax} pax (${r.adults} adultos, ${r.children} crianças) em ${r.reservas} reservas. Serviço das ${mt.start} às ${mt.end}.`,
      link: `#/servico?date=${date}&meal=${meal}`,
    });
  }
  const total = sum.reduce((s, r) => s + r.pax, 0);
  const resumo = sum.map((r) => `${r.code} ${r.pax}`).join(' · ');
  for (const role of ['recepcao', 'refeicao', 'supervisor']) {
    notify({ role, kind: 'list_ready', title: `Lista do ${label} ${verb}`, body: `${total} pax — ${resumo}`, link: `#/distribuicao?date=${date}&meal=${meal}` });
  }
  audit(user, auto ? 'lista_publicada_auto' : 'lista_publicada', { date, meal, total }, null);
  return { date, meal, total, restaurants: sum };
}

// Refeição "da vez": a que está em serviço ou a próxima
function currentMeal(d = new Date()) {
  const now = d.getHours() * 60 + d.getMinutes();
  const times = db.prepare('SELECT * FROM meal_times ORDER BY sort').all();
  for (const t of times) if (now <= hmToMin(t.end)) return { date: todayISO(d), meal: t.meal };
  return { date: addDays(todayISO(d), 1), meal: times[0].meal };
}

function tick() {
  try {
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    const today = todayISO(d);
    for (const t of db.prepare('SELECT * FROM meal_times ORDER BY sort').all()) {
      const openAt = hmToMin(t.start) - t.notify_before_min;
      if (now >= openAt && now < hmToMin(t.end) && !isPublished(today, t.meal)) {
        publishList(today, t.meal, null, true);
        console.log(`[agenda] Lista publicada automaticamente: ${t.meal} ${today}`);
      }
    }
  } catch (e) { console.error('[agenda] erro', e); }
}

function startScheduler() {
  tick();
  return setInterval(tick, 30 * 1000);
}

module.exports = { publishList, currentMeal, startScheduler, tick };
