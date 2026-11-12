# DataDice

RPG de mesa D&D 5e (regras de 2014) com uma IA do Gemini como Mestre, ficha completa e memória persistente de campanha. Funciona no computador e no celular.

## Contas e chave do Gemini (BYOK)

- Cada pessoa cria a própria conta (e-mail e senha). A senha é guardada com bcrypt e a sessão usa um token JWT válido por 7 dias.
- Cada jogador usa a **própria chave do Gemini** (modelo BYOK, "traga sua chave"). A chave fica salva só no navegador dele, em Configurações (ícone de engrenagem), e vai ao servidor no cabeçalho `x-gemini-key` apenas nas ações que falam com o Gemini. O servidor não grava a chave nem a registra em log.
- A chave gratuita sai em https://aistudio.google.com/app/apikey. O plano gratuito tem limite diário de pedidos e **não inclui geração de imagens**.
- Cada jogador vê só os próprios personagens e campanhas. O **admin** vê tudo e tem as abas **Caderno do Mestre**, **Métricas de Tokens** e **Painel Admin**.

## Como rodar no seu computador

1. Instale as dependências, se necessário: `npm install`
2. Ligue o banco (o atalho **Abrir DataDice** já faz isso) e confira `DATABASE_URL` no `.env`.
3. Crie a sua conta admin (uma vez só), num terminal na pasta do projeto: `npm run admin`
   - A senha não aparece enquanto você digita.
   - Num banco de antes do login, a conta admin fica com os personagens e as campanhas que já existiam.
4. Inicie: `npm start` (ou use o atalho **Abrir DataDice**).
5. Abra `http://localhost:3000`, entre com o e-mail e a senha, e cole sua chave do Gemini em Configurações.

Por padrão, o servidor só aceita conexões do próprio computador (`HOST=127.0.0.1`).

## Banco de dados (PostgreSQL)

Tudo fica no PostgreSQL: contas, fichas, campanhas, chat, consumo, livros de regras e **as imagens** (servidas em `/images/<nome>`, com nome aleatório).

- **Neste computador**, o DataDice tem um PostgreSQL só dele, criado na conta do usuário, sem administrador: dados em `%LOCALAPPDATA%\DataDice\postgres`, porta `5433`, aceitando conexões só do próprio computador. A senha é aleatória e está só no `.env`.
- **Estrutura:** as tabelas são criadas pelas migrações em `src/db/migrations/`, aplicadas em ordem ao iniciar o servidor. Para mudar o banco, crie um arquivo novo (ex.: `002_mesas.sql`); nunca edite uma migração que já rodou.
- **Já prevê o modo Grupo:** campanhas com modo `solo` ou `grupo`, código de acesso, membros com papel (`mestre`/`jogador`) e aprovação, mensagens com visibilidade (todos, só o Mestre, privada), notas do Mestre, iniciativa e Biblioteca com itens ocultos.
- **Busca:** a busca nos livros e na conversa ignora acentos (extensão `unaccent` do PostgreSQL).
- **Dados da versão SQLite:** `npm run db:import` copia `data/rpg.db` e as imagens de `public/images` para o PostgreSQL. O arquivo antigo só é lido, nunca alterado, e a cópia só acontece num banco vazio.

## Atalhos no Windows

Na Área de Trabalho, **Abrir DataDice** liga o banco e inicia o jogo; **Fechar DataDice** encerra o jogo e desliga o banco. Se precisar recriá-los:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\criar-atalhos.ps1
```

Os logs ficam em `data\logs\`.

## Hospedar na internet (Beta)

O projeto tem um `Dockerfile`: o servidor roda sem permissões de administrador dentro do contêiner, e `GET /healthz` responde quando o servidor e o banco estão no ar. Como tudo fica no PostgreSQL, a hospedagem não precisa de disco próprio.

Caminho sugerido para o Beta:

1. **Código no GitHub:** crie um repositório **privado** só com a pasta do projeto. O `.gitignore` já deixa de fora `.env`, `data/`, `node_modules/` e as imagens locais. Antes do primeiro envio, confira com `git status` que nenhum `.env` aparece.
2. **Banco:** crie um PostgreSQL gerenciado (ex.: Neon ou Supabase) e copie a URL de conexão, com `?sslmode=require` no final.
3. **Servidor:** num serviço que roda Docker a partir do GitHub (ex.: Render ou Railway), crie um serviço web com o repositório e as variáveis abaixo. Health check: `/healthz`. Use **uma instância só** (veja "Mesas em tempo real" abaixo).
4. **Seus dados:** para levar as campanhas deste computador, rode `npm run db:import` com `DATABASE_URL` apontando para o banco novo (ainda vazio).
5. **Conta admin:** na primeira vez, defina `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `ADMIN_NAME`; depois que entrar, apague `ADMIN_PASSWORD` das variáveis.
6. **Domínio (depois):** com um domínio próprio, aponte-o para o serviço; o Cloudflare pode ficar na frente como proxy (veja abaixo).

