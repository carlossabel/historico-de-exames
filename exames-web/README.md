# Histórico de exames

Sistema web para guardar o histórico de exames laboratoriais de várias pessoas
(perfis), com leitura automática de PDF via IA, alerta visual (ideal / atenção
/ fora do ideal), score de saúde, gráfico de evolução, sugestões de novos
exames via IA, dicas gerais, acompanhamento de saúde física (peso, IMC, %
de gordura, massa muscular, pressão arterial, frequência cardíaca etc. —
manual ou por foto da balança/aparelho/app, com leitura automática via IA),
registro de sintomas e de atividades físicas (manual, ou sincronizado
automaticamente do Strava e do Apple Watch), tudo cruzado pela IA nas dicas
e sugestões, com histórico de evolução de cada indicador.

Stack: backend em Node + Express + SQLite (`better-sqlite3`), frontend em
React + Vite. Um único container serve os dois.

## Rodando localmente

Requer Node 20+.

```bash
# instalar dependências
npm install --prefix server
npm install --prefix client

# rodar o backend (porta 3000)
ANTHROPIC_API_KEY=sk-ant-sua-chave npm start --prefix server

# em outro terminal, rodar o frontend em modo dev (porta 5173, com proxy pro backend)
npm run dev --prefix client
```

Abra `http://localhost:5173`.

Para simular o ambiente de produção (um único servidor servindo tudo):

```bash
npm run build --prefix client
ANTHROPIC_API_KEY=sk-ant-sua-chave npm start --prefix server
```

Abra `http://localhost:3000`.

## Deploy no Railway (recomendado — mais simples)

