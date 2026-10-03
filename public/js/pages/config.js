import { get, post, put, del, esc, icon, fail, toast, modal, state, MEALS, MEAL_LABEL, confirmBox, ROLE_LABEL } from '../ui.js';

export async function render(el) {
  async function load() {
    const [meta, keys, integ, net] = await Promise.all([get('/api/meta'), get('/api/api-keys'), get('/api/settings/integration'), get('/api/settings/network')]);
    state.meta = meta;
    const base = location.origin;
    el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Configurações</h1></div></div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 class="grow">Restaurantes e divisão</h3><button class="btn sm primary" id="save-rest">Salvar</button></div>
        <div class="table-wrap"><table class="t">
          <thead><tr><th>Restaurante</th><th>Cor</th>${MEALS.map((m) => `<th>${MEAL_LABEL[m]} %</th>`).join('')}${MEALS.map((m) => `<th>Capacidade · ${MEAL_LABEL[m]}</th>`).join('')}</tr></thead>
          <tbody>${meta.restaurants.map((r) => `<tr data-id="${r.id}">
            <td><input class="input sm" name="name" value="${esc(r.name)}"></td>
            <td><input type="color" name="color" value="${esc(r.color)}" style="width:40px;height:32px;border:0;background:none"></td>
            ${MEALS.map((m) => `<td><input class="input sm" type="number" min="0" max="100" step="1" name="share_${m}" value="${Math.round(r[`share_${m}`] * 100)}" style="width:70px"></td>`).join('')}
            ${MEALS.map((m) => `<td><input class="input sm" type="number" min="0" name="cap_${m}" value="${r[`cap_${m}`]}" style="width:80px" title="0 = sem limite"></td>`).join('')}
          </tr>`).join('')}</tbody></table></div>
        <p class="muted small" style="padding:0 18px 14px">Percentual 0 = não oferece aquela refeição. Capacidade em pessoas por refeição (0 = sem limite); é usada na divisão e na API do site para não lotar.</p>
        <div class="card-head" style="border-top:1px solid var(--line)"><h3 class="grow">Dias em que o restaurante fecha</h3><span class="muted small">marque o dia para fechar · a parte dele vai para os outros abertos</span></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Restaurante</th>${MEALS.map((m) => `<th>${MEAL_LABEL[m]}</th>`).join('')}</tr></thead>
          <tbody>${meta.restaurants.map((r) => `<tr data-closed="${r.id}"><td><b>${esc(r.name)}</b></td>${MEALS.map((m) => r[`share_${m}`] > 0 ? `<td><div class="closed-days" data-meal="${m}">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((l, i) => `<label title="${['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][i]}"><input type="checkbox" value="${i}" ${String(r[`closed_${m}`] || '').split(',').includes(String(i)) ? 'checked' : ''}>${l}</label>`).join('')}</div></td>` : '<td class="muted small">não oferece</td>').join('')}</tr>`).join('')}</tbody></table></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 class="grow">Políticas do resort</h3><button class="btn sm primary" id="save-pol">Salvar</button></div>
        <div class="row" style="gap:12px;align-items:flex-end;padding:16px 20px">
          <label class="f" style="max-width:260px">Máximo de pessoas por apartamento<input class="input" type="number" min="1" max="20" id="max-pax" value="${meta.max_pax_room}"></label>
          <label class="f" style="max-width:200px">Dois abertos: % do principal<input class="input" type="number" min="50" max="100" id="t-split" value="${meta.two_open?.split ?? 60}"></label>
          <label class="f" style="max-width:200px">Movimento a partir de (pessoas)<input class="input" type="number" min="1" id="t-thr" value="${meta.two_open?.threshold ?? 400}"></label>
          <label class="f" style="max-width:220px">Principal recebe até (pessoas)<input class="input" type="number" min="1" id="t-cap" value="${meta.two_open?.main_cap ?? 300}"></label>
          <p class="muted small" style="margin:0 0 10px;flex-basis:100%">Com apenas dois restaurantes abertos no almoço ou no jantar, o principal (Di Giordana) fica com o percentual indicado; com movimento a partir do número informado, recebe até a quantidade indicada e o restante segue para o outro restaurante.</p>
          <p class="muted small" style="margin:0 0 10px">Adultos + crianças. Vale para importação, reservas, rooming list, Comercial e API do site: apartamentos acima do limite são recusados.</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 class="grow">Acesso somente pela rede interna</h3>
          <span class="badge ${net.enabled && !net.env_off ? 'ok' : ''}">${net.env_off ? 'Desligado pela variável IP_RESTRICT_OFF' : net.enabled ? 'Restrição ativa' : 'Restrição desligada'}</span>
          <button class="btn sm primary" id="save-net">Salvar</button></div>
        <div style="padding:14px 20px">
          <p class="muted small" style="margin-top:0">O sistema está na internet. Com a restrição ativa, ele só funciona a partir dos IPs públicos da rede do resort (o endereço com que a internet do resort sai). Fora da rede — 4G, casa, outra empresa — aparece a mensagem <i>“Acesso permitido somente pela rede interna do resort”</i>. A integração com o site e com o Silbeck por chave de API continua funcionando.</p>
          <div class="banner ${net.your_ip_listed ? 'ok' : 'warn'}" style="margin-bottom:12px">${icon(net.your_ip_listed ? 'check' : 'alert')}<span>Seu IP atual: <b>${esc(net.your_ip)}</b> — ${net.your_ip_listed ? 'está na lista.' : 'não está na lista.'} ${net.your_ip_listed ? '' : '<button class="btn sm" id="add-my-ip" style="margin-left:6px">Incluir meu IP</button>'}</span></div>
          <div class="grid g2" style="gap:14px">
            <label class="f" style="margin:0">IPs da rede interna (um por linha; aceita faixa, ex.: 177.10.20.0/24)<textarea class="input" id="net-ips" rows="4" placeholder="177.10.20.30">${esc(net.allowlist)}</textarea></label>
            <div>
              <div class="small" style="font-weight:700;margin-bottom:6px">Liberados também fora da rede</div>
              ${['admin', 'supervisor', 'refeicao', 'recepcao', 'restaurante', 'agencia'].map((r) => `<label class="row" style="gap:6px;margin:2px 0"><input type="checkbox" data-exempt="${r}" ${net.exempt_roles.includes(r) ? 'checked' : ''}> ${esc(ROLE_LABEL[r] || r)}</label>`).join('')}
              <label class="row" style="gap:6px;margin:8px 0 2px"><input type="checkbox" id="net-tv" ${net.exempt_tv ? 'checked' : ''}> Painel da TV pelo link (sem login)</label>
            </div>
          </div>
          <label class="row" style="gap:8px;margin-top:12px;font-weight:700"><input type="checkbox" id="net-on" ${net.enabled ? 'checked' : ''}> Ativar a restrição à rede interna</label>
          <p class="muted small" style="margin:8px 0 0">Se o IP da internet do resort mudar e ninguém conseguir entrar, crie no Railway a variável <b>IP_RESTRICT_OFF</b> com o valor <b>1</b> para desligar a restrição, entre e atualize a lista.</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 class="grow">Horários e aviso das listas</h3><button class="btn sm primary" id="save-times">Salvar</button></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Refeição</th><th>Início</th><th>Fim</th><th>Aviso (min antes)</th></tr></thead>
          <tbody>${meta.meal_times.map((t) => `<tr data-meal="${t.meal}"><td><b>${esc(t.label)}</b></td>
            <td><input class="input sm" type="time" name="start" value="${t.start}" style="width:auto"></td>
            <td><input class="input sm" type="time" name="end" value="${t.end}" style="width:auto"></td>
            <td><input class="input sm" type="number" min="0" max="240" name="notify_before_min" value="${t.notify_before_min}" style="width:80px"></td></tr>`).join('')}</tbody></table></div>
        <p class="muted small" style="padding:0 18px 14px">No horário do aviso a lista do dia é publicada automaticamente e cada restaurante recebe a notificação no sistema.</p>
      </div>

      <div class="grid g2">
        <div class="card">
          <div class="card-head">${icon('key')}<h3 class="grow">Chaves de API (site / Silbeck)</h3><button class="btn sm" id="new-key">${icon('plus')} Nova chave</button></div>
          <div class="table-wrap"><table class="t"><tbody>${keys.map((k) => `<tr><td><b>${esc(k.name)}</b><div class="muted small">${esc(k.source)} · ${esc(k.prefix)}… · criada ${esc(k.created_at.slice(0, 10))}</div></td>
            <td class="small muted">${k.last_used_at ? 'usada ' + esc(k.last_used_at) : 'nunca usada'}</td>
            <td>${k.active ? `<button class="btn sm danger" data-revoke="${k.id}">Revogar</button>` : '<span class="badge danger">revogada</span>'}</td></tr>`).join('') || '<tr><td><div class="empty">Nenhuma chave criada.</div></td></tr>'}</tbody></table></div>
          <div class="card-pad" style="padding:12px 18px 16px">
            <p class="small" style="margin-top:0"><b>Endpoints</b> (cabeçalho <code>X-API-Key</code>):</p>
            <pre>GET  ${esc(base)}/api/v1/disponibilidade?data=AAAA-MM-DD&refeicao=almoco&dias=7
POST ${esc(base)}/api/v1/reservas
GET  ${esc(base)}/api/v1/reservas/{numero}</pre>
            <p class="small">Exemplo de envio de reserva com escolha de restaurante pelo cliente:</p>
            <pre>{
  "numero_reserva": "12345", "nome": "Maria da Silva",
  "entrada": "2026-10-01", "saida": "2026-10-04",
  "quarto": "101", "pensao": "FAP", "adultos": 2, "criancas": 1,
  "escolhas": [
    { "data": "2026-10-02", "refeicao": "janta", "restaurante": "MAE" }
  ]
}</pre>
            <p class="muted small">Se o restaurante estiver lotado, a escolha volta com <code>"erro": "restaurante lotado"</code>. Códigos: ${meta.restaurants.map((r) => `<code>${esc(r.code)}</code> ${esc(r.name)}`).join(', ')}.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3 class="grow">Silbeck · busca automática</h3><button class="btn sm" id="sync">${icon('refresh')} Sincronizar agora</button></div>
          <form id="sb" class="form-grid" style="padding:16px 18px">
            <label class="f full">URL da API (https)<input class="input" name="silbeck_url" value="${esc(integ.silbeck_url)}" placeholder="https://..."></label>
            <label class="f">Token<input class="input" name="silbeck_token" type="password" placeholder="${integ.silbeck_token_set ? '•••••• (salvo)' : 'não definido'}" autocomplete="off"></label>
            <label class="f">A cada (min)<input class="input" name="silbeck_interval_min" type="number" min="1" max="120" value="${integ.silbeck_interval_min}"></label>
            <div class="full row"><button class="btn primary" type="submit">Salvar</button><span class="muted small">${integ.silbeck_last_sync ? `Última: ${esc(integ.silbeck_last_sync)} — ${esc(integ.silbeck_last_result || '')}` : 'Ainda não sincronizado.'}</span></div>
          </form>
          <p class="muted small" style="padding:0 18px">O formato da API do Silbeck ainda será definido; o sistema espera uma lista de reservas com os mesmos campos do exemplo ao lado. Também é possível o Silbeck <b>enviar</b> para <code>/api/v1/reservas</code> com uma chave própria.</p>
          <div class="card-head" style="border-top:1px solid var(--line)"><h3 class="grow">Assistente de relatórios</h3>${integ.ai_enabled ? '<span class="badge ok">ativo</span>' : '<span class="badge warn">não configurado</span>'}</div>
          <p class="muted small" style="padding:0 18px 16px">Defina a variável de ambiente <code>ANTHROPIC_API_KEY</code> no servidor para ativar.</p>
        </div>
      </div>
      <div class="card" style="margin-top:16px;border-color:#e6aaa4">
        <div class="card-head"><h3 class="grow" style="color:var(--danger)">Exclusão de dados de reservas</h3><button class="btn sm danger" id="reset">Excluir todas as reservas</button></div>
        <p class="muted small" style="padding:0 18px 14px">Utilize para excluir os dados de teste antes da importação das planilhas reais. Exclui reservas, divisão, registros de atendimento e controle. Usuários, restaurantes, horários e valores continuam.</p>
      </div>`;

    el.querySelector('#save-rest').onclick = async () => {
      try {
        for (const tr of el.querySelectorAll('tr[data-id]')) {
          const v = (n) => tr.querySelector(`[name=${n}]`).value;
          const cl = el.querySelector(`tr[data-closed="${tr.dataset.id}"]`);
          const closed = Object.fromEntries(MEALS.map((m) => [`closed_${m}`, cl && cl.querySelector(`[data-meal="${m}"]`) ? [...cl.querySelectorAll(`[data-meal="${m}"] input:checked`)].map((i) => i.value).join(',') : undefined]));
          await put('/api/restaurants/' + tr.dataset.id, {
            name: v('name'), color: v('color'), ...closed,
            ...Object.fromEntries(MEALS.flatMap((m) => [[`share_${m}`, Number(v(`share_${m}`)) / 100], [`cap_${m}`, v(`cap_${m}`)]])),
          });
        }
        for (const m of MEALS) {
          const s = [...el.querySelectorAll(`[name=share_${m}]`)].reduce((a, i) => a + Number(i.value), 0);
          if (s !== 100 && s !== 0) toast(`Atenção: ${MEAL_LABEL[m]} soma ${s}% (a divisão é proporcional mesmo assim).`, 'notif');
        }
        toast('Restaurantes salvos.'); load();
      } catch (e) { fail(e); }
    };
    const addIp = el.querySelector('#add-my-ip');
    if (addIp) addIp.onclick = () => { const t = el.querySelector('#net-ips'); t.value = (t.value.trim() ? t.value.trim() + '\n' : '') + net.your_ip; };
    el.querySelector('#save-net').onclick = async () => {
      try {
        await put('/api/settings/network', { enabled: el.querySelector('#net-on').checked, allowlist: el.querySelector('#net-ips').value, exempt_roles: [...el.querySelectorAll('[data-exempt]:checked')].map((c) => c.dataset.exempt), exempt_tv: el.querySelector('#net-tv').checked });
        toast('Acesso pela rede interna salvo.'); load();
      } catch (e) { fail(e); }
    };
    el.querySelector('#save-pol').onclick = async () => {
      try { await put('/api/settings/policy', { max_pax_room: el.querySelector('#max-pax').value, two_open_split: el.querySelector('#t-split').value, two_open_threshold: el.querySelector('#t-thr').value, two_open_main_cap: el.querySelector('#t-cap').value }); toast('Política salva.'); load(); } catch (e) { fail(e); }
    };
    el.querySelector('#save-times').onclick = async () => {
      const list = [...el.querySelectorAll('tr[data-meal]')].map((tr) => ({ meal: tr.dataset.meal, start: tr.querySelector('[name=start]').value, end: tr.querySelector('[name=end]').value, notify_before_min: tr.querySelector('[name=notify_before_min]').value }));
      try { await put('/api/meal-times', { meal_times: list }); toast('Horários salvos.'); load(); } catch (e) { fail(e); }
    };
    el.querySelector('#new-key').onclick = () => {
      const { el: m, close } = modal({
        title: 'Nova chave de API',
        body: `<div class="form-grid"><label class="f">Nome<input class="input" name="name" placeholder="Site de vendas"></label>
          <label class="f">Sistema<select class="input" name="source"><option value="site">Site</option><option value="silbeck">Silbeck</option><option value="outro">Outro</option></select></label></div>`,
        foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Criar</button>',
      });
      m.querySelector('[data-ok]').onclick = async () => {
        try {
          const r = await post('/api/api-keys', { name: m.querySelector('[name=name]').value, source: m.querySelector('[name=source]').value });
          close();
          modal({ title: 'Chave criada', body: '<p>Copie a chave agora; ela não será exibida novamente.</p><pre style="white-space:pre-wrap;word-break:break-all">' + esc(r.key) + '</pre>', foot: '<button class="btn primary" data-close>Copiei</button>' });
          load();
        } catch (e) { fail(e); }
      };
    };
    el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmBox('Revogar esta chave? O sistema que a usa vai parar de funcionar.', 'Revogar', true))) return;
      try { await del('/api/api-keys/' + b.dataset.revoke); load(); } catch (e) { fail(e); }
    }));
    el.querySelector('#sb').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (!f.silbeck_token) delete f.silbeck_token;
      try { await put('/api/settings/integration', f); toast('Integração salva.'); load(); } catch (err) { fail(err); }
    });
    el.querySelector('#reset').onclick = () => {
      const { el: m, close } = modal({
        title: 'Excluir todas as reservas?',
        body: '<p style="margin-top:0">Isso não pode ser desfeito. Digite <b>APAGAR</b> para confirmar.</p><input class="input" name="c" autocomplete="off">',
        foot: '<button class="btn" data-close>Cancelar</button><button class="btn danger" data-ok>Apagar</button>',
      });
      m.querySelector('[data-ok]').onclick = async () => {
        try { const r = await post('/api/admin/reset-reservations', { confirm: m.querySelector('[name=c]').value }); toast(`${r.deleted} apartamentos apagados. Pode importar a planilha real.`); close(); } catch (e) { fail(e); }
      };
    };
    el.querySelector('#sync').onclick = async () => {
      try { const r = await post('/api/integration/silbeck/sync'); toast(r.skipped || `${r.inseridas} novas, ${r.atualizadas} atualizadas.`); load(); } catch (e) { fail(e); }
    };
  }
  await load();
}