**Mesas em tempo real.** O chat das mesas usa uma conexão aberta com o servidor (Server-Sent Events), guardada na memória do processo:
- Rode **uma instância só**. Com duas ou mais, quem está numa instância não recebe as mensagens da outra (só ao recarregar).
- Prefira um plano que **não hiberna**. Planos gratuitos que "dormem" depois de alguns minutos sem acesso derrubam as conexões e demoram para acordar; a página reconecta sozinha, mas a primeira entrada fica lenta.
- Se a conexão cair (celular no bolso, servidor reiniciando), a página reconecta e busca o que chegou enquanto estava fora.

**Cloudflare na frente (opcional):**
- Modo SSL/TLS **Full (strict)** e **Always Use HTTPS** ligados.
- O tempo real funciona pelo proxy do Cloudflare: o servidor manda um sinal a cada 25 s para a conexão não ser cortada, e desliga a compressão e o acúmulo de respostas (`no-transform`, `X-Accel-Buffering: no`).
- Não ative cache para `/api/*`.

**Antes de abrir para os testadores:**
- `NODE_ENV=production` (ativa HSTS e exige `JWT_SECRET`).
- `REGISTRATION_CODE` definido, para só entrar quem tem o convite.
- Avise no convite: o admin lê as campanhas do modo Solo e o Caderno do Mestre, mas **não** entra nas mesas em grupo; imagens enviadas abrem por um endereço secreto e aleatório (quem tiver o link consegue ver).
- Teste `https://seu-endereço/healthz` e entre numa mesa por dois aparelhos diferentes.

Variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | URL do PostgreSQL, com `?sslmode=require` na hospedagem. |
| `HOST=0.0.0.0` | Aceitar conexões de fora. Só faça isso atrás de HTTPS. |
| `PORT` | Porta do servidor. |
| `TRUST_PROXY` | Quantos proxies há na frente do servidor: `1` só a hospedagem (Render, Railway), `2` com o Cloudflare na frente da hospedagem. Errado, o limite de tentativas de login passa a contar todo mundo como uma pessoa só (um atacante bloquearia todos). |
| `MAX_USER_IMAGE_MB` | Espaço de imagens por conta (padrão 100 MB). |
| `JWT_SECRET` | Segredo dos tokens, com 32 caracteres ou mais. **Obrigatório na hospedagem.** No seu computador, se faltar, um segredo aleatório é criado em `data/jwt-secret`. Trocar o segredo desconecta todo mundo. |
| `REGISTRATION_CODE` | Código de convite do Beta. Com ele definido, só cria conta quem tem o código. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Criam a conta admin na primeira inicialização, se ainda não houver admin. Depois, apague `ADMIN_PASSWORD` das variáveis. |
| `NODE_ENV=production` | Liga o HSTS (o navegador só abre o site por HTTPS) e torna `JWT_SECRET` obrigatório. O `Dockerfile` já define. |
| `DATABASE_POOL_SIZE` | Conexões com o banco ao mesmo tempo (padrão 10). Planos gratuitos de banco costumam aceitar poucas. |
| `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL` | Modelos de texto e de imagem. |

Proteções já incluídas: senhas com bcrypt, limite de 20 tentativas de login ou cadastro a cada 15 minutos por IP, limite de tentativas de código de mesa, limite de mensagens e envios de imagem por conta, cabeçalhos de segurança (CSP, `nosniff`, `frame-ancestors 'none'`, `no-referrer`, HSTS em produção) e respostas iguais para e-mail inexistente e senha errada.

