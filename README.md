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

Não existe etapa de instalação: o projeto usa apenas módulos nativos do Node (`http`, `fs`, `path`) e JavaScript no navegador.

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

Roda os 11 casos do motor (`shared/engine.js`) e os 8 casos de identidade por janela no Node. A suíte do motor também pode ser aberta em `tests/engine.test.html`.

## Publicação

O app roda no **Firebase App Hosting** (Cloud Run) no projeto `retro-special-pgennari` e é publicado automaticamente a cada push na branch `main`.

- Workflow: `.github/workflows/firebase-deploy.yml`
- Configuração do backend: `apphosting.yaml` e `firebase.json`
- Deploy manual: `firebase deploy --only apphosting --project retro-special-pgennari`
- Autenticação do GitHub Actions: Workload Identity Federation com a service account `github-deployer@retro-special-pgennari.iam.gserviceaccount.com` (secrets `GCP_WORKLOAD_IDENTITY_PROVIDER` e `GCP_SERVICE_ACCOUNT`).

O App Hosting exige o plano **Blaze**. Como as salas ficam em memória e o tempo real usa SSE, o backend é limitado a **uma instância** (`minInstances: 1`, `maxInstances: 1`); reinícios e novas versões limpam as salas em andamento.

## Estrutura

```
server.js                 servidor HTTP + SSE, sem dependências
shared/engine.js          regras e estado da sala (Node + navegador)
public/index.html         marcação da home e da sala
public/assets/css/        visual retrô/neon, responsivo e animações
public/assets/js/
  ui.js                   avatares, toasts, modais, utilidades
  identity.js             identidade local e compressão de foto
  api.js                  REST + SSE (produção) e adaptador demo
  home.js                 identificação, criar/entrar
  room.js                 sala, cards, dinâmica, arrastar e placar
  app.js                  rotas em hash e bootstrap
tests/                    casos do motor e de identidade (navegador e Node)
apphosting.yaml           configuração do Firebase App Hosting
firebase.json             backend e deploy do App Hosting
.github/workflows/        deploy automático no push para main
```

## Notas

- As salas vivem em memória no servidor e são limpas após 6 horas sem atividade. Reiniciar o processo apaga as salas.
- O conteúdo dos cards é enviado ao navegador antes da revelação — o desfoque é visual, como pede a experiência. A autoria dos cards **não** é enviada ao navegador; a das respostas da dinâmica só aparece quando o organizador revela cada uma.
- Fotos são reduzidas para 192 × 192 JPEG no cliente antes de serem enviadas.
