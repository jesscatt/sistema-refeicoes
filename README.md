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

Com Docker: `docker build -t mesa . && docker run -p 3000:3000 -v mesa-data:/app/data mesa`.

## Perfis

| Perfil | O que faz |
|---|---|
| **Administrador** | Tudo: usuários, restaurantes, horários, chaves de API, logs, reabrir mês. |
| **Supervisão** | Vê tudo, cadastra valores das refeições, **fecha o faturamento** e exporta os relatórios oficiais (só ela e o admin). |
| **Refeição** | Importa planilhas, revisa a divisão, move clientes, publica listas, informa o real, vê faturamento. |
| **Recepção** | Só visualiza onde cada hóspede come em cada dia e imprime os cartões. |
| **Restaurante** | Marca quem veio comer no seu restaurante e informa o número real do dia. |

## Regras principais

**Pensões** — `CM` só café · `MAP` café + jantar · `MAPA` café + almoço · `FAP` todas.
Janelas na estadia (entrada E, saída S): café e almoço de E+1 até S; jantar de E até S−1. Ajustável em `src/meals.js` (`inWindow`).

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

**Controle previsto × real** — Uma planilha por restaurante e mês: previsto (da distribuição), marcado (das marcações) e real (digitado pelo restaurante), com diferença e totais do mês.

**Faturamento** — Por restaurante × refeição × adulto/criança. Base: o real informado; sem real, o marcado. A supervisão fecha o mês (os números ficam congelados e o controle daquele mês trava).

## Importação da planilha

Aceita `.xlsx` e `.csv` (o `.xls` antigo precisa ser salvo como `.xlsx`). O cabeçalho pode estar em qualquer uma das primeiras linhas; as colunas são reconhecidas pelo nome (sem importar acentos ou maiúsculas):

| Campo | Nomes aceitos (exemplos) |
|---|---|
| Nº da reserva | Reserva, Nº Reserva, Localizador |
| Nome completo | Nome, Nome Completo, Hóspede, Cliente |
| Entrada / Saída | Entrada, Check-in, Chegada / Saída, Check-out, Partida |
| Quarto | Quarto, UH, Apto |
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