## Modelos e custos

- **Texto:** `gemini-3.5-flash-lite`, um dos mais baratos (US$ 0,30 por milhão de tokens de entrada e US$ 2,50 de saída). Funciona no plano gratuito, dentro do limite diário.
- **Imagens:** `gemini-3.1-flash-lite-image`, a opção de imagem mais barata (cerca de US$ 0,034 por imagem). **Exige faturamento ativo** na chave.
- Em Configurações, **Gerar Ilustrações de Cenas e NPCs via Gemini** vem desligado. Desligado, o Mestre nem recebe as instruções de imagem: a chave gasta menos tokens e nenhuma imagem é cobrada. O retrato da ficha é gerado só quando o jogador clica no botão.

Na aba **Consumo IA**, cada jogador acompanha o gasto da própria chave:

- **Limite diário:** quantos pedidos a chave já fez hoje pelo DataDice e a hora em que o limite gratuito volta. O Google zera a contagem à meia-noite do Pacífico (5h ou 4h em Brasília, conforme o horário de verão americano).
- **Totais:** tokens, pedidos e custo estimado, com filtro de período (hoje, 7 dias, 30 dias ou tudo).
- **Divisões:** por campanha e por tipo de uso (conversa com o Mestre, reação às rolagens, abertura de sessão e resumos automáticos), mais um gráfico dos últimos 30 dias.

O custo estimado usa a tabela de preços em `src/services/usage.js` e só vale para chaves com faturamento ativo. Registros de antes desta versão aparecem como "Registros antigos".

Quando algo dá errado, o jogador recebe uma mensagem específica:

| Situação | O que a mensagem diz |
|---|---|
| Limite diário do plano gratuito | Quantos pedidos por dia a chave tem, a hora em que o limite volta (horário de Brasília), que a campanha está salva e como tirar o limite. |
| Limite por minuto | Esperar cerca de 1 minuto; a mensagem não foi perdida (o sistema já tentou de novo sozinho). |
| Imagem em chave gratuita | O plano gratuito não inclui imagens; o jogo continua sem elas; ativar o faturamento ou desligar as ilustrações. |
| Chave recusada | Conferir a chave em Configurações (com botão para abrir). |
| Google sobrecarregado | O problema é do Google, não da chave; tentar de novo em instantes. |

O motivo da falha de cada ilustração fica salvo e aparece na bolha do chat e na Biblioteca.

## Menus e treinamentos

- **Dois tipos de jogo no topo:** 🤖 **Mestre IA** (Jogo, Campanhas, Biblioteca, Consumo IA) e 🎲 **Mesas com amigos** (Mesas). **Personagens** e o menu Admin aparecem nos dois. O DataDice lembra o último tipo usado; no modo Mesas, a chave do Gemini não é pedida.
- **Treinamentos (🎓):** tours curtos que navegam pelo sistema e destacam cada parte: Primeiros passos, Criar um personagem, Jogar com o Mestre IA, Mesas como Mestre, Mesas como jogador e (para admins) Ferramentas de admin. Não criam nem apagam nada. Abrem sozinhos no primeiro acesso e ficam marcados como concluídos neste navegador.

## Mesas em grupo (Mestre humano)

Na aba **Mesas**, uma pessoa cria a mesa e vira o Mestre. Não usa IA nem chave do Gemini.

