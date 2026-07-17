// Engine de leitura: navega a árvore de lances de uma partida (linha principal
// e variantes aninhadas), anuncia cada passo na convenção do projeto e aceita
// mutações (jogar lances, comentar, editar cabeçalho). Mantém o CAMINHO atual
// (array de nós da raiz ao lance corrente) como única fonte de verdade —
// entrar/sair de variantes é só crescer/truncar esse array.

import { Chess } from '../vendor/chess.js';
import { anunciar, somLance } from './anunciador.js';
import {
  descreverLanceFalado, fraseXeque, resultadoFalado, nagsFalados, nomeCor,
  nomePeca, VALOR_PECAS,
} from './fala.js';
import {
  nivel, ehEntradaVariante, indicesDoCaminho, revalidarSubarvore,
  contarPodaSimulada,
} from './pgnArvore.js';

function novoNo(parent) {
  return {
    san: null, move: null, fen: null, numero: null, cor: null,
    comment: null, commentBefore: null, nags: [],
    children: [], parent,
  };
}

export class Leitura {
  /**
   * @param {object} partida objeto vindo de montarPartida()
   * @param {object} opcoes
   * @param {() => boolean} opcoes.perguntarBifurcacoes
   * @param {() => void} opcoes.aoMudar re-renderiza a tela após navegar
   * @param {() => void} opcoes.aoAlterar persiste após uma mutação
   * @param {(opcoes, escolher) => void} opcoes.aoAbrirBifurcacao abre o diálogo
   * @param {boolean} [opcoes.modoCriacao] aceita lances desde o início
   */
  constructor(partida, {
    perguntarBifurcacoes, aoMudar, aoAlterar, aoAbrirBifurcacao, modoCriacao = false,
  }) {
    this.partida = partida;
    this.perguntarBifurcacoes = perguntarBifurcacoes;
    this.aoMudar = aoMudar || (() => {});
    this.aoAlterar = aoAlterar || (() => {});
    this.aoAbrirBifurcacao = aoAbrirBifurcacao || (() => {});
    this.modoCriacao = modoCriacao;
    this.caminho = [partida.raiz];
    this.modificada = false;
  }

  // ---------------- Acesso à posição ----------------

  get atual() {
    return this.caminho[this.caminho.length - 1];
  }

  get ehRaiz() {
    return this.atual === this.partida.raiz;
  }

  fenAtual() {
    return this.atual.fen || this.partida.fenInicial;
  }

  chessAtual() {
    return new Chess(this.fenAtual());
  }

  emVariante() {
    return nivel(this.atual) > 0;
  }

  // ---------------- Estado para renderização ----------------

  estado() {
    const atual = this.atual;
    const emVar = this.emVariante();
    return {
      ehRaiz: this.ehRaiz,
      no: atual,
      move: atual.move,
      fen: this.fenAtual(),
      emVariante: emVar,
      nivel: nivel(atual),
      podeAvancar: atual.children.length > 0,
      podeVoltar: this.caminho.length > 1,
      podeSairVariante: emVar,
      podeVoltarPrincipal: emVar,
      temVariantesNoLance: this._temVariantesNoLance(),
      indicador: this._indicador(),
      comentario: atual.comment || '',
      resultado: this.partida.resultado,
    };
  }

  _temVariantesNoLance() {
    if (this.ehRaiz) return this.partida.raiz.children.length > 1;
    return this.atual.parent.children.length > 1;
  }

  _indicador() {
    const idx = this.caminho.length - 1; // meios-lances desde o início
    if (!this.emVariante()) {
      const total = this._comprimentoLinha(this.partida.raiz);
      return `Lance ${idx} de ${total}`;
    }
    // Dentro de variante: contar a partir do início da variante interna.
    const entrada = this._entradaVarInterna();
    const iStart = entrada ? entrada.i : 1;
    const n = this.caminho.length - iStart; // 1 = primeiro lance da variante
    const cauda = this._comprimentoCauda(this.atual);
    const m = n + cauda;
    return `Variante, lance ${n} de ${m}`;
  }

  // Comprimento total da linha principal (seguindo sempre children[0]).
  _comprimentoLinha(raiz) {
    let n = 0;
    let no = raiz;
    while (no.children[0]) { no = no.children[0]; n++; }
    return n;
  }

  // Quantos lances ainda há à frente seguindo children[0] a partir de `no`.
  _comprimentoCauda(no) {
    let n = 0;
    let cur = no;
    while (cur.children[0]) { cur = cur.children[0]; n++; }
    return n;
  }

