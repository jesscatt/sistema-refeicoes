# Refeições · Termas Romanas (Recanto Maestro)

Sistema web para organizar a pensão alimentar dos hóspedes entre os restaurantes **Di Giordana**, **Paradiso** e **Churrascaria Maestro**: importa a planilha de reservas, divide os clientes pela regra 60/20/20, avisa os restaurantes 40 minutos antes de cada refeição, registra quem veio comer, junta previsto × real numa planilha só e gera o faturamento.

- Roda só no navegador (computador, tablet ou celular).
- **Sem dependências externas**: Node.js 22.13+ com o SQLite embutido. Não precisa de `npm install`.

## Como rodar

```bash
node --version          # precisa ser 22.13 ou mais novo
npm start               # sobe em http://localhost:3000
```

No primeiro start são criados dois administradores, `admin` e `dev`. As senhas aparecem no console (ou defina `ADMIN_PASSWORD` e `DEV_PASSWORD` antes do primeiro start) e precisam ser trocadas no primeiro acesso.

Para testar com dados de exemplo (90 reservas e um usuário de cada perfil):

```bash
npm run demo            # admin/admin1234, dev/dev12345, demais usuários com senha demo1234
npm start
```

Testes das regras de negócio: `npm test`.

### Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `TZ` | `America/Sao_Paulo` | Fuso dos horários de refeição |
| `DATA_DIR` / `DB_FILE` | `./data/refeicoes.db` | Onde fica o banco |
| `ADMIN_PASSWORD`, `DEV_PASSWORD` | geradas | Senhas iniciais dos administradores |
| `COOKIE_SECURE` | `0` | Use `1` quando estiver atrás de HTTPS |
| `SESSION_HOURS` | `14` | Duração da sessão |
| `ANTHROPIC_API_KEY` | — | Ativa o Assistente IA |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Modelo usado pelo assistente |

### Publicar no Railway (ambiente de testes)

1. Em railway.app, entre com o GitHub e crie **New Project → Deploy from GitHub repo → sistema-refeicoes**.
2. No serviço, em **Settings → Volumes**, adicione um volume montado em `/app/data` (é onde fica o banco; sem isso os dados somem a cada atualização).
3. Em **Variables**, defina `ADMIN_PASSWORD`, `DEV_PASSWORD` e `COOKIE_SECURE=1`.
4. Em **Settings → Networking**, clique em **Generate Domain** para ter o link.
5. Opcional: `SEED_DEMO=1` cria os usuários de teste (inclusive `comercial`, senha `demo1234`) e, só em banco vazio, reservas de exemplo. Antes de importar as planilhas reais, use *Configurações → Começar do zero* para apagar as reservas de teste.

Com Docker: `docker build -t refeicoes . && docker run -p 3000:3000 -v refeicoes-data:/app/data refeicoes` (o volume é informado no `docker run`; o Dockerfile não declara `VOLUME` porque o Railway não aceita).

## Perfis

Todos entram pelo **Painel** (aberturas das refeições do dia e avisos).

| Perfil | Acessa |
|---|---|
| **Administrador** (`admin`, `dev`) | Tudo. |
| **Refeição** | Tudo, menos Usuários e Configurações (e a tela da recepção): marcação, distribuição, reservas, importação, rooming list, trocas, controle da divisão, previsto × real, faturamento, IA e logs. |
| **Supervisão** | Faturamento, previsão (Controle da divisão e Previsto × Real), Distribuição, Assistente IA e Logs. Fecha o mês e cadastra valores. |
| **Comercial** | Trocas de quarto (conferir/desfazer), Quartos e rooming list, e onde cada hóspede vai comer. Não muda a pensão nem a divisão. |
| **Recepção** | Onde cada hóspede vai comer (com cartões para imprimir). Só visualiza. |
| **Restaurante** | Painel e as marcações do próprio restaurante (lista, fora da lista, consumo à parte). |

O realizado de cada refeição vem automaticamente dos registros dos restaurantes; não é digitado por ninguém.

## Regras principais

- **Política de ocupação:** no máximo **5 pessoas por quarto** (adultos + crianças). Vale na importação, no cadastro e na edição de reservas, no rooming list, no Comercial e na API do site; quartos acima do limite são recusados com o motivo. O limite pode ser ajustado em *Configurações → Políticas do resort*.
**Pensões** — `CM` só café · `MAP` café + jantar · `MAPA` café + almoço · `FAP` todas.
Janelas na estadia (entrada E, saída S): café e almoço de E+1 até S; jantar de E até S−1. Ajustável em `src/meals.js` (`inWindow`).

**Grupos** — Todos os quartos com o mesmo número de reserva formam um grupo e vão sempre juntos ao mesmo restaurante em cada refeição. Ao longo da estadia o sistema alterna os restaurantes do grupo (rodízio), como é feito na planilha manual.

