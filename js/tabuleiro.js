// Tabuleiro acessível: grade 8x8 de botões com navegação por setas, rótulos
// fonéticos e, para o leitor de PGN, destaque forte das casas de origem/destino
// do último lance (e um destaque distinto quando se está dentro de variante).
// Base copiada do relógio; estendida com destacarLance() e modo de exploração.

import { nomeCasa, PECAS, adjetivoCor } from './fala.js';

const COLUNAS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export class TabuleiroAcessivel {
  /**
   * @param {HTMLElement} container
   * @param {object} opcoes
   * @param {boolean} [opcoes.somenteLeitura] só explora casas, não move
   * @param {() => import('../vendor/chess.js').Chess} opcoes.obterChess
   * @param {(de, para, precisaPromocao) => void} [opcoes.aoTentarLance]
   * @param {(texto) => void} opcoes.anunciar
   * @param {(caractere) => void} [opcoes.aoDigitar] letra/dígito digitado com
   *   o foco numa casa; leva a digitação para a caixa de lances (como no
   *   relógio)
   */
  constructor(container, {
    somenteLeitura = false, obterChess, aoTentarLance, anunciar, aoDigitar,
  }) {
    this.container = container;
    this.somenteLeitura = somenteLeitura;
    this.obterChess = obterChess;
    this.aoTentarLance = aoTentarLance;
    this.anunciar = anunciar;
    this.aoDigitar = aoDigitar;
    this.selecionada = null;
    this.destaque = null; // { de, para, emVariante }
    this.botoes = new Map();
    this._montar();
  }

  _montar() {
    const grade = document.createElement('div');
    grade.className = 'tab-grade';
    grade.setAttribute('role', 'group');
    grade.setAttribute('aria-label', 'Tabuleiro');

    for (let linha = 8; linha >= 1; linha--) {
      for (let c = 0; c < 8; c++) {
        const casa = `${COLUNAS[c]}${linha}`;
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.className = `tab-casa ${(c + linha) % 2 === 0 ? 'clara' : 'escura'}`;
        botao.dataset.casa = casa;
        botao.tabIndex = -1;
        botao.addEventListener('click', () => this._aoAtivar(casa));
        this.botoes.set(casa, botao);
        grade.appendChild(botao);
      }
    }
    this.botoes.get('e2').tabIndex = 0;
    grade.addEventListener('keydown', (e) => this._aoTecla(e));

    const legenda = document.createElement('p');
    legenda.className = 'tab-coordenadas';
    legenda.textContent = 'Usuários de NVDA: ative o modo de foco com Insert mais Espaço ao navegar pelo tabuleiro.';

    this.container.textContent = '';
    this.container.appendChild(grade);
    this.container.appendChild(legenda);
    this.grade = grade;
  }

  _aoTecla(e) {
    const casa = e.target.dataset?.casa;
    if (!casa) return;
    const col = COLUNAS.indexOf(casa[0]);
    const linha = Number(casa[1]);
    let destino = null;
    switch (e.key) {
      case 'ArrowLeft': destino = col > 0 ? `${COLUNAS[col - 1]}${linha}` : null; break;
      case 'ArrowRight': destino = col < 7 ? `${COLUNAS[col + 1]}${linha}` : null; break;
      case 'ArrowUp': destino = linha < 8 ? `${casa[0]}${linha + 1}` : null; break;
      case 'ArrowDown': destino = linha > 1 ? `${casa[0]}${linha - 1}` : null; break;
      case 'Home': destino = `a${linha}`; break;
      case 'End': destino = `h${linha}`; break;
      case 'Escape':
        if (this.selecionada) {
          this.selecionada = null;
          this.atualizar();
          this.anunciar('Seleção cancelada.');
        }
        return;
      default:
        // letra/dígito/? sem modificador: a pessoa começou a digitar um lance
        // ou comando de dentro do tabuleiro — repassar para a caixa de lances
        if (
          this.aoDigitar && e.key.length === 1 && /[a-z0-9?]/i.test(e.key)
          && !e.ctrlKey && !e.altKey && !e.metaKey
        ) {
          e.preventDefault();
          this.aoDigitar(e.key);
        }
        return;
    }
    e.preventDefault();
    if (destino) this._focar(destino);
  }

  _focar(casa) {
    for (const botao of this.botoes.values()) botao.tabIndex = -1;
    const alvo = this.botoes.get(casa);
    alvo.tabIndex = 0;
    alvo.focus();
  }

  _aoAtivar(casa) {
    const chess = this.obterChess();
    const peca = chess.get(casa);

    if (this.somenteLeitura || !this.aoTentarLance) {
      this.anunciar(this._descricaoCasa(casa, peca));
      return;
    }

    if (!this.selecionada) {
      if (peca && peca.color === chess.turn()) {
        this.selecionada = casa;
        this.atualizar();
      } else if (peca) {
        this.anunciar(`${this._descricaoCasa(casa, peca)}. Não é a vez dessa cor.`);
      } else {
        this.anunciar(`${nomeCasa(casa)}. Selecione primeiro uma peça sua.`);
      }
      return;
    }

    if (casa === this.selecionada) {
      this.selecionada = null;
      this.atualizar();
      this.anunciar('Seleção cancelada.');
      return;
    }

    if (peca && peca.color === chess.turn()) {
      this.selecionada = casa;
      this.atualizar();
      return;
    }

    const legais = chess.moves({ square: this.selecionada, verbose: true });
    const candidatos = legais.filter((l) => l.to === casa);
    if (candidatos.length === 0) {
      const origem = chess.get(this.selecionada);
      this.anunciar(
        `Lance ilegal: ${PECAS[origem.type].nome} de ${nomeCasa(this.selecionada)} para ${nomeCasa(casa)} não é permitido. Seleção mantida.`,
      );
      return;
    }
    const de = this.selecionada;
    this.selecionada = null;
    this.atualizar();
    const precisaPromocao = candidatos.some((l) => l.promotion);
    this.aoTentarLance(de, casa, precisaPromocao);
  }

  _descricaoCasa(casa, peca) {
    if (!peca) return nomeCasa(casa);
    return `${nomeCasa(casa)}: ${PECAS[peca.type].nome} ${adjetivoCor(peca.type, peca.color)}`;
  }

  // Define o destaque do último lance (origem/destino) e se é de variante.
  destacarLance(de, para, emVariante) {
    this.destaque = de && para ? { de, para, emVariante } : null;
    this.atualizar();
  }

  atualizar() {
    const chess = this.obterChess();
    for (const [casa, botao] of this.botoes) {
      const peca = chess.get(casa);
      const chavePeca = peca ? `${peca.color}${peca.type}` : '';
      if (botao.dataset.peca !== chavePeca) {
        botao.dataset.peca = chavePeca;
        botao.textContent = '';
        if (peca) {
          const imagem = document.createElement('img');
          imagem.src = `icons/pecas/${chavePeca}.svg`;
          imagem.alt = '';
          imagem.draggable = false;
          imagem.setAttribute('aria-hidden', 'true');
          botao.appendChild(imagem);
        }
      }
      let rotulo = this._descricaoCasa(casa, peca);
      if (casa === this.selecionada) rotulo = `selecionada, ${rotulo}`;
      const noDestaque = this.destaque && (casa === this.destaque.de || casa === this.destaque.para);
      if (noDestaque) {
        rotulo = `${rotulo}, último lance`;
      }
      botao.setAttribute('aria-label', rotulo);
      botao.classList.toggle('selecionada', casa === this.selecionada);
      botao.classList.toggle('destaque-lance', Boolean(noDestaque) && !this.destaque.emVariante);
      botao.classList.toggle('destaque-variante', Boolean(noDestaque) && this.destaque.emVariante);
    }
  }

  focarTabuleiro() {
    const atual = [...this.botoes.values()].find((b) => b.tabIndex === 0) || this.botoes.get('e2');
    atual.focus();
  }
}