  // ---------------- Navegação ----------------

  proximo() {
    const atual = this.atual;
    const filhos = atual.children;
    if (filhos.length === 0) {
      anunciar(this.emVariante() ? 'Fim da variante.' : 'Fim dos lances.');
      return;
    }
    if (filhos.length === 1 || !this.perguntarBifurcacoes()) {
      this._entrar(filhos[0], { principal: true });
      return;
    }
    // Bifurcação: abre o diálogo antes de jogar nada.
    this._abrirBifurcacao(filhos, (escolhido) => {
      if (!escolhido) {
        anunciar(`Ficou em ${this._faladoNo(atual) || 'início da partida'}.`);
        return;
      }
      const ehVar = filhos.indexOf(escolhido) > 0;
      this._entrar(escolhido, { principal: !ehVar });
    });
  }

  anterior() {
    if (this.caminho.length <= 1) {
      anunciar('Início da partida.');
      this.aoMudar();
      return;
    }
    this.caminho.pop();
    if (this.caminho.length === 1) {
      somLance(false);
      anunciar('Início da partida.');
      this.aoMudar();
      return;
    }
    const no = this.atual;
    somLance(Boolean(no.move && no.move.captured));
    anunciar(`Voltou. ${this._faladoNo(no)}.`);
    this.aoMudar();
  }

  inicio() {
    this.caminho = [this.partida.raiz];
    somLance(false);
    anunciar('Início da partida.');
    this.aoMudar();
  }

  // Final da LINHA atual: dentro de variante vai ao fim dela; na principal,
  // corre até o fim sem parar nas bifurcações.
  fim() {
    const emVar = this.emVariante();
    let no = this.atual;
    while (no.children[0]) {
      no = no.children[0];
      this.caminho.push(no);
    }
    const captura = Boolean(no.move && no.move.captured);
    somLance(captura);
    if (emVar) {
      anunciar(`Fim da variante. ${this._faladoNo(no)}.`);
    } else {
      const lances = Math.ceil((this.caminho.length - 1) / 2);
      anunciar(`Final. ${this._resultadoFrase()} em ${lances} lances.`);
    }
    this.aoMudar();
  }

  sairVariante() {
    const entrada = this._entradaVarInterna();
    if (!entrada) {
      anunciar('Você está na linha principal.');
      return;
    }
    this.caminho = this.caminho.slice(0, entrada.i); // termina no pai da variante
    const no = this.atual;
    if (this.emVariante()) {
      anunciar(`Ainda em variante, nível ${nivel(no)}. ${this._faladoNo(no)}.`);
    } else {
      anunciar(`Linha principal. ${this._faladoNo(no) || 'início da partida'}.`);
    }
    somLance(false);
    this.aoMudar();
  }

  voltarPrincipal() {
    const entrada = this._entradaVarExterna();
    if (!entrada) {
      anunciar('Você está na linha principal.');
      return;
    }
    this.caminho = this.caminho.slice(0, entrada.i);
    const no = this.atual;
    anunciar(`Linha principal. ${this._faladoNo(no) || 'início da partida'}.`);
    somLance(false);
    this.aoMudar();
  }

  // "Variantes do lance"/↓: reabre a bifurcação do lance atual, sob demanda.
  variantesDoLance() {
    if (!this._temVariantesNoLance()) {
      anunciar('Este lance não tem variantes.');
      return;
    }
    if (this.ehRaiz) {
      // Na posição inicial: escolher entre os primeiros lances alternativos.
      const filhos = this.partida.raiz.children;
      this._abrirBifurcacao(filhos, (escolhido) => {
        if (!escolhido) { anunciar('Ficou no início da partida.'); return; }
        const ehVar = filhos.indexOf(escolhido) > 0;
        this._entrar(escolhido, { principal: !ehVar });
      });
      return;
    }
    const atual = this.atual;
    const pai = atual.parent;
    const irmaos = pai.children;
    this._abrirBifurcacao(irmaos, (escolhido) => {
      if (!escolhido || escolhido === atual) {
        anunciar(`Ficou em ${this._faladoNo(atual)}.`);
        return;
      }
      // Desfaz o lance atual e entra na linha escolhida.
      this.caminho.pop();
      const ehVar = irmaos.indexOf(escolhido) > 0;
      this._entrar(escolhido, { principal: !ehVar });
    });
  }

