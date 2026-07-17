# Leitor de PGN Acessível

PWA estático (sem backend, sem build, sem framework) para **abrir e ler
partidas de xadrez em PGN**, lance a lance, com leitor de tela. Nasce da
mesma família do relógio de xadrez acessível — mesma filosofia de
acessibilidade, mesma convenção de fala fonética, mesma arquitetura
estática — mas voltado ao **estudo**: navegação por **variantes** (linhas
alternativas, inclusive aninhadas) faz parte do núcleo.

## Como usar

Abra o `index.html` por um servidor estático (os módulos ES exigem HTTP,
não `file://`). Para testar localmente:

```
python -m http.server 8100
# abra http://localhost:8100
```

### Quatro portas para abrir um PGN

1. **Compartilhar com o app** (Web Share Target) — no Android, com o PWA
   instalado, compartilhe um `.pgn` (ou o texto do PGN) e escolha o app.
2. **"Abrir com"** (File Handling API) — tocar num `.pgn` oferece o app.
3. **Abrir arquivo** — seletor de arquivos (funciona em todo lugar).
4. **Colar PGN** — caixa de texto para colar o PGN copiado.

Também dá para **Criar PGN** (partida nova ou a partir de um FEN) e jogar
lances por digitação ou pelo tabuleiro.

## Recursos

- **Navegação lance a lance** com anúncios curtos na convenção fonética de
  casas (`eva 4`, `cavalo felix 3`, `roque pequeno`, `xeque-mate`).
- **Variantes** com diálogo de bifurcação nativo (`<dialog>`): a escolha
  acontece na hora de avançar; aninhadas suportadas, com "Sair da
  variante" (um nível), "Voltar à linha principal" (todos) e "Variantes do
  lance" (sob demanda). Preferência **"Perguntar nas bifurcações"** para
  leitura direta.
- **Tabuleiro opcional** de alto contraste (baixa visão), com destaque
  forte do último lance e destaque distinto dentro de variante; oculto por
  padrão. Casas com `aria-label` fonético para exploração casa a casa.
- **Lista de lances em árvore** (listas aninhadas) com salto direto.
- **Painel de ações**: Copiar FEN, Colar FEN (posição avulsa), Descrever
  posição, Adicionar comentário, Editar cabeçalho, Salvar novo PGN
  (partida inteira ou só a linha atual), Restaurar original.
- **Criação/anotação**: jogar lances estende a linha; jogar diferente no
  meio cria variante (modelo do lichess). Tolerâncias de digitação do
  relógio (roques `o-o`, captura sem `x`, promoção sem `=`, desambiguação).
  A caixa de lances também aceita os comandos do relógio: `p` (resumo da
  posição), `m` (material capturado e vantagem), `r` (repete o lance
  atual), `a` ou `back` (apaga o lance atual — também no botão "Apagar
  lance" do painel de ações), `c <lance>` (corrige o lance atual mantendo
  a continuação que seguir legal, sem marca de edição; pede confirmação
  quando algum lance seguinte ficaria ilegal e seria removido) e `?`
  (ajuda). Digitar com o foco no tabuleiro leva
  a letra direto para a caixa.
- **PWA offline** (service worker com cache do app shell) e **persistência
  local** dos PGNs guardados (até 20 arquivos / ~2 MB, remoção automática
  do mais antigo), autossalvamento das alterações e "Continuar última
  leitura".

## Acessibilidade (herdada e validada no relógio)

- Um **único anunciador** central (`aria-live="polite"`), com o truque de
  limpar e regravar para forçar releitura de texto idêntico.
- Convenção fonética de casas (anna, bella, cesar, ...).
- Rótulos explícitos `for`/`id` em todo controle de formulário.
- `aria-expanded` em todo controle que revela/esconde conteúdo.
- Operação 100% por teclado (`←`/`→`/`,`/`.`, `Home`/`End`, `↑`/`Shift+↑`,
  `↓`); alvos de toque generosos (o "Próximo lance" é o maior).
- Erros específicos e falados — nunca falha em silêncio.
- Alto contraste e nada transmitido só por cor.

> Testar separadamente com **NVDA**, **VoiceOver** e **TalkBack** — são
> três leitores diferentes.

## Estrutura

```
index.html            Telas (inicial, lista, leitura) e diálogos nativos
styles.css            Tema escuro de alto contraste
manifest.webmanifest  PWA: share_target (POST) + file_handlers
sw.js                 Service worker: app shell offline + handler do POST
js/
  app.js              Orquestração: telas, ações, PWA
  leitura.js          Engine de navegação sobre a árvore (variantes, mutação)
  pgnArvore.js        Parser próprio: separa partidas + monta a árvore
  pgnGerar.js         Gera PGN da árvore (variantes/comentários) + linha
  tabuleiro.js        Tabuleiro acessível (destaque de lance e variante)
  parser.js           Interpretação tolerante de lances digitados (do relógio)
  fala.js             Fala fonética: lances, casas, resultado, NAGs, posição
  anunciador.js       Anunciador aria-live central + sons "toc"
  armazenamento.js    localStorage: guardados, última leitura, preferências
vendor/chess.js       chess.js 1.x (motor de validação/reprodução)
icons/                Ícones do app e peças SVG (Cburnett)
```

O `chess.js` valida e reproduz os lances; a **árvore de variantes** é
mantida pelo parser próprio (`pgnArvore.js`), já que o `loadPgn` do chess.js
não a preserva.

## Publicação

GitHub Pages, servindo a raiz do repositório. O script
[`scripts/ativar-github-pages.ps1`](scripts/ativar-github-pages.ps1) ajuda
a criar o repositório e ativar o Pages via `gh`.
