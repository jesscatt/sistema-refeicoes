import { esc, icon, mealIcon, MEALS, MEAL_FULL, MEAL_LABEL, today, addDays, dayLabel, br, hashParams, setHashParams } from '../ui.js';

// Barra de data (+ refeição opcional)
export function dateBar({ date, meal = null, meals = MEALS, extra = '' }) {
  return `<div class="row" id="dbar">
    <div class="row" style="gap:4px">
      <button class="btn sm ghost" data-d="-1" title="Dia anterior">‹</button>
      <input type="date" class="input sm" id="d-date" value="${esc(date)}" style="width:auto">
      <button class="btn sm ghost" data-d="1" title="Próximo dia">›</button>
      ${date !== today() ? '<button class="btn sm" data-today>Hoje</button>' : ''}
    </div>
    ${meal ? `<div class="seg" id="d-meal">${meals.map((m) => `<button data-m="${m}" class="${m === meal ? 'on' : ''}">${mealIcon(m)}${MEAL_LABEL[m]}</button>`).join('')}</div>` : ''}
    ${extra}
  </div>`;
}

export function bindDateBar(el, st, onChange) {
  const bar = el.querySelector('#dbar');
  if (!bar) return;
  bar.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => { st.date = addDays(st.date, Number(b.dataset.d)); onChange(); }));
  bar.querySelector('[data-today]')?.addEventListener('click', () => { st.date = today(); onChange(); });
  bar.querySelector('#d-date').addEventListener('change', (e) => { if (e.target.value) { st.date = e.target.value; onChange(); } });
  bar.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { st.meal = b.dataset.m; onChange(); }));
}

export function readParams(def) {
  const p = hashParams();
  const st = { ...def, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) };
  Object.defineProperty(st, '__page', { value: location.hash.split('?')[0].replace(/^#\/?/, ''), enumerable: false });
  return st;
}

export function syncParams(st, keys) {
  setHashParams(Object.fromEntries(keys.map((k) => [k, st[k]])), st.__page);
}

export { dayLabel, br, MEAL_FULL, icon };