  // Salta direto para um nó qualquer da árvore (ativação na lista de lances).
  irParaNo(no) {
    const caminho = [];
    let n = no;
    while (n) { caminho.unshift(n); n = n.parent; }
    this.caminho = caminho;
    const captura = Boolean(no.move && no.move.captured);
    somLance(captura);
    if (this.ehRaiz) {
      anunciar('Início da partida.');
    } else if (this.emVariante()) {
      anunciar(`Variante. ${this._faladoNo(no)}.`);
    } else {
      anunciar(`${this._faladoNo(no)}.`);
    }
    this.aoMudar();
  }

  // Repete o anúncio do lance atual (comando "r"), com contexto de variante.
  repetir() {
    if (this.ehRaiz) {
      anunciar('Início da partida. Nenhum lance executado.');
      return;
    }
    const no = this.atual;
    const d = nivel(no);
    const prefixo = d >= 2 ? `Variante, nível ${d}: ` : (d === 1 ? 'Variante: ' : '');
    let texto = `${prefixo}${descreverLanceFalado(no.move)}.${fraseXeque(no.san)}`;
    const extras = this._extrasFalados(no);
    if (extras) texto += ` ${extras}`;
    anunciar(texto);
  }

  // Capturas da linha atual + vantagem de material (comando "m"), na mesma
  // fórmula falada do relógio. A vantagem sai da contagem do tabuleiro, para
  // valer também em partidas que começam de um FEN.
  material() {
    const capturas = { w: [], b: [] };
    for (const no of this.caminho) {
      if (no.move && no.move.captured) capturas[no.move.color].push(no.move.captured);
    }
    const listar = (lista) => (lista.length ? lista.map((p) => nomePeca(p)).join(', ') : 'nada');
    const chess = this.chessAtual();
    let saldo = 0;
    for (const linha of chess.board()) {
      for (const casa of linha) {
        if (!casa || casa.type === 'k') continue;
        saldo += (casa.color === 'w' ? 1 : -1) * (VALOR_PECAS[casa.type] || 0);
      }
    }
    let vantagem;
    if (saldo > 0) {
      vantagem = `Vantagem material: brancas, ${saldo} ${saldo === 1 ? 'ponto' : 'pontos'}.`;
    } else if (saldo < 0) {
      vantagem = `Vantagem material: pretas, ${-saldo} ${-saldo === 1 ? 'ponto' : 'pontos'}.`;
    } else {
      vantagem = 'Material igual.';
    }
    anunciar(`Brancas capturaram: ${listar(capturas.w)}. Pretas capturaram: ${listar(capturas.b)}. ${vantagem}`);
  }

  // ---------------- Mutação (criação/edição) ----------------

  // Joga um lance SAN a partir da posição atual. Cria variante se já houver
  // continuação diferente; apenas avança se o lance já existir.
  jogarLance(san) {
    const chess = this.chessAtual();
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      return { ok: false, mensagem: `Lance ilegal nesta posição: ${san}.` };
    }
    const atual = this.atual;
    const existente = atual.children.find((c) => c.san === mv.san);
    if (existente) {
      this._entrar(existente, { principal: atual.children.indexOf(existente) === 0 });
      return { ok: true };
    }
    const idx = atual.children.length;
    const no = novoNo(atual);
    no.san = mv.san;
    no.move = mv;
    no.fen = chess.fen();
    no.cor = mv.color;
    no.numero = Number(atual.fen ? atual.fen.split(' ')[5] : this.partida.fenInicial.split(' ')[5]);
    atual.children.push(no);
    this.caminho.push(no);

