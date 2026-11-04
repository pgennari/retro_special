# Retro Special

Board de retrospectiva de sprint com **Acertos**, **Melhorias** e uma **dinâmica de adivinhação** — em tempo real, sem cadastro e sem dependências.

![Node](https://img.shields.io/badge/Node.js-18%2B-b6ff5c?style=flat-square) ![Sem dependências](https://img.shields.io/badge/dependências-0-5ce1ff?style=flat-square) ![Tempo real](https://img.shields.io/badge/tempo%20real-SSE-ff7ab6?style=flat-square)

## Como rodar

```bash
node server.js
# ou
npm start
```

Abra **http://localhost:3030**. Para mudar a porta:

```bash
PORT=4000 node server.js
```

Não existe etapa de instalação: o projeto usa apenas recursos nativos do Node (`http`, `fs`, `path`, `crypto` e `fetch`) e JavaScript no navegador. Sem variáveis de ambiente, as salas ficam em memória. Para testar o Firestore localmente, defina `FIREBASE_SERVICE_ACCOUNT` e `FIREBASE_PROJECT_ID` no shell (há um modelo em `.env.example`; o Node não carrega esse arquivo sozinho).

## O que tem

### Identidade
- Nome + foto (recortada e comprimida no navegador) ou avatar emoji.
- O perfil fica salvo no navegador e volta preenchido na próxima visita.
- **Cada janela/aba é uma pessoa:** abrir outra janela (inclusive anônima) sugere o perfil salvo, mas não entra como a pessoa da primeira janela. A identidade ativa fica no `sessionStorage`; o perfil, no `localStorage`.
- Cada pessoa recebe uma cor própria na sala.

### Sala
- Crie uma sala (você vira **organizador**) ou entre com o código de 6 caracteres.
- Link de convite (`/sala/CODIGO`) leva direto para a sala — e pede a identificação se ainda não houver.
- Presença ao vivo, pessoas conectadas/offline e remoção de participantes pelo organizador.
- Ao sair, seu lugar é mantido: volte quando quiser usando o código.

### Acertos e Melhorias
- Todos adicionam cards **anônimos** (a autoria não aparece para ninguém); o conteúdo fica **desfocado** até o organizador revelar o bloco.
- Depois da revelação, os cards ganham **joinhas** (👍) com animação e esquentam conforme recebem votos.
- Em Melhorias, o organizador define um **plano de ação** por card e escolhe os responsáveis.

### Dinâmica
1. O organizador escreve a pergunta e pode ocultá-la/exibi-la quando quiser.
2. Libera as respostas; cada participante envia a sua (pode atualizar enquanto a rodada estiver aberta).
3. Quando todos os conectados respondem, o organizador **embaralha**: uma animação mistura e apaga os avatares, e as respostas aparecem sem autoria.
4. Todos arrastam (ou tocam) pessoas para as respostas que acham que cada uma escreveu. Os palpites ficam públicos.
5. Com todos os palpites dados, o organizador **encerra a votação** e trava as alterações.
6. Os autores são revelados **um por um**; cada acerto vale **1 ponto** e o placar sobe ao vivo.
7. Ao final, o organizador pode iniciar uma nova rodada.

Quem entra no meio da votação ou da revelação acompanha como espectador até a próxima rodada.

## Modo demonstração

Sem servidor, abra `public/index.html` direto no navegador (`file://`) ou adicione `?demo=1` à URL. Nesse modo:

- as salas ficam no `localStorage`;
- a sincronização entre abas usa `BroadcastChannel` (com fallback para o evento `storage`);
- a identidade usa `sessionStorage`, então **cada aba pode ser uma pessoa diferente**;
- abra duas abas para testar a colaboração e a dinâmica completa.

O modo demo é ótimo para experimentar, mas não persiste entre navegadores nem entre dispositivos.

## Testes

```bash
npm test
```

Roda os 11 casos do motor (`public/assets/js/engine.js`), os 8 casos de identidade por janela e os 11 casos de persistência (codec, fila de gravação e integração REST). A suíte do motor também pode ser aberta em `tests/engine.test.html`.

## Publicação (plano Spark)

O app é dividido em três partes, sem sair do plano gratuito do Firebase:

| Parte | Onde roda | O que faz |
| --- | --- | --- |
| Front-end | **Firebase Hosting** | HTML, CSS, JS e o motor compartilhado |
| API + tempo real | **Render (free)** | REST, SSE e regras da sala |
| Dados | **Firestore** | Salas e fotos dos participantes |

O Firebase Hosting não faz proxy para fora do Firebase, então o navegador chama a API do Render diretamente. O backend libera CORS apenas para as origens configuradas em `ALLOWED_ORIGINS`.

### 1. Firestore

1. No console do Firebase, abra **Firestore Database** e crie o banco em modo **Native**.
2. O navegador não acessa o Firestore: mantenha as regras bloqueadas (`firestore.rules`). Aplique uma vez com `firebase deploy --only firestore:rules --project retro-special-pgennari` ou cole o conteúdo no console.
3. Crie uma service account com o papel **Cloud Datastore User** (`roles/datastore.user`) e baixe o JSON.
4. No Render, defina `FIREBASE_SERVICE_ACCOUNT` com o **conteúdo do JSON** (ou o JSON em base64). `FIREBASE_PROJECT_ID` já vem no `render.yaml`.

Sem `FIREBASE_SERVICE_ACCOUNT`, o servidor roda em memória — útil só para desenvolvimento e testes.

### 2. Backend no Render

1. Crie um **Blueprint** no Render apontando para este repositório; o `render.yaml` configura o serviço `retro-special-api`.
2. Preencha o secret `FIREBASE_SERVICE_ACCOUNT` no painel e confira as origens em `ALLOWED_ORIGINS`.
3. A URL esperada é `https://retro-special-api.onrender.com`. Se o Render escolher outro nome, atualize `public/assets/js/config.js`.
4. Confirme em `https://retro-special-api.onrender.com/api/health` que aparece `"persistence": "firestore"`.

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
server.js                 servidor HTTP + SSE, sem dependências
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
  app.js                  rotas em hash e bootstrap
tests/                    motor, identidade e persistência (Node e navegador)
render.yaml               backend free no Render
firebase.json             deploy do Firebase Hosting
firestore.rules           bloqueia acesso direto do navegador
.github/workflows/        deploy automático do front-end no push para main
```

## Notas

- As salas são persistidas no Firestore e expiram após 6 horas sem atividade. O Render pode dormir sem perder os dados; ao acordar, a sala é carregada sob demanda.
- As fotos ficam em subdocumentos (`rooms/{code}/avatars/{userId}`) para não estourar o limite de 1 MiB do documento principal.
- O conteúdo dos cards é enviado ao navegador antes da revelação — o desfoque é visual, como pede a experiência. A autoria dos cards **não** é enviada ao navegador; a das respostas da dinâmica só aparece quando o organizador revela cada uma.
- Fotos são reduzidas para 192 × 192 JPEG no cliente antes de serem enviadas.