- **Convite:** a mesa tem um código (ex.: `K7QF-M2XA`). O Mestre pode copiar, gerar outro (o antigo para de valer) e parar de aceitar pedidos.
- **Entrada:** quem usa o código fica esperando; o Mestre aprova ou recusa. Até 6 jogadores por mesa.
- **Ficha:** cada jogador escolhe uma das suas fichas (ou cria uma nova) para a mesa. A mesma ficha pode estar em várias mesas e campanhas.
- **Privacidade:** só os membros da mesa a enxergam. Nem o admin abre mesas dos outros, e e-mails nunca aparecem para os outros membros.
- **Chat em tempo real:** em personagem, fora do personagem, privado entre Mestre e um jogador, e fala de NPC (o Mestre escreve em nome do personagem). Cada mensagem chega na hora só para quem pode vê-la.
- **Rolagens:** quem rola é o servidor. As do Mestre são secretas por padrão; o jogador pode rolar "só para o Mestre". Na aba Ficha, o jogador rola testes, perícias, salvaguardas, ataques e iniciativa da própria ficha.
- **Painel do Mestre:** PV, dano e cura (os PV temporários absorvem antes), condições e Inspiração de cada jogador, e o botão **Editar ficha** abre a ficha completa do jogador. Toda mudança feita pelo Mestre vira um aviso privado para o jogador.
- **Iniciativa:** **Começar combate** põe os jogadores na ordem; a iniciativa que eles rolam entra sozinha. Monstros entram pela Biblioteca já com a iniciativa rolada e com os PV para controlar; podem ficar ocultos. Jogadores não veem PV de monstros nem os ocultos. **Próximo turno** anuncia de quem é a vez.
- **Biblioteca:** NPCs, monstros e locais com imagem, descrição e estatísticas (CA, PV, atributos, ataques). Modelos prontos (Goblin, Orc, Lobo, Guarda, Mago...) preenchem tudo. Começa oculto; ao revelar, os jogadores veem nome, descrição e imagem, nunca as estatísticas. O Mestre rola os ataques de cada ficha.
- **Meus modelos:** NPCs, monstros e locais guardados na conta do Mestre (Mesas → **📚 Meus modelos**), para usar em qualquer mesa. Na Biblioteca, "Começar de um modelo" mostra primeiro os seus e depois os prontos; uma ficha da mesa vira modelo pelo botão **💾 Meus modelos** ou pela opção ao criar. A imagem do modelo é uma cópia própria: não some se a mesa for excluída.
- **Imagens:** o Mestre envia para todos ou só para um jogador (o texto da caixa vira legenda). As imagens ficam na galeria da Biblioteca.
- **Notas:** anotações privadas do Mestre, salvas sozinhas.

## Criar campanha com IA

Em **Campanhas → Nova campanha**, o jogador escolhe um tema, o tom e a duração, e pode escrever uma ideia. A IA devolve um rascunho com o nome, o mundo (premissa, locais, facções e como a aventura começa) e as instruções para o Mestre. Nada é salvo até o jogador revisar e clicar em **Criar campanha**. Também dá para escrever do zero. Os temas ficam em `src/services/campaignGenerator.js`.

## Retrato enviado pelo jogador

Na Página 2 da ficha, **Enviar imagem** aceita PNG, JPG ou WebP. O navegador reduz a imagem para no máximo 1024 px e a regrava em JPEG (o que tira metadados, como a localização da foto). O servidor confere o formato pelos primeiros bytes, limita a 3 MB e grava no banco com nome aleatório.

## Livros de regras

Os livros precisam ser indexados uma vez. O comando pode ser repetido sem duplicar nada:

```
npm run rules:ingest -- "Livro do Jogador=C:\caminho\jogador.pdf" "Guia do Mestre=C:\caminho\mestre.pdf" "Manual dos Monstros=C:\caminho\monstros.pdf"
```

O texto fica no banco (`DATABASE_URL`). A cada consulta de regra, só os trechos encontrados são enviados ao Gemini. O comando `npm run models` (que lista os modelos da chave) usa a `GEMINI_API_KEY` do `.env`, só para manutenção.

## Como o Mestre lembra

| Camada | Conteúdo | Quando entra no prompt |
|---|---|---|
| Base | Regras essenciais, mundo e fichas | Sempre |
| Fatos essenciais | Memórias fixadas ou de importância 4 e 5 | Sempre |
| Índice | Nome de tudo o que já existe na campanha | Sempre |
| Crônica | Resumo acumulado, atualizado a cada 20 mensagens | Sempre |
| Conversa recente | Últimas 20 mensagens e as que ainda não entraram na crônica | Sempre |
| Memórias relacionadas | Fichas e trechos antigos ligados ao momento | Quando há relação |
| Consulta | Busca do Mestre na conversa inteira e nos livros | Quando ele tem dúvida |

Toda a conversa fica na tabela `messages` e o resumo nunca apaga mensagens. A exceção é um turno em que o Gemini falha: nada é salvo, e o texto continua na caixa para reenvio.