**Almoço na chegada** — Grupos que chegam antes do almoço almoçam no dia da entrada (e não no dia da saída). Detectado sozinho quando a planilha de divisão traz almoço no dia da chegada; também dá para marcar na reserva.

**Restaurantes abertos** — O *Painel geral* mostra a todos os perfis quais restaurantes estão abertos no dia, por refeição e horário. Administração e Refeições abrem ou fecham um restaurante numa data clicando na refeição (com motivo); os apartamentos ainda não atendidos são redistribuídos entre os abertos, mantendo os grupos juntos, e todos recebem o aviso. Fechamentos fixos por dia da semana ficam em *Configurações*.

**Divisão** — Almoço e jantar: Di Giordana 60%, Paradiso 20%, Maestro 20%. Café: Di Giordana 60%, Paradiso 40% (Maestro não serve). A divisão é por pax (adultos + crianças), grupos inteiros no mesmo restaurante, respeitando a capacidade quando cadastrada. Percentuais e capacidades ficam em *Configurações*.

- Quem já tem restaurante **não muda sozinho** numa nova importação (para não invalidar cartões já entregues). Novos hóspedes entram no restaurante mais abaixo da meta.
- *Redistribuir* refaz o dia só para quem não está travado nem marcado. Mover alguém à mão trava o cliente ali.
- Escolhas feitas pelo cliente no site ficam travadas.

**Listas e avisos** — No horário de cada refeição menos 40 min (06:50, 11:20, 18:20) a lista do dia é publicada automaticamente e cada restaurante recebe o aviso no sistema (com som e notificação do navegador, se permitida). O setor de refeições também pode publicar antes.

**Quartos com torre** — O quarto pode vir escrito de qualquer jeito na planilha ou na busca: `101A`, `A101`, `a-101`, `Torre A 101` são o mesmo quarto. Digitar só o número (`101`) mostra todas as torres (101A, 101B…); com a letra, só aquela torre. A letra aparece num selo azul ao lado do número. Escrever o mesmo quarto de outro jeito numa nova importação não conta como troca de quarto.

**Marcação no restaurante** — Busca por quarto e torre, nome ou reserva:
- na lista → marca presença;
- na lista de outro restaurante → marca como **fora da lista** e o outro restaurante não consegue mais marcar (sem duplicidade — garantido também por restrição no banco);
- sem aquela refeição na pensão, ou fora dos dias da estadia → aviso “cobrar à parte”, com opção de registrar o consumo pago à parte;
- quarto antigo de alguém que trocou de quarto → mostra o quarto novo.

**Troca de quarto** — Detectada na importação (mesma reserva, outro quarto) ou na edição manual; fica no histórico e avisa recepção, refeição e restaurantes.

**Previsto x realizado** — Por restaurante e mês: previsto (da distribuição) e realizado (pax registrados pelos restaurantes, lista + fora da lista), calculado automaticamente e sem edição manual.

**Faturamento** — Por restaurante × refeição × adulto/criança. Base: o realizado (registros dos restaurantes). Refeição prevista sem nenhum registro aparece em alerta e não entra no valor. A supervisão fecha o mês (os números ficam congelados).

## Rooming list (Comercial)

Vale **apenas para reservas de grupo** (2 ou mais apartamentos no mesmo número de reserva). Reservas de um único apartamento não aparecem nessa tela nem podem receber rooming list; são ajustadas em *Reservas*.

*Quartos e rooming list → Enviar rooming list*: escolha a reserva/grupo e envie a planilha da agência (.xlsx ou .csv) com **Quarto** e **Nome** (uma linha por hóspede, ou por quarto). Aceita quarto só na primeira linha (células mescladas), coluna Reserva opcional, coluna Idade (até 11 anos = criança) ou Adultos/Crianças. Antes de gravar mostra: quartos que serão atualizados, quartos novos (entram no grupo com a mesma pensão e datas) e quartos do grupo que não vieram na lista (marque os que saíram). Recepção, refeições e restaurantes são avisados. Modelo em *Enviar rooming list → Modelo*.

Os nomes aparecem na recepção, no restaurante (dá para buscar pelo nome do hóspede), na reserva e no cartão impresso.

**Trocas de quarto**: cada troca fica "a conferir" até o Comercial clicar em *Conferir* ou *Desfazer* (volta o quarto antigo e avisa todos).

**Fora da lista (restaurante)**: botão *Fora da lista* → digita o nº do apto → mostra onde o hóspede deveria comer → registra no restaurante atual. O restaurante de origem é avisado e o hóspede não pode ser marcado de novo naquela refeição em nenhum restaurante.

## Controle da divisão (pagamento dos restaurantes)

