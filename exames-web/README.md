# Histórico de exames

Sistema web para guardar o histórico de exames laboratoriais de várias pessoas
(perfis), com leitura automática de PDF via IA, alerta visual (ideal / atenção
/ fora do ideal), score de saúde, gráfico de evolução e dicas gerais.

Também guarda **notas fiscais e recibos de despesas médicas/odontológicas**
por perfil, com leitura automática via IA (prestador, CPF/CNPJ, valor,
categoria e se a despesa costuma ser dedutível no Imposto de Renda), para
facilitar a montagem da declaração anual.

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

## Notas fiscais para o Imposto de Renda

Dentro do perfil de cada pessoa, a aba **"Notas fiscais (IR)"** permite:

- Enviar o **PDF** de uma nota fiscal, NFS-e, recibo de profissional liberal
  ou fatura de plano de saúde. A IA lê o documento e extrai data, prestador,
  CPF/CNPJ, valor, categoria (consulta, exame, odontológico, hospital, plano
  de saúde, fisioterapia, psicólogo, etc.) e sinaliza se aquele tipo de
  despesa costuma ser dedutível.
- Revisar e corrigir os dados extraídos antes de salvar (a leitura automática
  pode errar).
- Ver o total dedutível e o total por categoria, filtrando por ano.
- Exportar um **CSV** com as notas do ano para levar ao contador ou usar no
  preenchimento da declaração.

**Importante:**
- O app aceita o **PDF** da nota/recibo (DANFE, NFS-e impressa, fatura), não
  o XML. Isso é proposital: nota de serviço médico (NFS-e) não tem um layout
  de XML padronizado nacionalmente — cada prefeitura usa o seu — então ler o
  PDF com IA funciona para qualquer emissor, enquanto um parser de XML só
  funcionaria para um formato específico.
- A classificação de "dedutível" é uma sugestão automática, não assessoria
  fiscal. Confirme sempre com um contador antes de declarar, especialmente em
  casos de plano de saúde de dependentes, reembolsos, ou despesas parcialmente
  cobertas.
- O backup (exportar/importar) já inclui as notas fiscais junto com os
  exames.

## Importar um backup exportado do artefato do Claude

Se você usou a versão do app dentro do Claude antes de migrar para este
projeto, dá pra trazer aquele histórico pra cá direto pelo site, sem usar
terminal:

1. No artefato do Claude, clique em **Exportar backup** na tela inicial.
   Isso baixa um arquivo `backup-exames-AAAA-MM-DD.json` na pasta padrão de
   downloads do seu navegador.
2. Abra o site já publicado e clique em **Importar backup** na tela inicial.
3. Selecione o arquivo `.json` baixado e clique em **Importar**.
4. A tela mostra quantos perfis, laudos, resultados e notas fiscais foram
   importados.

**Atenção:** essa rota (`/api/import`) não pede senha nem autenticação —
qualquer pessoa com a URL do seu site consegue usá-la para inserir dados no
seu banco. Isso é consistente com o restante do app (que também não tem
login), mas vale saber antes de divulgar o link amplamente.

## Avisos importantes

- **Sem login**: este projeto não tem autenticação. Qualquer pessoa com a
  URL pública vê e edita os dados de todos os perfis. Se for publicar
  amplamente, adicione autenticação (ex: um middleware de senha simples no
  Express, ou um provedor como Auth0/Clerk) antes de colocar dados reais.
- **Custo de API**: cada PDF enviado (exame ou nota fiscal) e cada geração de
  dicas consome créditos da sua chave da Anthropic (modelo `claude-sonnet-5`,
  até 1000 tokens de saída por chamada).
- **Dados de saúde e financeiros são sensíveis**: garanta backup do volume de
  dados e avalie criptografar o disco na hospedagem escolhida.
- **Dicas geradas não substituem avaliação médica** — isso já fica explícito
  na interface, pelo mesmo motivo, **a classificação de dedutibilidade das
  notas fiscais não substitui um contador**.

## Estrutura

```
server/         API em Express + SQLite
  index.js      rotas (perfis, laudos, notas fiscais, extração por IA, dicas)
  db.js         schema e conexão SQLite
  anthropic.js  chamada à API da Anthropic (prompts de exames e notas fiscais)
  data/         (criado em runtime) banco de dados, PDFs de exames e de notas
client/         frontend em React + Vite
  src/App.jsx   toda a interface (aba Exames + aba Notas fiscais/IR)
  src/api.js    chamadas fetch para o backend
Dockerfile      build de produção (client + server num único container)
```