O conteúdo que o admin escreve no Caderno do Mestre não é substituído pela IA; novidades entram como anexo.

## Sessões

Em uma campanha nova, o chat só abre depois da introdução do Mestre. Ao voltar a uma campanha, ele resume a última sessão antes de continuar. O resumo não altera o jogo. Uma nova sessão começa depois de 1 hora sem jogar ou ao clicar em **Encerrar sessão**; recarregar a página durante o jogo não gera outro resumo.

## Artes da campanha

Com as ilustrações ligadas, o Mestre marca no JSON do turno os NPCs, monstros e locais marcantes que merecem imagem (no máximo 3 por turno). O servidor reutiliza a arte se ela já existir na campanha; se não existir, responde na hora e gera em segundo plano com a chave do jogador.

A arte aparece na bolha da mensagem e na aba **Biblioteca**. Se a geração falhar, o jogo continua, e a Biblioteca oferece **Tentar de novo**. Se o servidor reiniciar no meio de uma geração, ela fica como falha: a chave de quem pediu não é guardada para retomar sozinha.

As imagens ficam no banco, na tabela `images`, com nomes aleatórios.

## Dados

As rolagens dos jogadores e do Mestre são feitas pelo servidor, com gerador criptográfico, e ficam registradas no chat. O Mestre pede os dados, recebe os resultados e narra. Se ele aplicar dano sem rolagem, o sistema cobra uma vez; se ele insistir, o chat mostra um aviso.

## Testes

`npm test` usa um Gemini simulado, sem gastar tokens nem acessar a internet. O banco dos testes é `TEST_DATABASE_URL`: cada arquivo de teste cria um esquema temporário nele e o apaga no fim, sem tocar nos seus dados.

## Estrutura

- `index.js`: inicia o servidor (e o encerra sem cortar respostas em andamento)
- `src/db/connection.js`: conexão com o PostgreSQL, transações e migrações
- `src/db/migrations/`: estrutura do banco, em versões
- `src/services/imageStore.js`: imagens guardadas no banco
- `src/routes/tables.js` e `src/services/tables.js`: mesas em grupo (convite, aprovação, fichas)
- `src/routes/tablePlay.js`: jogo na mesa (chat, rolagens, painel, iniciativa, Biblioteca, imagens, notas)
- `src/services/tableHub.js`: tempo real das mesas (Server-Sent Events)
- `src/services/partyState.js`: ajustes de PV e estado (Solo e mesas)
- `public/js/tables.js`: aba Mesas (lista, convite, aprovação)
- `public/js/tour.js`: treinamentos guiados
- `public/js/table-play.js` e `public/js/table-presets.js`: telas do jogo na mesa e modelos prontos de monstros e NPCs
- `src/routes/templates.js` e `public/js/templates.js`: Meus modelos
- `src/routes/`: rotas da API (`auth.js` para login, `admin.js` para o painel, `config.js` para o teste da chave)
- `src/middleware/auth.js`: `authenticateToken`, `requireAdmin` e `requireGeminiKey`
- `src/services/auth.js`: senhas, tokens e conta admin
- `src/services/access.js`: quem pode ver cada personagem e campanha
- `src/services/gameMaster.js`: turno do Mestre, consultas e resumo
- `src/services/gemini.js` e `geminiImages.js`: clientes do Gemini e mensagens de erro
- `src/services/promptBuilder.js`: regras e contexto enviados ao modelo
- `src/services/memory.js`: memórias e buscas
- `src/services/sheet.js`: ficha 5e e valores calculados
- `src/services/state.js` e `dice.js`: estado de jogo e rolagens
- `scripts/create-admin.js`: cria a conta admin
- `scripts/migrate-sqlite.js`: importa os dados da versão SQLite
- `scripts/ingest-rules.js`: indexação dos livros
- `public/`: interface

## Créditos

Os modelos prontos de monstros e NPCs (`public/js/table-presets.js`) usam material do System Reference Document 5.1 ("SRD 5.1") da Wizards of the Coast LLC, disponível em https://dnd.wizards.com/resources/systems-reference-document e licenciado sob a Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode). Os nomes e textos foram traduzidos e resumidos.