    if (idx > 0) {
      anunciar(`Variante criada: ${descreverLanceFalado(mv)}${fraseXeque(mv.san)}`);
    } else {
      anunciar(`${descreverLanceFalado(mv)}.${fraseXeque(mv.san)}`);
    }
    somLance(Boolean(mv.captured));
    // Só a linha principal decide o placar: anotar variantes nunca pode
    // reescrever o resultado de uma partida importada.
    if (!this.emVariante()) this._atualizarResultado(chess, mv);
    this._marcarAlterada();
    this.aoMudar();
    return { ok: true };
  }

  // Quantos lances existem na continuação abaixo do lance atual (o que uma
  // apagação levaria junto, além do próprio lance).
  contarContinuacao() {
    if (this.ehRaiz) return 0;
    const conta = (n) => n.children.reduce((soma, c) => soma + 1 + conta(c), 0);
    return conta(this.atual);
  }

  // Apaga o lance atual da árvore (comando "back" / botão "Apagar lance"),
  // junto com toda a continuação abaixo dele. A leitura volta à posição
  // anterior. Se o lance era da linha principal e tinha variantes irmãs, a
  // primeira variante é promovida a continuação principal.
  apagarLanceAtual() {
    if (this.ehRaiz) {
      anunciar('Nenhum lance para apagar aqui.');
      return { ok: false };
    }
    const no = this.atual;
    const pai = no.parent;
    const idx = pai.children.indexOf(no);
    const eraPrincipal = !this.emVariante();
    const promovida = idx === 0 && pai.children.length > 1;
    pai.children.splice(idx, 1);
    this.caminho.pop();
    // A linha principal mudou: o resultado é recalculado da nova ponta.
    // Apagar dentro de variante não toca no resultado.
    if (eraPrincipal) this._recalcularResultado();
    this._marcarAlterada();
    const onde = this.ehRaiz ? 'Início da partida' : this._faladoNo(this.atual);
    if (promovida && pai.children.length > 0) {
      anunciar(`Lance apagado; a variante virou a linha principal. ${onde}.`);
    } else {
      anunciar(`Lance apagado. ${onde}.`);
    }
    somLance(false);
    this.aoMudar();
    return { ok: true };
  }

  // Avalia uma correção SEM aplicar nada: valida o lance novo e conta
  // quantos lances seguintes ficariam ilegais. Anuncia os erros de validação;
  // retorna null se a correção não é possível, ou { mv, removidos }.
  avaliarCorrecao(san) {
    if (this.ehRaiz) {
      anunciar('Nenhum lance para corrigir aqui. Navegue até o lance errado.');
      return null;
    }
    const no = this.atual;
    const pai = no.parent;
    const chess = new Chess(pai.fen || this.partida.fenInicial);
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      anunciar(`Lance ilegal nesta posição: ${san}.`);
      return null;
    }
    if (mv.san === no.san) {
      anunciar(`O lance já é ${descreverLanceFalado(mv)}.`);
      return null;
    }
    if (pai.children.some((c) => c !== no && c.san === mv.san)) {
      anunciar(`${descreverLanceFalado(mv)} já existe como outra linha deste ponto. `
        + 'Use Variantes do lance para trocar, ou apague este lance.');
      return null;
    }
    return { mv, removidos: contarPodaSimulada(no, chess.fen()) };
  }

  // Corrige o lance atual (comando "c <lance>"): substitui o lance mantendo
  // a continuação que seguir legal na nova posição — o resto é podado. A
  // confirmação da poda é responsabilidade de quem chama (avaliarCorrecao).
  // Sem nenhuma marca de "editado" no arquivo: a correção é limpa.
  corrigirLance(san) {
    if (this.ehRaiz) {
      anunciar('Nenhum lance para corrigir aqui. Navegue até o lance errado.');
      return { ok: false };
    }
    const no = this.atual;
    const pai = no.parent;
    const chess = new Chess(pai.fen || this.partida.fenInicial);
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      return { ok: false, mensagem: `Lance ilegal nesta posição: ${san}.` };
    }
    if (mv.san === no.san) {
      anunciar(`O lance já é ${descreverLanceFalado(mv)}.`);
      return { ok: false };
    }
    if (pai.children.some((c) => c !== no && c.san === mv.san)) {
      anunciar(`${descreverLanceFalado(mv)} já existe como outra linha deste ponto. `
        + 'Use Variantes do lance para trocar, ou apague este lance.');
      return { ok: false };
    }
    const eraPrincipal = !this.emVariante();
    no.san = mv.san;
    no.move = mv;
    no.fen = chess.fen();
    no.cor = mv.color;
    const removidos = revalidarSubarvore(no);
    if (eraPrincipal) this._recalcularResultado();
    this._marcarAlterada();
    let texto = `Corrigido para ${descreverLanceFalado(mv)}.${fraseXeque(mv.san)}`;
    if (removidos === 1) {
      texto += ' 1 lance seguinte ficou ilegal e foi removido.';
    } else if (removidos > 1) {
      texto += ` ${removidos} lances seguintes ficaram ilegais e foram removidos.`;
    } else if (no.children.length > 0) {
      texto += ' Continuação mantida.';
    }
    anunciar(texto);
    somLance(Boolean(mv.captured));
    this.aoMudar();
    return { ok: true };
  }

  _recalcularResultado() {
    let no = this.partida.raiz;
    while (no.children[0]) no = no.children[0];
    const chess = new Chess(no.fen || this.partida.fenInicial);
    let r = '*';
    if (chess.isCheckmate()) {
      r = chess.turn() === 'w' ? '0-1' : '1-0';
    } else if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDraw()) {
      r = '1/2-1/2';
    }
    this.partida.resultado = r;
    this.partida.tags.Result = r;
  }

  _atualizarResultado(chess, mv) {
    if (chess.isCheckmate()) {
      this.partida.resultado = mv.color === 'w' ? '1-0' : '0-1';
    } else if (chess.isStalemate() || chess.isInsufficientMaterial()
      || chess.isThreefoldRepetition() || chess.isDraw()) {
      this.partida.resultado = '1/2-1/2';
    } else {
      this.partida.resultado = '*';
    }
    this.partida.tags.Result = this.partida.resultado;
  }

  adicionarComentario(texto) {
    const limpo = (texto || '').replace(/[{}]/g, '').trim();
    const alvo = this.atual; // comentário do lance atual (ou da raiz, no início)
    alvo.comment = limpo || null;
    anunciar(limpo ? 'Comentário gravado.' : 'Comentário removido.');
    this._marcarAlterada();
    this.aoMudar();
  }

  editarCabecalho(tags) {
    for (const [chave, valor] of Object.entries(tags)) {
      const limpo = (valor || '').trim();
      if (limpo) this.partida.tags[chave] = limpo;
      else delete this.partida.tags[chave];
    }
    anunciar('Cabeçalho gravado.');
    this._marcarAlterada();
    this.aoMudar();
  }

  _marcarAlterada() {
    this.modificada = true;
    this.aoAlterar();
  }

  // ---------------- Internos ----------------

  _entrar(no, { principal }) {
    this.caminho.push(no);
    const ehVar = ehEntradaVariante(no);
    let texto;
    if (ehVar && !principal) {
      const d = nivel(no);
      const prefixo = d >= 2 ? `Variante, nível ${d}: ` : 'Variante: ';
      texto = `${prefixo}${descreverLanceFalado(no.move)}${fraseXeque(no.san)}`;
    } else {
      texto = `${descreverLanceFalado(no.move)}.${fraseXeque(no.san)}`;
    }
    const extras = this._extrasFalados(no);
    if (extras) texto += ` ${extras}`;
    anunciar(texto);
    somLance(Boolean(no.move && no.move.captured));
    this.aoMudar();
  }

  _extrasFalados(no) {
    const partes = [];
    const nag = nagsFalados(no.nags);
    if (nag) partes.push(nag);
    if (no.comment) partes.push(`Comentário: ${no.comment}`);
    return partes.join('. ');
  }

  _faladoNo(no) {
    if (!no || !no.move) return '';
    return `${descreverLanceFalado(no.move)}${sufixoLeve(no.san)}`;
  }

  _resultadoFrase() {
    const r = resultadoFalado(this.partida.resultado);
    return r.charAt(0).toUpperCase() + r.slice(1);
  }

  // Entrada de variante mais interna ao longo do caminho (índice no caminho).
  _entradaVarInterna() {
    for (let i = this.caminho.length - 1; i >= 1; i--) {
      const no = this.caminho[i];
      if (no.parent.children.indexOf(no) > 0) return { no, i };
    }
    return null;
  }

  // Entrada de variante mais externa (primeira do caminho).
  _entradaVarExterna() {
    for (let i = 1; i < this.caminho.length; i++) {
      const no = this.caminho[i];
      if (no.parent.children.indexOf(no) > 0) return { no, i };
    }
    return null;
  }

  _abrirBifurcacao(filhos, escolher) {
    const opcoes = filhos.map((no, i) => ({
      no,
      ehPrincipal: i === 0,
      rotulo: this._rotuloOpcao(no, i === 0),
    }));
    this.aoAbrirBifurcacao(opcoes, escolher);
  }

  _rotuloOpcao(no, ehPrincipal) {
    const base = descreverLanceFalado(no.move) + sufixoLeve(no.san);
    if (ehPrincipal) return `Linha principal: ${base}`;
    let texto = `Variante: ${base}`;
    // Acrescenta o lance seguinte, quando ajudar a distinguir.
    if (no.children[0]) {
      texto += `, depois ${descreverLanceFalado(no.children[0].move)}`;
    }
    const coment = no.commentBefore || no.comment;
    if (coment) texto += ` — ${coment}`;
    return texto;
  }

  // Índices de escolha do caminho, para persistir e retomar.
  indicesAtuais() {
    return indicesDoCaminho(this.caminho);
  }
}

// Sufixo de xeque curto para rótulos ("cavalo felix 3, xeque").
function sufixoLeve(san) {
  if (!san) return '';
  if (san.endsWith('#')) return ', xeque-mate';
  if (san.endsWith('+')) return ', xeque';
  return '';
}
