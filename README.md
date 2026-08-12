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

### Cinco portas para abrir um PGN

1. **Compartilhar com o app** (Web Share Target) — no Android, com o PWA
   instalado, compartilhe um `.pgn` (ou o texto do PGN) e escolha o app.
2. **Abrir arquivo** — seletor de arquivos (funciona em todo lugar).
3. **Colar PGN ou FEN** — caixa de texto que aceita o PGN copiado ou um FEN
   solto (aí abre como posição avulsa, para explorar ou jogar dali).
4. **Control mais V na tela inicial** — abre o arquivo `.pgn` copiado no
   gerenciador de arquivos, ou o texto (PGN ou FEN) que estiver na área de
   transferência. Dentro das caixas de texto o atalho continua.

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
  local** dos PGNs guardados (até 20 arquivos), autossalvamento das
  alterações e "Continuar última leitura". Arquivo acima de ~500 mil
  caracteres é guardado **só de leitura**: reabre e retoma a posição, mas
  não guarda alterações.
- **Sem teto de espaço chutado e sem apagar nada sozinho**: o app não
  estima capacidade em bytes — tenta gravar, e o navegador diz se coube.
  Quando não cabe, **nenhum PGN é apagado para abrir espaço**: o arquivo
  abre e é lido normalmente, só não fica guardado, e o app avisa. Apagar é
  sempre ato explícito de quem usa. O botão **"Espaço do aparelho"**, na
  tela inicial, mede o teto real do navegador por tentativa e erro e
  mostra quanto está ocupado e quanto ainda cabe.
- **Dá para ler sem deixar rastro**: a caixa "Manter neste app os PGNs abertos" (ligada por padrão) desliga o armazenamento automático.
- **Coleções grandes**: o arquivo é lido preguiçosamente (a árvore de
  lances de cada partida só é montada ao abri-la), e a lista de escolha é
  paginada de 50 em 50 com salto por número de página ou de partida — um
  banco de 1,7 MB com 9.557 partidas abre em ~370 ms.

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

## Ao publicar uma mudança

**Incremente `VERSAO` no topo do `sw.js`.** O service worker guarda os arquivos
do app como um snapshot único e coerente: ou o cache inteiro é da versão
antiga, ou é inteiro da nova. Trocar o número é o que dispara o download do
snapshot novo nos aparelhos já instalados. Se esquecer, há uma rede de
segurança — o service worker compara o `index.html` publicado com o do cache —,
mas ela não cobre uma publicação que mexa só nos `.js`.

**Nunca apague "todos os caches menos o meu".** Este app e o
[relógio de xadrez](https://github.com/BrendaVittoria/relogio-xadrez-acessivel)
moram no mesmo endereço (`brendavittoria.github.io`, pastas diferentes), e o
armazenamento de caches é compartilhado por endereço, não por pasta: cada um
enxerga e pode apagar o cache do outro. Filtre sempre pelo prefixo
`leitor-pgn-`.

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
  anunciador.js       Anunciador aria-live central + sons de sounds/ (com "toc" de reserva)
  armazenamento.js    localStorage: guardados, última leitura, preferências
sounds/               Amostras mp3: lance, captura, mate e empate (do relógio)
vendor/chess.js       chess.js 1.x (motor de validação/reprodução)
icons/                Ícones do app e peças SVG (Cburnett)
```

O `chess.js` valida e reproduz os lances; a **árvore de variantes** é
mantida pelo parser próprio (`pgnArvore.js`), já que o `loadPgn` do chess.js
não a preserva.
