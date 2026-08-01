// Persistência local (localStorage): preferências, PGNs guardados (com limite
// e remoção do mais antigo), última leitura para "Continuar". Tudo protegido
// por try/catch: se o armazenamento falhar, o app segue funcionando como
// leitor — só avisa que não conseguiu guardar.

const PREFIXO = 'leitor-pgn.';

function ler(chave, padrao = null) {
  try {
    const bruto = localStorage.getItem(PREFIXO + chave);
    return bruto === null ? padrao : JSON.parse(bruto);
  } catch {
    return padrao;
  }
}

function gravar(chave, valor) {
  return gravarOuFalhar(chave, valor) === 'ok';
}

// Distingue os dois jeitos de a gravação falhar, porque a resposta a cada um
// é diferente: falta de espaço se resolve apagando arquivo antigo;
// armazenamento indisponível (modo privado, cookies bloqueados) não se
// resolve apagando nada, e apagar ali seria destruir por nada.
// Devolve 'ok' | 'sem-espaco' | 'indisponivel'.
function gravarOuFalhar(chave, valor) {
  try {
    localStorage.setItem(PREFIXO + chave, JSON.stringify(valor));
    return 'ok';
  } catch (e) {
    const semEspaco = Boolean(e) && (
      e.name === 'QuotaExceededError'
      || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || e.code === 22 || e.code === 1014
    );
    return semEspaco ? 'sem-espaco' : 'indisponivel';
  }
}

function remover(chave) {
  try {
    localStorage.removeItem(PREFIXO + chave);
  } catch { /* ignorar */ }
}

// ---------------- Preferências ----------------

const PREFS_PADRAO = {
  som: true,
  tabuleiro: false, // padrão: oculto (público principal usa leitor de tela)
  digitacao: false, // caixa de digitação de lances: oculta por padrão
  perguntarBifurcacoes: true,
  tema: 'padrao',   // cores das casas do tabuleiro (temas.js)
  formatoDescricao: 'pecas', // 'pecas' (por tipo de peça) ou 'fen' (por fileira)
  // Manter no app os PGNs abertos. Ligado por padrão (é o que faz o
  // "Continuar última leitura" e o autossalvamento existirem), mas desligável:
  // nem todo arquivo que se abre é um arquivo que se quer deixar no app.
  guardarAutomatico: true,
};

export function lerPreferencias() {
  return { ...PREFS_PADRAO, ...(ler('prefs', {}) || {}) };
}

export function gravarPreferencias(prefs) {
  gravar('prefs', { ...lerPreferencias(), ...prefs });
}

// ---------------- Última leitura ----------------

export function gravarUltimaLeitura(estado) {
  gravar('ultima-leitura', estado);
}

export function lerUltimaLeitura() {
  return ler('ultima-leitura');
}

export function limparUltimaLeitura() {
  remover('ultima-leitura');
}

// ---------------- PGNs guardados ----------------

// QUANTO CABE NÃO É CHUTADO: quem responde é o próprio navegador.
//
// O teto do localStorage varia demais para ser adivinhado — a documentação se
// contradiz sobre o iPhone, e no Chrome de hoje ele segue a cota da origem
// (medimos 52 milhões de caracteres num desktop em 2026-08-01). Qualquer
// número fixo aqui erraria: apertado demais num aparelho folgado, folgado
// demais num apertado. Então não há número de capacidade: a gravação é
// tentada de verdade, e o navegador é quem diz se coube.
//
// E o que fazer quando NÃO cabe? Nada. O app não apaga PGN nenhum para
// abrir espaço, nem o mais antigo: o arquivo que não coube **abre e é lido
// normalmente**, só não fica guardado — não guardar não custa nada a quem
// está lendo, enquanto apagar custa um arquivo que a pessoa escolheu manter.
// Guardar é automático só enquanto for de graça; quando custaria apagar
// outra coisa, quem decide é a pessoa, apagando o que ela quiser na tela
// inicial. Apagar é sempre ato explícito dela.
//
// Os dois limites que sobraram não são de capacidade, são de política:
const LIMITE_ARQUIVOS = 20;             // lista navegável, não espaço
const LIMITE_POR_ARQUIVO = 500 * 1024;  // acima disso, guarda sem cópia editável
// Sanidade: acima disto nem vale tentar — seriam megabytes de JSON a cada
// gravação, e o aparelho vai recusar de qualquer jeito. Contado em
// caracteres, que no localStorage custam dois bytes cada (UTF-16).
const LIMITE_SO_LEITURA = 4 * 1024 * 1024;

export function lerGuardados() {
  return ler('guardados', []) || [];
}

export function tamanhoTotal(lista) {
  return lista.reduce((soma, g) => soma + (g.original || '').length + (g.atual || '').length, 0);
}

// Grava a lista. Recusa do navegador não dispara despejo de nada: o
// `setItem` que falha deixa a chave com o valor anterior, então a lista
// guardada continua exatamente como estava. Retorna { ok, motivo? }.
function gravarGuardados(lista) {
  const r = gravarOuFalhar('guardados', lista);
  return r === 'ok' ? { ok: true } : { ok: false, motivo: r };
}

// ---------------- Medição do espaço do aparelho ----------------