Página *Controle da divisão*: escolha a semana (ou qualquer período) e veja, por restaurante e refeição, o pax previsto, marcado e real, quantos adultos e crianças pagar e o valor em R$ (com os valores de *Faturamento → Valores*). A diferença para a previsão aparece em vermelho quando passa do previsto. Base do pagamento: o realizado (registros dos restaurantes). Exporta em Excel. O restaurante vê só o dele.

## Importação da planilha

Aceita `.xlsx` e `.csv` (o `.xls` antigo precisa ser salvo como `.xlsx`). Validado com a planilha *DIVISÃO 30-09 a 04-10* do resort (350 quartos, 94 reservas):

- **Reserva** pode vir com o nome do grupo junto (`50893 ANR TUR`); o número e o nome são separados.
- **Vários quartos na mesma reserva** são um grupo.
- **Datas que o Excel gravou com dia e mês trocados** (01/10 virando 10 de janeiro) são corrigidas.
- **Pax** é o total do quarto (já inclui as crianças); **Chd** pode vir como `-`.
- **Colunas de divisão** (`JANTAR DI GIORDANA QUARTA-FEIRA 30/09`…) são lidas; na conferência dá para usar a divisão da planilha (fica travada) ou deixar o sistema dividir.
- Avisos por linha: refeição que a pensão não inclui, refeição da pensão que a planilha não mandou, pensão inválida (com sugestão de correção).
- Quartos de uma reserva que sumiram da planilha podem ser cancelados na mesma importação.

A *Distribuição* exporta a **planilha de divisão no mesmo formato** (.xlsx), para continuar mandando aos restaurantes.

O cabeçalho pode estar em qualquer uma das primeiras linhas; as colunas são reconhecidas pelo nome (sem importar acentos ou maiúsculas):

| Campo | Nomes aceitos (exemplos) |
|---|---|
| Nº da reserva | Reserva, Nº Reserva, Localizador |
| Nome (opcional) | Nome, Nome Completo, Hóspede, Cliente, Grupo, Agência — ou junto do número na coluna Reserva |
| Entrada / Saída | Entrada, Check-in, Chegada / Saída, Check-out, Partida |
| Quarto | Quarto, UH, Apto (com a letra da torre: `101C`) |
| Pensão | Pensão, Regime, Plano |
| Adultos | Adultos, ADT — ou **Pessoas/Pax** (total; as crianças são descontadas) |
| Crianças | Crianças, CHD |

Antes de gravar aparece a conferência linha a linha (nova, alterada, sem mudança, erro, troca de quarto). Há um modelo em *Importar → Modelo de planilha*.

## API para o site e o Silbeck

Crie uma chave em *Configurações → Chaves de API* e envie no cabeçalho `X-API-Key`.

```
GET  /api/v1/disponibilidade?data=2026-10-01&refeicao=almoco&dias=7
POST /api/v1/reservas            (uma reserva, uma lista, ou { "reservas": [...] })
GET  /api/v1/reservas/{numero}
```

```json
{
  "numero_reserva": "12345", "nome": "Maria da Silva",
  "entrada": "2026-10-01", "saida": "2026-10-04",
  "quarto": "101", "pensao": "FAP", "adultos": 2, "criancas": 1,
  "restaurante_preferido": "DG",
  "escolhas": [{ "data": "2026-10-02", "refeicao": "janta", "restaurante": "MAE" }]
}
```

A disponibilidade devolve ocupação, capacidade e `lotado` por restaurante, para o site não oferecer restaurante cheio. Uma escolha para restaurante lotado volta com `"erro": "restaurante lotado"`. Códigos: `DG`, `PAR`, `MAE`.

Para o **Silbeck** há também busca periódica (*Configurações → Silbeck*): informe a URL e o token; o sistema espera uma lista de reservas com os mesmos campos. Quando a documentação da API deles estiver disponível, o mapeamento fica em `fromExternal()` em `src/routes/integration.js`.

## Estrutura

```
server.js                 servidor HTTP e agendador
src/db.js                 banco (SQLite), usuários iniciais, auditoria
src/meals.js              regras de pensão e divisão entre restaurantes
src/importer.js           leitura e gravação das reservas importadas
src/xlsx.js               leitor de .xlsx/.csv sem dependências
src/publish.js            publicação das listas e aviso 40 min antes
src/routes/               API (auth, reservas, serviço, controle/faturamento, admin, integração, IA)
public/                   interface web (HTML/CSS/JS puro)
scripts/seed-demo.js      dados de demonstração
test/                     testes das regras
```

## Próximos passos sugeridos

- Definir com o Silbeck o formato da API e ajustar `fromExternal()`.
- Rodar atrás de HTTPS (Nginx/Caddy) com `COOKIE_SECURE=1` e backup diário do arquivo `data/refeicoes.db`.
- Ativar o Assistente IA com `ANTHROPIC_API_KEY` quando houver alguns meses de dados.
