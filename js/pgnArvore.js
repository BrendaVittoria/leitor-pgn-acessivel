// Parser de PGN próprio do app: separa múltiplas partidas de um arquivo e
// monta a ÁRVORE de lances de cada uma (com variantes aninhadas, comentários
// e NAGs). O chess.js entra só como motor de validação/reprodução — o loadPgn
// dele lida com uma partida por vez e não preserva a árvore de variantes.
//
// Modelo de nó (um por meio-lance):
//   {
//     san, move (verboso do chess.js), fen (posição após o lance),
//     numero (lance cheio antes do lance), cor ('w'|'b'),
//     comment, commentBefore, nags: number[],
//     children: Nó[]   // children[0] = continuação; children[1..] = variantes
//     parent: Nó
//   }
// A raiz é um nó sentinela (posição inicial), san=null, move=null.

import { Chess, DEFAULT_POSITION } from '../vendor/chess.js';
import { SUFIXO_PARA_NAG } from './fala.js';

// ---------------- Separação de partidas ----------------

function limparTexto(texto) {
  return texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

// Uma partida = um bloco contíguo de tags [Chave "valor"] seguido do corpo
// (movetext) até o próximo bloco de tags (ou o fim do arquivo). Dividir nos
// blocos de tags é robusto a ausência de marcador de resultado e a espaços.
const BLOCO_TAGS_RE = /(?:\[\s*[A-Za-z0-9_]+\s+"(?:[^"\\]|\\.)*"\s*\]\s*)+/g;
const UMA_TAG_RE = /\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/g;

export function separarPartidas(textoBruto) {
  const texto = limparTexto(textoBruto);
  const blocos = [...texto.matchAll(BLOCO_TAGS_RE)];
  if (blocos.length === 0) {
    // Sem tags: pode ser só movetext colado. Tratar como uma partida sem tags.
    return texto.trim() ? [{ tagsText: '', bodyText: texto }] : [];
  }
  const partidas = [];
  for (let i = 0; i < blocos.length; i++) {
    const inicio = blocos[i].index;
    const tagsText = blocos[i][0];
    const corpoInicio = inicio + tagsText.length;
    const corpoFim = i + 1 < blocos.length ? blocos[i + 1].index : texto.length;
    partidas.push({ tagsText, bodyText: texto.slice(corpoInicio, corpoFim) });
  }
  return partidas;
}

function parseTags(tagsText) {
  const tags = {};
  let m;
  UMA_TAG_RE.lastIndex = 0;
  while ((m = UMA_TAG_RE.exec(tagsText)) !== null) {
    tags[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return tags;
}

// ---------------- Tokenização do movetext ----------------

// Ordem importa: comentário e resultado antes de número/lance (1/2-1/2 começa
// com dígito). O grupo de lance é frouxo de propósito — o chess.js valida.
const TOKEN_RE = new RegExp([
  '(\\{[^}]*\\})',                                   // 1 comentário
  '(\\()',                                           // 2 abre variante
  '(\\))',                                           // 3 fecha variante
  '(\\$\\d+)',                                        // 4 NAG
  '(1-0|0-1|1\\/2-1\\/2|\\*)',                       // 5 resultado
  '(\\d+\\.(?:\\.\\.)?|\\.\\.\\.)',                  // 6 número de lance / reticências
  '(O-O-O|O-O|0-0-0|0-0|[a-hKQRBN][a-h1-8xX=+#!?KQRBN]*)', // 7 lance (frouxo)
].join('|'), 'g');

function tokenizar(body) {
  const tokens = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body)) !== null) {
    if (m[1] !== undefined) tokens.push({ t: 'comentario', v: m[1].slice(1, -1).trim() });
    else if (m[2] !== undefined) tokens.push({ t: 'abre' });
    else if (m[3] !== undefined) tokens.push({ t: 'fecha' });
    else if (m[4] !== undefined) tokens.push({ t: 'nag', v: Number(m[4].slice(1)) });
    else if (m[5] !== undefined) tokens.push({ t: 'resultado', v: m[5] });
    else if (m[6] !== undefined) { /* número de lance: descartável */ }
    else if (m[7] !== undefined) tokens.push({ t: 'lance', v: m[7] });
  }
  return tokens;
}

// Separa o SAN dos glifos de anotação (!, ?) transformando-os em NAGs.
function extrairGlifos(bruto) {
  let san = bruto;
  const nags = [];
  const mm = bruto.match(/([!?]{1,2})$/);
  if (mm) {
    san = bruto.slice(0, -mm[1].length);
    const nag = SUFIXO_PARA_NAG[mm[1]];
    if (nag) nags.push(nag);
  }
  return { san, nags };
}

// ---------------- Construção da árvore ----------------

