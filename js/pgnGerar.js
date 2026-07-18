// Geração de PGN a partir da árvore de lances (com variantes e comentários),
// extração de uma única linha, e utilidades de download/compartilhamento.

import { NAG_PARA_SUFIXO } from './fala.js';

// Ordem canônica do Seven Tag Roster; tags extras vão depois.
const SETE_TAGS = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];

function escaparValor(valor) {
  return String(valor).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function montarCabecalho(tags, { setupFen } = {}) {
  const usadas = new Set();
  const linhas = [];
  for (const chave of SETE_TAGS) {
    const valor = tags[chave] && String(tags[chave]).trim() ? tags[chave] : '?';
    linhas.push(`[${chave} "${escaparValor(valor)}"]`);
    usadas.add(chave);
  }
  if (setupFen) {
    linhas.push('[SetUp "1"]');
    linhas.push(`[FEN "${escaparValor(setupFen)}"]`);
    usadas.add('SetUp');
    usadas.add('FEN');
  }
  // Tags extras preservadas (evento paralelo, ELOs, árbitro, etc.).
  for (const [chave, valor] of Object.entries(tags)) {
    if (usadas.has(chave)) continue;
    if (chave === 'SetUp' || chave === 'FEN') continue;
    const limpo = valor && String(valor).trim();
    if (!limpo) continue;
    linhas.push(`[${chave} "${escaparValor(valor)}"]`);
  }
  return linhas.join('\n');
}

function sanComGlifos(no) {
  let s = no.san;
  // Primeiro NAG comum vira sufixo textual (!, ?); os demais saem como $n.
  const extras = [];
  let sufixo = '';
  for (const n of no.nags || []) {
    if (!sufixo && NAG_PARA_SUFIXO[n]) sufixo = NAG_PARA_SUFIXO[n];
    else extras.push(`$${n}`);
  }
  return { texto: s + sufixo, nags: extras };
}

function escreverMove(no, tokens, precisaNumero) {
  if (no.cor === 'w') tokens.push(`${no.numero}.`);
  else if (precisaNumero) tokens.push(`${no.numero}...`);
  if (no.commentBefore) tokens.push(`{${no.commentBefore}}`);
  const { texto, nags } = sanComGlifos(no);
  tokens.push(texto);
  for (const n of nags) tokens.push(n);
  let proximoPrecisaNumero = false;
  if (no.comment) {
    tokens.push(`{${no.comment}}`);
    proximoPrecisaNumero = true;
  }
  return proximoPrecisaNumero;
}

// Escreve a continuação a partir de `pai`: linha principal (children[0]) com
// as variantes (children[1..]) entre parênteses, recursivamente.
function escreverContinuacao(pai, tokens, precisaNumero) {
  if (pai.children.length === 0) return;
  const principal = pai.children[0];
  let prox = escreverMove(principal, tokens, precisaNumero);
  if (pai.children.length > 1) {
    for (let i = 1; i < pai.children.length; i++) {
      tokens.push('(');
      const inicio = pai.children[i];
      const proxVar = escreverMove(inicio, tokens, true);
      escreverContinuacao(inicio, tokens, proxVar);
      tokens.push(')');
    }
    prox = true; // depois de variantes, o lance seguinte precisa de número
  }
  escreverContinuacao(principal, tokens, prox);
}

// Funde os parênteses de variante aos tokens vizinhos: "(" cola no lance
// seguinte e ")" cola no anterior, para sair "(2. f4 ... g5))" e não
// "( 2. f4 ... g5 ) )".
function fundirParenteses(tokens) {
  const out = [];
  let colar = false;
  for (const t of tokens) {
    if (t === '(') { out.push('('); colar = true; continue; }
    if (t === ')') {
      if (out.length) out[out.length - 1] += ')';
      else out.push(')');
      continue;
    }
    if (colar && out.length) { out[out.length - 1] += t; colar = false; } else out.push(t);
  }
  return out;
}

// Quebra tokens em linhas de ~80 colunas, como manda a convenção PGN.
function quebrarLinhas(tokensBrutos) {
  const tokens = fundirParenteses(tokensBrutos);
  const linhas = [];
  let linha = '';
  for (const token of tokens) {
    if (linha && linha.length + token.length + 1 > 79) {
      linhas.push(linha);
      linha = token;
    } else {
      linha = linha ? `${linha} ${token}` : token;
    }
  }
  if (linha) linhas.push(linha);
  return linhas.join('\n');
}

// PGN completo da partida (árvore inteira, com variantes e comentários).
export function gerarPgnCompleto(partida) {
  const cabecalho = montarCabecalho(partida.tags, {
    setupFen: partida.ehSetup ? partida.fenInicial : null,
  });
  const tokens = [];
  if (partida.raiz.comment) tokens.push(`{${partida.raiz.comment}}`);
  escreverContinuacao(partida.raiz, tokens, true);
  tokens.push(partida.resultado || '*');
  return `${cabecalho}\n\n${quebrarLinhas(tokens)}\n`;
}

// PGN de UMA linha: do início até o fim da linha atual (seguindo children[0]),
// sem as outras variantes, com nota de origem. `caminho` = array de nós.
export function gerarPgnLinha(partida, caminho, notaOrigem) {
  const cabecalho = montarCabecalho(partida.tags, {
    setupFen: partida.ehSetup ? partida.fenInicial : null,
  });
  // Sequência linear: os nós do caminho (menos a raiz) + a cauda por children[0].
  const nos = caminho.slice(1);
  let cauda = caminho[caminho.length - 1];
  while (cauda.children[0]) {
    cauda = cauda.children[0];
    nos.push(cauda);
  }
  const tokens = [];
  if (notaOrigem) tokens.push(`{${notaOrigem}}`);
  let precisaNumero = true;
  for (const no of nos) {
    // Reaproveita escreverMove, mas sem variantes.
    precisaNumero = escreverMoveLinha(no, tokens, precisaNumero);
  }
  tokens.push(partida.resultado || '*');
  return `${cabecalho}\n\n${quebrarLinhas(tokens)}\n`;
}

function escreverMoveLinha(no, tokens, precisaNumero) {
  if (no.cor === 'w') tokens.push(`${no.numero}.`);
  else if (precisaNumero) tokens.push(`${no.numero}...`);
  const { texto, nags } = sanComGlifos(no);
  tokens.push(texto);
  for (const n of nags) tokens.push(n);
  if (no.comment) {
    tokens.push(`{${no.comment}}`);
    return true;
  }
  return false;
}

// ---------------- Download e compartilhamento ----------------

export function nomeArquivoPgn(rotulo) {
  const base = (rotulo || 'partida')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'partida';
  return `${base}.pgn`;
}

export function baixarPgn(textoPgn, nomeArquivo) {
  const blob = new Blob([textoPgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Devolve o arquivo que o navegador aceita compartilhar, ou null se nenhum.
// Nos navegadores com motor Chromium (Chrome, Edge, Samsung Internet) o share()
// só aceita extensões de uma lista fixa que não inclui .pgn — e o canShare()
// mente, aceitando o .pgn que o share() depois rejeita. Como o share() consome
// o gesto do usuário, não dá para tentar .pgn e cair para .txt na falha; então
// no Chromium vai .txt direto, com ".pgn" no meio do nome para o destinatário
// saber o que é. Safari (iPhone/Mac) aceita .pgn de verdade e o recebe intacto.
export function arquivoParaCompartilhar(textoPgn, nomeArquivo) {
  if (!navigator.share || !navigator.canShare) return null;
  const ehChromium = /Chrom(e|ium)\//.test(navigator.userAgent);
  const arquivo = ehChromium
    ? new File([textoPgn], `${nomeArquivo}.txt`, { type: 'text/plain' })
    : new File([textoPgn], nomeArquivo, { type: 'application/x-chess-pgn' });
  return navigator.canShare({ files: [arquivo] }) ? arquivo : null;
}

export async function compartilharPgn(arquivo, titulo) {
  await navigator.share({ files: [arquivo], title: titulo });
}