// Descobre por tentativa e erro quantos caracteres ainda cabem, ALÉM do que
// já está guardado. Escreve numa chave de sonda e a apaga no fim (inclusive
// se algo der errado no meio): nada do que está guardado é tocado.
// Primeiro dobra até não caber, depois afina por bisseção.
//
// A medição trava a tela enquanto roda, então ela não vai atrás do teto de
// verdade: para de procurar em 8 milhões de caracteres (~16 MB), muito acima
// de qualquer PGN e bem acima do teto apertado que se atribui ao iPhone. Onde
// o espaço passa disso, a resposta honesta é "aqui espaço não é problema" —
// e sai em menos de um segundo, em vez de nove.
const PASSO_FINAL = 64 * 1024; // precisão da resposta, em caracteres
const TETO_DA_SONDA = 8 * 1024 * 1024;

export function medirEspacoLivre(teto = TETO_DA_SONDA) {
  const CHAVE = PREFIXO + '__sonda';
  const cabe = (n) => {
    try {
      localStorage.setItem(CHAVE, 'a'.repeat(n));
      return true;
    } catch {
      return false;
    }
  };
  try {
    let ok = 0;
    let n = PASSO_FINAL;
    while (n <= teto && cabe(n)) { ok = n; n *= 2; }
    let falha = n <= teto ? n : teto + 1;
    while (falha - ok > PASSO_FINAL) {
      const meio = Math.floor((ok + falha) / 2);
      if (cabe(meio)) ok = meio; else falha = meio;
    }
    return { livre: ok, atingiuTeto: falha > teto };
  } finally {
    try { localStorage.removeItem(CHAVE); } catch { /* ignorar */ }
  }
}

// O que cabe guardar de um arquivo, pelo tamanho do texto importado:
// 'completo' guarda o original e a cópia editável (o dobro do espaço, e é o
// que permite autossalvar comentários, lances e cabeçalho); 'so-leitura'
// guarda uma cópia só, o que faz um arquivo grande caber — ele reabre e
// retoma a posição, mas não carrega alterações; 'nao' é grande demais até
// para isso e não é guardado.
function classificarPorTamanho(texto) {
  const n = (texto || '').length;
  if (n <= LIMITE_POR_ARQUIVO) return 'completo';
  if (n <= LIMITE_SO_LEITURA) return 'so-leitura';
  return 'nao';
}

// Guarda (ou renova) um PGN aberto. Retorna
// { guardado: bool, id, soLeitura, motivo? }. Arquivos grandes demais não são
// guardados; os grandes (mas não demais) entram sem a cópia editável.
export function guardarPgn({
  id, original, atual, rotulo, nomeArquivo, jogadores, resultado, aberturaEm, posicao,
}) {
  const agora = aberturaEm || Date.now();
  const classe = classificarPorTamanho(original);
  if (classe === 'nao') {
    return { guardado: false, id, soLeitura: false, motivo: 'grande' };
  }
  const soLeitura = classe === 'so-leitura';
  const lista = lerGuardados();
  const item = {
    id: id || `pgn-${agora}-${Math.floor(agora % 100000)}`,
    original,
    // Sem cópia editável no modo só leitura: é ela que dobraria o espaço, e é
    // justamente o que não cabe num arquivo desse tamanho.
    atual: soLeitura ? null : (atual || original),
    soLeitura,
    rotulo,
    nomeArquivo: nomeArquivo || null,
    jogadores,
    resultado,
    aberturaEm: agora,
    ultimoAcesso: agoraMs(),
    posicao: posicao || null,
  };
  const indice = lista.findIndex((g) => g.id === item.id);
  if (indice >= 0) {
    // preserva a data de abertura original ao renovar
    item.aberturaEm = lista[indice].aberturaEm || item.aberturaEm;
    lista[indice] = item;
  } else {
    // Lista cheia: o arquivo novo não entra — e nenhum antigo sai por causa
    // dele. Renovar um que já está na lista sempre passa, porque não ocupa
    // vaga nenhuma a mais.
    if (lista.length >= LIMITE_ARQUIVOS) {
      return { guardado: false, id: item.id, soLeitura, motivo: 'lista-cheia' };
    }
    lista.push(item);
  }
  const r = gravarGuardados(lista);
  return {
    guardado: r.ok, id: item.id, soLeitura, motivo: r.motivo,
  };
}

// Atualiza campos (texto atual editado, posição de leitura) de um guardado.
// Retorna { ok, motivo? } — quem chama decide se vale avisar.
export function atualizarGuardado(id, campos) {
  const lista = lerGuardados();
  const item = lista.find((g) => g.id === id);
  if (!item) return { ok: false, motivo: 'sumiu' };
  const limpos = { ...campos };
  // Guardado só de leitura não recebe cópia editada — mas recebe a posição,
  // que é curta e é o que faz o "Continuar última leitura" valer para ele.
  if (item.soLeitura) delete limpos.atual;
  Object.assign(item, limpos, { ultimoAcesso: agoraMs() });
  return gravarGuardados(lista);
}

export function obterGuardado(id) {
  return lerGuardados().find((g) => g.id === id) || null;
}

export function renovarAcesso(id) {
  const lista = lerGuardados();
  const item = lista.find((g) => g.id === id);
  if (!item) return;
  item.ultimoAcesso = agoraMs();
  gravarGuardados(lista);
}

export function apagarGuardado(id) {
  const lista = lerGuardados().filter((g) => g.id !== id);
  gravarGuardados(lista);
}

export function apagarTodosGuardados() {
  gravarGuardados([]);
}

function agoraMs() {
  return Date.now();
}

export const LIMITES = { LIMITE_ARQUIVOS, LIMITE_POR_ARQUIVO, LIMITE_SO_LEITURA };