function novoNo(parent) {
  return {
    san: null, move: null, fen: null, numero: null, cor: null,
    comment: null, commentBefore: null, nags: [],
    children: [], parent,
  };
}

function construirArvore(tokens) {
  const raiz = novoNo(null);
  let parent = raiz;   // ponto onde o próximo lance da linha atual é anexado
  let ultimo = null;   // último nó de lance adicionado nesta linha
  let comentarioPendente = null; // comentário antes do próximo lance
  const pilha = [];    // frames de variante: {parent, ultimo}
  let resultado = null;

  for (const tok of tokens) {
    switch (tok.t) {
      case 'comentario':
        if (ultimo) {
          ultimo.comment = ultimo.comment ? `${ultimo.comment} ${tok.v}` : tok.v;
        } else if (parent === raiz && pilha.length === 0) {
          raiz.comment = raiz.comment ? `${raiz.comment} ${tok.v}` : tok.v;
        } else {
          comentarioPendente = comentarioPendente ? `${comentarioPendente} ${tok.v}` : tok.v;
        }
        break;
      case 'nag':
        if (ultimo) ultimo.nags.push(tok.v);
        break;
      case 'lance': {
        const { san, nags } = extrairGlifos(tok.v);
        const no = novoNo(parent);
        no.san = san;
        no.nags = nags;
        no.commentBefore = comentarioPendente;
        comentarioPendente = null;
        parent.children.push(no);
        ultimo = no;
        parent = no;
        break;
      }
      case 'abre':
        // A variante é alternativa ao ÚLTIMO lance: seus lances são irmãos
        // dele (filhos do mesmo pai). Guardamos o estado para retomar depois.
        if (!ultimo) break; // '(' sem lance anterior: ignora
        pilha.push({ parent, ultimo });
        parent = ultimo.parent;
        ultimo = null;
        comentarioPendente = null;
        break;
      case 'fecha': {
        const frame = pilha.pop();
        if (frame) {
          parent = frame.parent;
          ultimo = frame.ultimo;
        }
        comentarioPendente = null;
        break;
      }
      case 'resultado':
        // Só o resultado do nível principal (fora de variante) conta.
        if (pilha.length === 0) resultado = tok.v;
        break;
      default:
        break;
    }
  }
  return { raiz, resultado };
}

// ---------------- Validação/reprodução (chess.js) ----------------

// DFS que reproduz cada lance na posição correta, preenchendo move/fen/numero/
// cor e podando lances ilegais (trunca a linha). Retorna dados de truncamento.
function validarArvore(raiz, fenInicial) {
  raiz.fen = fenInicial;
  let houveErro = false;
  let ultimoLanceValido = 0;

  function dfs(no, ply) {
    // Itera sobre uma cópia: podar altera no.children.
    const filhos = [...no.children];
    no.children.length = 0;
    for (const filho of filhos) {
      let chess;
      try {
        chess = new Chess(no.fen);
      } catch {
        houveErro = true;
        continue;
      }
      let mv = null;
      try {
        mv = chess.move(filho.san);
      } catch {
        mv = null;
      }
      if (!mv) {
        // Lance ilegal: poda este ramo (trunca a linha aqui).
        houveErro = true;
        continue;
      }
      filho.move = mv;
      filho.san = mv.san;
      filho.fen = chess.fen();
      filho.cor = mv.color;
      // Número do lance cheio = fullmove da posição ANTES do lance.
      filho.numero = Number(no.fen.split(' ')[5]) || Math.floor(ply / 2) + 1;
      no.children.push(filho);
      const plyFilho = ply + 1;
      if (plyFilho > ultimoLanceValido) ultimoLanceValido = plyFilho;
      dfs(filho, plyFilho);
    }
  }
  dfs(raiz, 0);
  return { houveErro, ultimoLanceValido };
}

// ---------------- API pública ----------------

// Interpreta as tags de configuração inicial ([SetUp]/[FEN]).
function fenDeTags(tags) {
  const setup = tags.SetUp === '1' || tags.Setup === '1';
  if (setup && tags.FEN) return tags.FEN.trim();
  // Alguns arquivos trazem FEN sem SetUp; aceitamos se parece válido.
  if (tags.FEN && /\/.*\/.* [wb] /.test(tags.FEN)) return tags.FEN.trim();
  return null;
}

