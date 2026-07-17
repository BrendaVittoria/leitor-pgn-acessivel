// Parser tolerante de lances: aceita variações de roque, captura de peão
// sem "x", promoção sem "=", desambiguação em minúscula e trata a
// ambiguidade real da letra "b" (peão da coluna bella × bispo).

import { descreverLance } from './fala.js';

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

  // 4. Nada legal encontrado: pode ser promoção sem a peça (ex.: "e8" sozinho)
  const promocoes = new Map();
  for (const candidato of candidatos) {
    const lance = porSan.get(`${candidato}=Q`);
    if (lance && lance.promotion) promocoes.set(candidato, lance);
  }
  if (promocoes.size >= 1) {
    const [baseSan, lanceBase] = [...promocoes.entries()][0];
    return { tipo: 'promocao', baseSan, lanceBase };
  }

  // 5. Lance de peça sem desambiguação suficiente (ex.: Nf3 com dois cavalos
  // que alcançam f3): oferecer as opções em vez de só dizer "ilegal".
  for (const variante of variantesDeCaixa(texto)) {
    const m = variante.match(/^([NBRQK])x?([a-h][1-8])$/);
    if (!m) continue;
    const possiveis = legais.filter(
      (lance) => lance.piece === m[1].toLowerCase() && lance.to === m[2],
    );
    if (possiveis.length >= 2) {
      return {
        tipo: 'ambiguo',
        opcoes: possiveis.map((lance) => ({
          san: lance.san,
          descricao: descreverLance(lance, true),
        })),
      };
    }
  }

  // 6. Inválido — mensagem específica
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
