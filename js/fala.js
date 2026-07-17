// Conversão de lances, casas, resultados e posições para português falado,
// usando a convenção fonética de casas (anna/bella/cesar/...).
// Base copiada do relógio; estendida com resultado, NAGs e descrição de
// posição para o leitor de PGN.

export const NOMES_COLUNAS = {
  a: 'anna', b: 'bella', c: 'cesar', d: 'david',
  e: 'eva', f: 'felix', g: 'gustav', h: 'hector',
};

// nome, artigo definido e gênero de cada peça (chess.js usa letras minúsculas)
export const PECAS = {
  p: { nome: 'peão', artigo: 'o' },
  n: { nome: 'cavalo', artigo: 'o' },
  b: { nome: 'bispo', artigo: 'o' },
  r: { nome: 'torre', artigo: 'a' },
  q: { nome: 'dama', artigo: 'a' },
  k: { nome: 'rei', artigo: 'o' },
};

export const VALOR_PECAS = { p: 1, n: 3, b: 3, r: 5, q: 9 };

// "eva 1": coluna fonética + número em dígito — o leitor de tela fala o
// dígito naturalmente, e o texto fica curto.
export function nomeCasa(casa) {
  return `${NOMES_COLUNAS[casa[0]]} ${casa[1]}`;
}

export function nomePeca(letra) {
  return PECAS[letra.toLowerCase()].nome;
}

export function nomeCor(cor) {
  return cor === 'w' ? 'brancas' : 'pretas';
}

export function adjetivoCor(letraPeca, cor) {
  const feminino = PECAS[letraPeca.toLowerCase()].artigo === 'a';
  if (cor === 'w') return feminino ? 'branca' : 'branco';
  return feminino ? 'preta' : 'preto';
}

// Descreve um lance verboso do chess.js em português por extenso.
// Com `comOrigem`, inclui de onde a peça vem — usado nas perguntas de
// desambiguação (ex.: "peão de bella toma em cesar 3").
export function descreverLance(lance, comOrigem = false) {
  if (lance.san.startsWith('O-O-O')) return 'roque grande';
  if (lance.san.startsWith('O-O')) return 'roque pequeno';

  let peca = nomePeca(lance.piece);
  if (comOrigem) {
    peca += lance.piece === 'p'
      ? ` de ${NOMES_COLUNAS[lance.from[0]]}`
      : ` de ${nomeCasa(lance.from)}`;
  }
  const destino = nomeCasa(lance.to);
  let texto;
  if (lance.captured) {
    const capturada = nomePeca(lance.captured);
    texto = `${peca} toma ${capturada} em ${destino}`;
    if (lance.flags.includes('e')) texto += ', en passant';
  } else {
    texto = comOrigem ? `${peca} para ${destino}` : `${peca} ${destino}`;
  }
  if (lance.promotion) {
    texto += `, promove a ${nomePeca(lance.promotion)}`;
  }
  return texto;
}

// Forma falada do dia a dia: lance simples de peão dispensa o nome da peça
// ("eva 4" em vez de "peão eva 4") e peça vai direto ao destino, sem "para"
// ("cavalo felix 3"). Usada nos anúncios de lance aplicado e na lista.
export function descreverLanceFalado(lance) {
  if (lance.san.startsWith('O-O-O')) return 'roque grande';
  if (lance.san.startsWith('O-O')) return 'roque pequeno';

  const destino = nomeCasa(lance.to);
  let texto;
  if (lance.captured) {
    const quem = lance.piece === 'p' ? NOMES_COLUNAS[lance.from[0]] : nomePeca(lance.piece);
    texto = `${quem} toma ${destino}`;
    if (lance.flags.includes('e')) texto += ', en passant';
  } else if (lance.piece === 'p') {
    texto = destino;
  } else {
    texto = `${nomePeca(lance.piece)} ${destino}`;
  }
  if (lance.promotion) {
    texto += `, promove a ${nomePeca(lance.promotion)}`;
  }
  return texto;
}

// Sufixo de xeque/xeque-mate a partir do SAN (que carrega + ou #).
export function sufixoXeque(san) {
  if (!san) return '';
  if (san.endsWith('#')) return ', xeque-mate';
  if (san.endsWith('+')) return ', xeque';
  return '';
}

// Frase de xeque para os anúncios (mais enfática que o sufixo de lista).
export function fraseXeque(san) {
  if (!san) return '';
  if (san.endsWith('#')) return ' Xeque-mate!';
  if (san.endsWith('+')) return ' Xeque.';
  return '';
}

// ---------------- Resultado ----------------