// Monta uma partida a partir do bloco separado. Retorna objeto de partida
// pronto para a engine de leitura, ou null se nem sequer as tags existem e o
// corpo é vazio.
export function montarPartida({ tagsText, bodyText }) {
  const tags = parseTags(tagsText);
  const fenTag = fenDeTags(tags);
  let fenInicial = fenTag || DEFAULT_POSITION;
  // FEN inválido nas tags: cai para a posição padrão, sem quebrar.
  try {
    new Chess(fenInicial);
  } catch {
    fenInicial = DEFAULT_POSITION;
  }

  const tokens = tokenizar(bodyText);
  const { raiz, resultado } = construirArvore(tokens);
  const { houveErro, ultimoLanceValido } = validarArvore(raiz, fenInicial);

  const resultadoFinal = (tags.Result && tags.Result !== '?')
    ? tags.Result
    : (resultado || '*');

  const temLances = raiz.children.length > 0;
  return {
    tags,
    fenInicial,
    ehSetup: Boolean(fenTag),
    raiz,
    resultado: resultadoFinal,
    truncada: houveErro,
    ultimoLanceValido,
    temLances,
  };
}

// Separa e monta todas as partidas de um texto PGN. Retorna
// { partidas: [...], ignoradas: N } — partidas sem nenhum lance mas com tags
// contam como válidas (ex.: só cabeçalho); blocos totalmente vazios são
// ignorados.
export function lerPgn(texto) {
  const blocos = separarPartidas(texto);
  const partidas = [];
  let ignoradas = 0;
  for (const bloco of blocos) {
    try {
      const partida = montarPartida(bloco);
      const temTags = Object.keys(partida.tags).length > 0;
      if (!partida.temLances && !temTags) {
        ignoradas++;
        continue;
      }
      partidas.push(partida);
    } catch {
      ignoradas++;
    }
  }
  return { partidas, ignoradas };
}

// Revalida a subárvore abaixo de `no` (após uma correção de lance):
// reproduz cada lance a partir da nova posição e poda os que ficaram
// ilegais, junto com tudo que dependia deles. Retorna quantos lances
// foram removidos.
export function revalidarSubarvore(no) {
  let removidos = 0;
  const contar = (n) => n.children.reduce((soma, c) => soma + 1 + contar(c), 0);
  (function dfs(n) {
    const filhos = [...n.children];
    n.children.length = 0;
    for (const filho of filhos) {
      let chess = null;
      let mv = null;
      try {
        chess = new Chess(n.fen);
        mv = chess.move(filho.san);
      } catch {
        mv = null;
      }
      if (!mv) {
        removidos += 1 + contar(filho);
        continue;
      }
      filho.move = mv;
      filho.san = mv.san;
      filho.fen = chess.fen();
      filho.cor = mv.color;
      filho.numero = Number(n.fen.split(' ')[5]) || filho.numero;
      n.children.push(filho);
      dfs(filho);
    }
  })(no);
  return removidos;
}

// Conta quantos lances da subárvore de `no` ficariam ilegais se a posição
// após `no` passasse a ser `fenNovo` — simulação pura, nada é alterado.
// Usado para pedir confirmação antes de uma correção que poda lances.
export function contarPodaSimulada(no, fenNovo) {
  let removidos = 0;
  const contar = (n) => n.children.reduce((soma, c) => soma + 1 + contar(c), 0);
  (function dfs(n, fen) {
    for (const filho of n.children) {
      let chess = null;
      let mv = null;
      try {
        chess = new Chess(fen);
        mv = chess.move(filho.san);
      } catch {
        mv = null;
      }
      if (!mv) {
        removidos += 1 + contar(filho);
        continue;
      }
      dfs(filho, chess.fen());
    }
  })(no, fenNovo);
  return removidos;
}

// ---------------- Utilidades de árvore ----------------

// Nível de aninhamento de um nó: quantas vezes, subindo até a raiz, o nó é
// filho de índice > 0 (entrada de variante). 0 = linha principal.
export function nivel(no) {
  let d = 0;
  let n = no;
  while (n.parent) {
    if (n.parent.children.indexOf(n) > 0) d++;
    n = n.parent;
  }
  return d;
}

// Um nó é "entrada de variante" quando é filho de índice > 0 do seu pai.
export function ehEntradaVariante(no) {
  return Boolean(no.parent) && no.parent.children.indexOf(no) > 0;
}

// Reconstrói o caminho (array de nós da raiz ao alvo) a partir de índices de
// escolha de filho. Usado para retomar a última leitura.
export function caminhoPorIndices(raiz, indices) {
  const caminho = [raiz];
  let atual = raiz;
  for (const i of indices) {
    if (!atual.children[i]) break;
    atual = atual.children[i];
    caminho.push(atual);
  }
  return caminho;
}

// Índices de escolha de filho ao longo de um caminho (inverso do anterior).
export function indicesDoCaminho(caminho) {
  const indices = [];
  for (let i = 1; i < caminho.length; i++) {
    indices.push(caminho[i - 1].children.indexOf(caminho[i]));
  }
  return indices;
}