1. Suba esta pasta para um repositório no GitHub.
2. Em [railway.app](https://railway.app), crie um novo projeto e escolha
   **Deploy from GitHub repo**, selecionando esse repositório. O Railway
   detecta o `Dockerfile` automaticamente e builda sozinho.
3. Em **Variables**, adicione:
   - `ANTHROPIC_API_KEY` = sua chave de API da Anthropic.
4. Em **Settings → Volumes**, adicione um volume montado em `/app/data`.
   Isso é essencial: sem volume, o banco de dados e os PDFs somem a cada novo
   deploy.
5. Em **Settings → Networking**, gere um domínio público. O Railway expõe a
   porta definida em `PORT` (o app já lê essa variável automaticamente).
6. Pronto — a URL gerada já serve o site completo.

Qualquer outra plataforma que rode um `Dockerfile` com volume persistente
funciona do mesmo jeito (Render, Fly.io, um VPS com Docker, etc.).

## Como conseguir a chave de API da Anthropic

Você já tem uma — só garanta que ela está no campo `ANTHROPIC_API_KEY` das
variáveis de ambiente da hospedagem, nunca no código ou no frontend.

## Integrações de composição corporal e atividade física

### Balança Xiaomi, aparelho de pressão, smartwatch — por foto

Não existe API pública da Xiaomi (ou da maioria dos aparelhos de pressão)
pra puxar os dados direto. O caminho é simples: na aba "Saúde física" de
um perfil, clique em **Enviar foto** e tire uma foto da tela do app da
balança (Mi Fit/Zepp, Mi Body Composition Scale etc.), do aparelho de
pressão arterial, ou do app de saúde do smartwatch. A IA lê os valores
visíveis (peso, % gordura, massa muscular, pressão arterial, frequência
cardíaca etc.) e abre uma tela de revisão antes de salvar — igual à
extração de PDF de exames.

### Strava (sincronização automática)

Precisa registrar um app gratuito no Strava:

1. Acesse [strava.com/settings/api](https://www.strava.com/settings/api) e
   crie uma aplicação (qualquer nome/website servem).
2. Em **Authorization Callback Domain**, coloque só o domínio do seu site
   publicado, sem `https://` e sem caminho — ex: `seu-app.up.railway.app`.
3. Copie o **Client ID** e o **Client Secret** gerados.
4. Nas variáveis de ambiente da hospedagem (Railway → Variables), adicione:
   - `STRAVA_CLIENT_ID` = o Client ID
   - `STRAVA_CLIENT_SECRET` = o Client Secret
5. Reinicie o serviço. Na aba "Atividades" de um perfil, o card do Strava
   vai mostrar o botão **Conectar com Strava** — clique, autorize no Strava,
   e você volta pro app já na aba certa. Depois é só clicar em
   **Sincronizar** quando quiser trazer os treinos novos (não sincroniza
   sozinho, só quando pedido).

Se sua hospedagem usar um domínio diferente do detectado automaticamente
(proxies mais exóticos), defina também `STRAVA_REDIRECT_BASE_URL` com a URL
completa (ex: `https://seu-app.up.railway.app`).

### Apple Watch (via Atalhos do iPhone)

Não existe API de servidor da Apple pra dados de saúde — o caminho é um
Atalho que roda sozinho depois do treino e manda os dados pro seu app:

1. Na aba "Atividades" de um perfil, copie o link mostrado no card do Apple
   Watch (é único por perfil — guarda com cuidado, quem tiver o link
   consegue registrar atividades nesse perfil).
2. No iPhone, abra o app **Atalhos** → aba **Automação** → **Nova
   Automação** → **Treino Concluído**.
3. Adicione uma ação pra pegar os detalhes do treino (duração, distância,
   calorias) e monte um dicionário com os campos `date`, `activityType`,
   `durationMin`, `distanceKm`, `caloriesKcal`.
4. Adicione **Obter Conteúdo de URL**: método `POST`, corpo no formato
   JSON com esse dicionário, e cole o link copiado como URL.
5. Desative "Perguntar antes de executar" pra rodar automaticamente.

Se o link vazar ou parar de funcionar, dá pra gerar um novo a qualquer
momento pelo mesmo card (o antigo para de funcionar).

## Importar um backup exportado do artefato do Claude

Se você usou a versão do app dentro do Claude antes de migrar para este
projeto, dá pra trazer aquele histórico pra cá direto pelo site, sem usar
terminal:

1. No artefato do Claude, clique em **Exportar backup** na tela inicial.
   Isso baixa um arquivo `backup-exames-AAAA-MM-DD.json` na pasta padrão de
   downloads do seu navegador.
2. Abra o site já publicado e clique em **Importar backup** na tela inicial.
3. Selecione o arquivo `.json` baixado e clique em **Importar**.
4. A tela mostra quantos perfis, laudos e resultados foram importados.

**Atenção:** essa rota (`/api/import`) não pede senha nem autenticação —
qualquer pessoa com a URL do seu site consegue usá-la para inserir dados no
seu banco. Isso é consistente com o restante do app (que também não tem
login), mas vale saber antes de divulgar o link amplamente.

## Avisos importantes

- **Sem login**: este projeto não tem autenticação. Qualquer pessoa com a
  URL pública vê e edita os dados de todos os perfis. Se for publicar
  amplamente, adicione autenticação (ex: um middleware de senha simples no
  Express, ou um provedor como Auth0/Clerk) antes de colocar dados reais.
- **Custo de API**: cada PDF enviado, cada geração de dicas e cada análise de
  sugestões de novos exames consome créditos da sua chave da Anthropic
  (modelo `claude-sonnet-5`, até 1000 tokens de saída por chamada). A
  análise de sugestões só roda quando alguém clica em "Analisar", nunca
  automaticamente.
- **Dados de saúde são sensíveis**: garanta backup do volume de dados e
  avalie criptografar o disco na hospedagem escolhida.
- **Dicas e sugestões geradas não substituem avaliação médica** — isso já
  fica explícito na interface, mas vale reforçar para quem for usar o
  sistema.

## Estrutura

```
server/         API em Express + SQLite
  index.js      rotas (perfis, laudos, extração por IA, dicas, alertas/sugestões)
  db.js         schema e conexão SQLite
  anthropic.js  chamada à API da Anthropic
  data/         (criado em runtime) banco de dados + PDFs guardados
client/         frontend em React + Vite
  src/App.jsx   toda a interface
  src/api.js    chamadas fetch para o backend
Dockerfile      build de produção (client + server num único container)
```