export function resultadoFalado(resultado) {
  switch ((resultado || '').trim()) {
    case '1-0': return 'vitória das brancas';
    case '0-1': return 'vitória das pretas';
    case '1/2-1/2': return 'empate';
    case '*': return 'em andamento';
    default: return 'em andamento';
  }
}

// ---------------- NAGs (Numeric Annotation Glyphs) ----------------

// Os NAGs comuns falados por extenso; os raros são ignorados no MVP.
export const NAGS = {
  1: 'bom lance',
  2: 'erro',
  3: 'lance brilhante',
  4: 'erro grave',
  5: 'lance interessante',
  6: 'lance duvidoso',
  7: 'lance forçado',
  10: 'posição igual',
  13: 'posição incerta',
  14: 'brancas um pouco melhor',
  15: 'pretas um pouco melhor',
  16: 'brancas melhor',
  17: 'pretas melhor',
  18: 'brancas ganhando',
  19: 'pretas ganhando',
};

// Sufixos de anotação (!, ?, !!, ??, !?, ?!) mapeados para o número de NAG.
export const SUFIXO_PARA_NAG = {
  '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6,
};
export const NAG_PARA_SUFIXO = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };

export function nagsFalados(nags) {
  if (!nags || !nags.length) return '';
  const ditos = nags.map((n) => NAGS[n]).filter(Boolean);
  return ditos.length ? ditos.join(', ') : '';
}

// ---------------- Descrição de posição (por blocos) ----------------

const ORDEM_PECAS = ['k', 'q', 'r', 'b', 'n', 'p'];
const PLURAIS = {
  k: 'rei', q: 'dama', r: 'torres', b: 'bispos', n: 'cavalos', p: 'peões',
};
const SINGULARES = {
  k: 'rei', q: 'dama', r: 'torre', b: 'bispo', n: 'cavalo', p: 'peão',
};

// Junta "anna 1", "bella 2", "cesar 3" com vírgulas e "e" no fim.
function juntarCasas(casas) {
  if (casas.length === 1) return casas[0];
  const inicio = casas.slice(0, -1).join(', ');
  return `${inicio} e ${casas[casas.length - 1]}`;
}

// Constrói a lista de blocos de texto para o diálogo "Descrever posição".
// Cada bloco é uma frase curta que o leitor de tela percorre no ritmo da
// pessoa, em vez de um anúncio único e comprido.
export function descreverPosicaoBlocos(chess) {
  const board = chess.board(); // matriz 8x8, [0]=linha 8
  const porCor = { w: {}, b: {} };
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const casa = board[r][c];
      if (!casa) continue;
      const linha = 8 - r;
      const coluna = 'abcdefgh'[c];
      const nome = `${NOMES_COLUNAS[coluna]} ${linha}`;
      (porCor[casa.color][casa.type] ||= []).push({ nome, ord: c * 8 + linha });
    }
  }

  const blocos = [];
  for (const cor of ['w', 'b']) {
    const partes = [];
    for (const tipo of ORDEM_PECAS) {
      const lista = porCor[cor][tipo];
      if (!lista || !lista.length) continue;
      lista.sort((a, b) => a.ord - b.ord);
      const casas = lista.map((x) => x.nome);
      const rotulo = casas.length === 1 ? SINGULARES[tipo] : PLURAIS[tipo];
      partes.push(`${rotulo} ${juntarCasas(casas)}`);
    }
    const titulo = cor === 'w' ? 'Brancas' : 'Pretas';
    blocos.push(`${titulo}: ${partes.length ? partes.join('; ') : 'sem peças'}.`);
  }

  // Vez e direitos de roque.
  blocos.push(`Vez das ${nomeCor(chess.turn())}.`);
  const roques = [];
  const direitos = obterRoques(chess);
  if (direitos.w.length) roques.push(`Brancas podem rocar: ${direitos.w.join(' e ')}`);
  if (direitos.b.length) roques.push(`Pretas podem rocar: ${direitos.b.join(' e ')}`);
  if (roques.length) blocos.push(`${roques.join('. ')}.`);
  if (chess.isCheckmate()) blocos.push('Xeque-mate.');
  else if (chess.inCheck()) blocos.push(`${nomeCor(chess.turn())} em xeque.`);
  return blocos;
}

function obterRoques(chess) {
  const fen = chess.fen();
  const campo = fen.split(' ')[2] || '-';
  const w = [];
  const b = [];
  if (campo.includes('K')) w.push('pequeno');
  if (campo.includes('Q')) w.push('grande');
  if (campo.includes('k')) b.push('pequeno');
  if (campo.includes('q')) b.push('grande');
  return { w, b };
}
