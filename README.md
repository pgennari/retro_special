# Retro Special

Board de retrospectiva de sprint com **Acertos**, **Melhorias** e uma **dinâmica de adivinhação** — em tempo real, sem cadastro.

![Node](https://img.shields.io/badge/Node.js-18%2B-b6ff5c?style=flat-square) ![Ícones](https://img.shields.io/badge/ícones-Phosphor-5ce1ff?style=flat-square) ![Tempo real](https://img.shields.io/badge/tempo%20real-WebSocket%20%2B%20SSE-ff7ab6?style=flat-square)

## Como rodar

```bash
npm install
node server.js
# ou
npm start
```

Abra **http://localhost:3030**. Para mudar a porta:

```bash
PORT=4000 node server.js
```

A única dependência de servidor é `ws`, usada pelo canal WebSocket; o resto do backend usa recursos nativos do Node (`http`, `fs`, `path`, `crypto` e `fetch`). Os ícones usam a biblioteca [Phosphor Icons](https://phosphoricons.com/) via CDN. Sem variáveis de ambiente, as salas ficam em memória. Para testar o Firestore localmente, defina `FIREBASE_SERVICE_ACCOUNT` e `FIREBASE_PROJECT_ID` no shell (há um modelo em `.env.example`; o Node não carrega esse arquivo sozinho).

## O que tem

### Identidade
- Nome + foto (recortada e comprimida no navegador) ou avatar emoji.
- A identidade fica salva no navegador (`localStorage`): ao fechar e reabrir o browser, a mesma pessoa entra novamente nas salas em que estava.
- Para entrar como outra pessoa no mesmo navegador, use **trocar pessoa** na tela inicial.
- Já dentro da sala, clique no seu nome/avatar no cabeçalho para editar nome e avatar (inclusive enviar uma nova foto); a alteração aparece para todo mundo na hora.
- Cada pessoa recebe uma cor própria na sala.

### Sala
- Crie uma sala (você vira **organizador**) ou entre com o código de 6 caracteres.
- O organizador pode dar/editar um **título** clicando nele no cabeçalho; ele aparece para todas as pessoas da sala.
- Link de convite (`/sala/CODIGO`) leva direto para a sala — e pede a identificação se ainda não houver.
- Presença ao vivo, pessoas conectadas/offline e remoção de participantes pelo organizador.
- O organizador pode promover pessoas conectadas a **Moderador** (e rebaixar depois) na lista de pessoas da sala.
- Sincronização por **WebSocket** (`wss://…/ws/rooms/CODIGO?userId=…`); SSE e polling REST entram automaticamente se o proxy bloquear o upgrade.
- O organizador pode **chamar a turma para a Dinâmica**: quem estiver em outra aba vê o botão da Dinâmica triplicar e sacudir.
- Na votação, o organizador pode **chamar atenção**: os cards ainda sem palpite sacodem para quem está com votos pendentes.
- **📄 Exportar PDF** aparece só para organizador e moderadores e baixa um relatório com os cards de Acertos e Melhorias, joinhas, plano de ação e responsáveis. Cards ainda não revelados aparecem como ocultos.
- Ao sair (ou fechar o browser), seu lugar é mantido: volte quando quiser usando o código.

### Acertos e Melhorias
- Todos adicionam cards **anônimos** (a autoria não aparece para ninguém); o conteúdo fica **oculto** até o organizador revelar o bloco. Texto, plano de ação e responsáveis não são enviados ao cliente nem entram no DOM antes da revelação.
- Depois da revelação, os cards ganham **joinhas** (👍) com animação e esquentam conforme recebem votos. A partir daí, somente o organizador pode remover cards.
- O organizador pode usar **🙈 Ocultar tudo** para voltar a esconder os conteúdos; joinhas e planos de ação são preservados para uma próxima revelação.
- O interruptor **Apresentando** esconde o conteúdo dos cards escritos pelo organizador, para a tela compartilhada não mostrar a resposta dele.
- Após a revelação, organizador e moderadores podem **mesclar cards semelhantes**: marque pelo menos 2 cards e use “Mesclar”. O primeiro marcado vira o card base; textos, joinhas e planos são combinados e os demais cards são removidos.
- Em Melhorias, o organizador define um **plano de ação** por card e escolhe os responsáveis.

### Administração
- Área separada em **/admin** (ou `#/admin`), protegida por `ADMIN_KEY` no servidor.
- Lista todas as salas com busca por código ou organizador, pessoas online e contagem de cards.
- Permite remover qualquer pessoa (inclusive o organizador, que passa o papel para a próxima pessoa), adicionar, editar e apagar cards de Acertos ou Melhorias e encerrar a sala.
- As ações de card ignoram as regras de fase/revelação do organizador; a autoria continua oculta para os participantes.
- A chave fica apenas no `sessionStorage` da janela e é enviada no cabeçalho `Authorization`. Sem `ADMIN_KEY`, as rotas de administração respondem `503`.

### Dinâmica
1. O organizador escreve a pergunta e pode ocultá-la/exibi-la quando quiser.
2. Libera as respostas; cada participante envia a sua (pode atualizar enquanto a fase estiver ativa).
3. Quando todos os conectados respondem, o organizador **embaralha**: uma animação mistura e apaga os avatares, e as respostas aparecem sem autoria.
4. Todos arrastam (ou tocam) pessoas para as respostas que acham que cada uma escreveu. Os palpites aparecem para todo mundo, mas **quem fez cada palpite só é identificado quando o organizador revela o autor daquela resposta**.
5. Com todos os palpites dados, o organizador **encerra a votação** e trava as alterações.
6. Os autores são revelados **um por um**; cada acerto vale **1 ponto** e o placar sobe ao vivo.
7. Ao final, o organizador pode iniciar uma nova fase.

Quem entra no meio da votação ou da revelação acompanha como espectador até a próxima fase.

## Modo demonstração

Sem servidor, abra `public/index.html` direto no navegador (`file://`) ou adicione `?demo=1` à URL. Nesse modo:

- as salas ficam no `localStorage`;
- a sincronização entre abas usa `BroadcastChannel` (com fallback para o evento `storage`);
- a identidade também fica no `localStorage`, então as abas começam com a mesma pessoa;
- use **trocar pessoa** em uma das abas para simular outra participante.

O modo demo é ótimo para experimentar, mas não persiste entre navegadores nem entre dispositivos.

## Testes

```bash
npm test
```

Roda os 25 casos do motor (`public/assets/js/engine.js`), os 8 casos de identidade por janela, os 8 casos de persistência (codec, fila de gravação e integração REST), os 3 casos do cliente Firestore e os testes de administração, fallback de estado/SSE e WebSocket. A suíte do motor também pode ser aberta em `tests/engine.test.html`.

## Publicação (plano Spark)

O app é dividido em três partes, sem sair do plano gratuito do Firebase:

| Parte | Onde roda | O que faz |
| --- | --- | --- |
| Front-end | **Firebase Hosting** | HTML, CSS, JS e o motor compartilhado |
| API + tempo real | **Render (free)** | REST, SSE e regras da sala |
| Dados | **Firestore** | Salas e fotos dos participantes |

O Firebase Hosting não faz proxy para fora do Firebase, então o navegador chama a API do Render diretamente. O backend libera CORS apenas para as origens configuradas em `ALLOWED_ORIGINS`.

O SSE é o canal preferencial, mas redes protegidas podem bloquear ou bufferizar o `EventSource` a ponto de ele nunca receber os headers. Se isso acontecer, o front-end detecta a ausência de `onopen` em 6 segundos e passa a consultar `GET /api/rooms/:code/state` a cada 2,5 segundos (indicado como "ao vivo (compatível)" na sala), voltando ao SSE automaticamente assim que ele conseguir conectar.

### 1. Firestore

1. No console do Firebase, abra **Firestore Database** e crie o banco em modo **Native**.
2. O navegador não acessa o Firestore: mantenha as regras bloqueadas (`firestore.rules`). Aplique uma vez com `firebase deploy --only firestore:rules --project retro-special-pgennari` ou cole o conteúdo no console.
3. Crie uma service account com o papel **Cloud Datastore User** (`roles/datastore.user`) e baixe o JSON.
4. No Render, defina `FIREBASE_SERVICE_ACCOUNT` com o **conteúdo do JSON** (ou o JSON em base64). `FIREBASE_PROJECT_ID` já vem no `render.yaml`.

Sem `FIREBASE_SERVICE_ACCOUNT`, o servidor roda em memória — útil só para desenvolvimento e testes.

### 2. Backend no Render

1. Crie um **Blueprint** no Render apontando para este repositório; o `render.yaml` configura o serviço `retro-special-api`.
2. Preencha os secrets `FIREBASE_SERVICE_ACCOUNT` e `ADMIN_KEY` no painel e confira as origens em `ALLOWED_ORIGINS`.
3. A URL esperada é `https://retro-special-api.onrender.com`. Se o Render escolher outro nome, atualize `public/assets/js/config.js`.
4. Confirme em `https://retro-special-api.onrender.com/api/health` que aparece `"persistence": "firestore"`.
5. Abra `https://retro-special.web.app/admin` e entre com a `ADMIN_KEY` para validar o painel.

O plano free do Render dorme após alguns minutos sem tráfego; a primeira visita depois disso pode demorar. As salas continuam no Firestore. O backend deve continuar em **uma única instância** porque as conexões SSE e o cache de salas vivem no processo.

### 3. Front-end no Firebase Hosting

- Workflow: `.github/workflows/firebase-deploy.yml` (testa e publica a cada push na `main`).
- URL principal: **https://retro-special.web.app**
- Espelho mantido no ar: **https://retro-special-pgennari.web.app**
- Deploy manual: `firebase deploy --only hosting --project retro-special-pgennari` (publica nos dois sites configurados em `firebase.json`)
- Autenticação do GitHub Actions: Workload Identity Federation com a service account `github-deployer@retro-special-pgennari.iam.gserviceaccount.com` (secrets `GCP_WORKLOAD_IDENTITY_PROVIDER` e `GCP_SERVICE_ACCOUNT`). Ela precisa da permissão de **Firebase Hosting Admin**.

O App Hosting saiu da configuração do repositório (`apphosting.yaml` não existe mais). O backend antigo **retro-special** está inativo e a URL dele responde 404. Com o projeto no plano **Spark**, a API do App Hosting recusa até a exclusão do registro (`403 — please check billing account`); ele pode ficar como registro inerte, pois não gera cobrança. Só seria possível apagá-lo reativando o billing temporariamente.

O backend do Render e o Firestore têm camadas gratuitas; o Hosting no Spark inclui 10 GB/mês de transferência.

## Estrutura

```
server.js                 servidor HTTP + SSE
lib/firestore.js          cliente REST do Firestore (JWT RS256 com crypto)
lib/store.js              cache de salas, fila de gravação e fotos
public/index.html         marcação da home e da sala
public/assets/css/        visual de papel/cartoon, responsivo e animações
public/assets/js/
  engine.js               regras e estado da sala (Node + navegador)
  ui.js                   avatares, toasts, modais, utilidades
  identity.js             identidade local e compressão de foto
  config.js               endereço da API (Render)
  api.js                  REST + SSE (produção) e adaptador demo
  home.js                 identificação, criar/entrar
  room.js                 sala, cards, dinâmica, arrastar e placar
  admin.js                painel /admin: salas, pessoas e cards
  app.js                  rotas em hash e bootstrap
tests/                    motor, identidade, persistência e administração (Node e navegador)
render.yaml               backend free no Render
firebase.json             deploy do Firebase Hosting
firestore.rules           bloqueia acesso direto do navegador
.github/workflows/        deploy automático do front-end no push para main
```

## Notas

- As salas são persistidas no Firestore e expiram após 6 horas sem atividade. O Render pode dormir sem perder os dados; ao acordar, a sala é carregada sob demanda.
- O painel ADMIN lista todas as salas ainda persistidas, inclusive as expiradas ou gravadas com um formato antigo; abrir uma delas no admin não apaga o documento.
- No Render, o WebSocket usa a mesma porta do HTTP (`wss://`). O cliente envia um ping a cada 25 s para manter o serviço free ativo e detectar conexões mortas.
- As fotos ficam em subdocumentos (`rooms/{code}/avatars/{userId}`) para não estourar o limite de 1 MiB do documento principal.
- Antes da revelação, o conteúdo dos cards não é enviado ao navegador de quem não pode lê-lo (nem entra no DOM). O mesmo vale para respostas da dinâmica: autoria e autores só aparecem quando o organizador revela cada uma, e a autoria dos palpites só aparece junto com a revelação da resposta correspondente.
- Fotos são reduzidas para 192 × 192 JPEG no cliente antes de serem enviadas.
