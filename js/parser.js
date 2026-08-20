// Parser tolerante de lances: aceita variações de roque, captura de peão
// sem "x", promoção sem "=", desambiguação em minúscula e trata a
// ambiguidade real da letra "b" (peão da coluna bella × bispo).

import {
  artigoIndefinido, descreverLance, nomeCasa, nomePeca,
} from './fala.js';

function sanLimpo(san) {
  return san.replace(/[+#?!]+$/, '');
}

// Normaliza roque: remove hífens; se sobrarem só o/O/0, é roque.
function normalizarRoque(texto) {
  const semHifens = texto.replace(/-/g, '');
  if (/^[oO0]{2}$/.test(semHifens)) return 'O-O';
  if (/^[oO0]{3}$/.test(semHifens)) return 'O-O-O';
  return null;
}

// Insere o "x" na forma curta de captura de peão: ed5 -> exd5, ed8q -> exd8q.
function inserirXPeao(texto) {
  const m = texto.match(/^([a-h])([a-h])([1-8])(=?[qrbn])?$/);
  if (m && m[1] !== m[2]) {
    return `${m[1]}x${m[2]}${m[3]}${m[4] || ''}`;
  }
  return null;
}

// Insere o "x" em lance de peça sobre casa ocupada: Bc3 -> Bxc3, Ndf3 -> Ndxf3.
function inserirXPeca(texto) {
  const m = texto.match(/^([NBRQK])([a-h1-8]?)([a-h][1-8])$/);
  if (m) return `${m[1]}${m[2]}x${m[3]}`;
  return null;
}

// Converte promoção curta para SAN: e8q -> e8=Q, exd8q -> exd8=Q.
function normalizarPromocao(texto) {
  const m = texto.match(/^([a-h]x?[a-h][18]|[a-h][18])=?([qrbn])$/);
  if (m) return `${m[1]}=${m[2].toUpperCase()}`;
  return null;
}

// Casa a entrada com os lances legais por partes (peça, desambiguação de
// origem, destino) em vez de comparar o texto do SAN. Isso aceita a origem
// completa (`Ne1f3`, `Rf8c8`), a desambiguação por coluna ou linha quando há
// mesmo ambiguidade (`Ndf3` com dois cavalos indo a felix 3) e a forma longa
// só com as casas (`e2e4`, `b1c3`, `e7e8q`), com ou sem `x`/`-` no meio e em
// qualquer caixa.
function casarPorPartes(texto, legais) {
  const alvo = texto.toLowerCase();
  const lances = new Map(); // san -> lance
  const promocoes = new Map(); // san base (sem "=peça") -> lance
  let desnecessaria = null; // desambiguação parcial numa posição sem ambiguidade

  const registrar = (lance, letraPromocao) => {
    if (!lance.promotion) {
      // peça indicada no fim só faz sentido em promoção
      if (!letraPromocao) lances.set(lance.san, lance);
      return;
    }
    // Promoção: sem a peça escolhida, vira pergunta em vez de lance.
    if (!letraPromocao) {
      promocoes.set(sanLimpo(lance.san).replace(/=[QRBN]$/, ''), lance);
      return;
    }
    if (lance.promotion === letraPromocao) lances.set(lance.san, lance);
  };

  // Peça: letra, coluna e/ou linha de origem (opcionais), destino.
  const peca = alvo.match(/^([nbrqk])([a-h]?)([1-8]?)[x-]?([a-h][1-8])$/);
  if (peca) {
    const [, letra, coluna, linha, destino] = peca;
    const aoDestino = legais.filter((l) => l.piece === letra && l.to === destino);
    // Coluna ou linha sozinha é desambiguação, e desambiguação só existe onde
    // há duas peças disputando o destino. Com uma só, `Ndf3` não é lance: é
    // `Nf3` com uma letra a mais, e engolir isso esconde o engano de quem
    // digita. A casa de origem inteira (`Nd2f3`) não desambigua nada — é a
    // forma longa do lance, e vale sempre.
    const parcial = Boolean(coluna) !== Boolean(linha);
    if (!parcial || aoDestino.length > 1) {
      for (const lance of aoDestino) {
        if (coluna && lance.from[0] !== coluna) continue;
        if (linha && lance.from[1] !== linha) continue;
        registrar(lance, null);
      }
    } else if (aoDestino.length === 1
      && aoDestino[0].from[coluna ? 0 : 1] === (coluna || linha)) {
      // A letra até bate com a origem: é desambiguação sobrando, não engano de
      // peça. Guardada para a mensagem dizer o que sobra.
      desnecessaria = { lance: aoDestino[0], porColuna: Boolean(coluna) };
    }
  }

  // Forma longa sem a letra da peça: casa de origem, casa de destino e
  // promoção opcional (e2e4, b1c3, e1g1 para o roque, e7e8q).
  const longa = alvo.match(/^([a-h][1-8])[x-]?([a-h][1-8])=?([qrbn])?$/);
  if (longa) {
    const [, origem, destino, letraPromocao] = longa;
    for (const lance of legais) {
      if (lance.from !== origem || lance.to !== destino) continue;
      registrar(lance, letraPromocao || null);
    }
  }

  return { lances, promocoes, desnecessaria };
}

// Gera as variantes de caixa (maiúscula/minúscula) de uma entrada.
function variantesDeCaixa(texto) {
  const variantes = new Set();
  const minusculo = texto.toLowerCase();
  const primeira = minusculo[0];
  // interpretação "peão": tudo minúsculo (casas e colunas são minúsculas em SAN)
  if (/[a-h]/.test(primeira)) variantes.add(minusculo);
  // interpretação "peça": primeira letra maiúscula, resto minúsculo
  if (/[nbrqk]/.test(primeira)) {
    variantes.add(primeira.toUpperCase() + minusculo.slice(1));
  }
  return variantes;
}

// Expande uma variante com as transformações tolerantes (x omitido, promoção).
function expandirVariante(variante) {
  const formas = new Set([variante]);
  const comXPeao = inserirXPeao(variante);
  if (comXPeao) formas.add(comXPeao);
  const comXPeca = inserirXPeca(variante);
  if (comXPeca) formas.add(comXPeca);
  for (const forma of [...formas]) {
    const comPromocao = normalizarPromocao(forma);
    if (comPromocao) formas.add(comPromocao);
  }
  return formas;
}

/**
 * Interpreta a entrada digitada contra a posição atual.
 * @param {string} entrada texto digitado (sem comandos — já filtrados antes)
 * @param {import('../vendor/chess.js').Chess} chess posição atual
 * @returns {{tipo:'lance', san:string, lance:object, inferido:boolean}
 *   | {tipo:'ambiguo', opcoes:Array<{san:string, descricao:string}>}
 *   | {tipo:'promocao', baseSan:string, lanceBase:object}
 *   | {tipo:'invalido', mensagem:string}}
 */
export function interpretarEntrada(entrada, chess) {
  const texto = entrada.trim().replace(/[+#?!]+$/, '');
  if (!texto) return { tipo: 'invalido', mensagem: 'Entrada vazia.' };

  const legais = chess.moves({ verbose: true });
  const porSan = new Map();
  for (const lance of legais) porSan.set(sanLimpo(lance.san), lance);

  // 1. Roque (qualquer variação vira SAN padrão antes de validar)
  const roque = normalizarRoque(texto);
  if (roque) {
    const lance = porSan.get(roque);
    if (lance) return { tipo: 'lance', san: lance.san, lance, inferido: false };
    return {
      tipo: 'invalido',
      mensagem: `${roque === 'O-O' ? 'Roque pequeno' : 'Roque grande'} não é legal nesta posição.`,
    };
  }

  // 2. Entrada exatamente como digitada (SAN padrão)
  const exato = porSan.get(texto);
  if (exato) return { tipo: 'lance', san: exato.san, lance: exato, inferido: false };

  // 3. Interpretações alternativas (caixa, x de peão, promoção sem =)
  const candidatos = new Set();
  for (const variante of variantesDeCaixa(texto)) {
    for (const forma of expandirVariante(variante)) candidatos.add(forma);
  }

  const encontrados = new Map(); // san -> lance
  for (const candidato of candidatos) {
    const lance = porSan.get(candidato);
    if (lance) encontrados.set(lance.san, lance);
  }

  // 4. Casamento por partes: desambiguação onde há ambiguidade (Ndf3, N1f3),
  // origem completa (Ne1f3, Rf8c8) e forma longa de peão (e2e4, e7e8q).
  const porPartes = casarPorPartes(texto, legais);
  for (const lance of porPartes.lances.values()) encontrados.set(lance.san, lance);

  if (encontrados.size === 1) {
    const lance = [...encontrados.values()][0];
    return { tipo: 'lance', san: lance.san, lance, inferido: true };
  }

  if (encontrados.size > 1) {
    return {
      tipo: 'ambiguo',
      opcoes: [...encontrados.values()].map((lance) => ({
        san: lance.san,
        descricao: descreverLance(lance, true),
      })),
    };
  }

  // 5. Nada legal encontrado: pode ser promoção sem a peça (ex.: "e8" sozinho,
  // ou "e7e8" na forma longa)
  const promocoes = new Map(porPartes.promocoes);
  for (const candidato of candidatos) {
    const lance = porSan.get(`${candidato}=Q`);
    if (lance && lance.promotion) promocoes.set(candidato, lance);
  }
  if (promocoes.size >= 1) {
    const [baseSan, lanceBase] = [...promocoes.entries()][0];
    return { tipo: 'promocao', baseSan, lanceBase };
  }

  // 6. Desambiguação onde não havia ambiguidade: o lance existe, mas não com
  // essa letra a mais. Dizer só "ilegal" mandaria procurar erro na posição.
  if (porPartes.desnecessaria) {
    const { lance, porColuna } = porPartes.desnecessaria;
    const peca = `${artigoIndefinido(lance.piece)} ${nomePeca(lance.piece)}`;
    return {
      tipo: 'invalido',
      mensagem: `${porColuna ? 'A coluna' : 'A linha'} de origem só entra quando há ambiguidade, e aqui só ${peca} chega a ${nomeCasa(lance.to)}. Digite o lance sem ela, ou com a casa de origem inteira.`,
    };
  }

  // 7. Inválido — mensagem específica
  const pareceLance = /^[a-hnbrqkoO0](?:[a-h1-8xX=oO0-]|[nbrqk])*$/i.test(texto);
  return {
    tipo: 'invalido',
    mensagem: pareceLance
      ? `Lance ilegal nesta posição: ${entrada.trim()}.`
      : `Entrada não reconhecida: ${entrada.trim()}. Digite ponto de interrogação para ouvir os comandos.`,
  };
}

// Resolve uma promoção pendente com a peça escolhida (q, r, b ou n).
export function resolverPromocao(baseSan, letraPeca, chess) {
  const alvo = `${baseSan}=${letraPeca.toUpperCase()}`;
  const legais = chess.moves({ verbose: true });
  for (const lance of legais) {
    if (sanLimpo(lance.san) === alvo) return lance;
  }
  return null;
}
