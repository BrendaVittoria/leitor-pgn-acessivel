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
  try {
    localStorage.setItem(PREFIXO + chave, JSON.stringify(valor));
    return true;
  } catch {
    return false;
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

const LIMITE_ARQUIVOS = 20;
const LIMITE_BYTES = 2 * 1024 * 1024;      // ~2 MB somados
const LIMITE_POR_ARQUIVO = 500 * 1024;      // ~500 KB por arquivo

export function lerGuardados() {
  return ler('guardados', []) || [];
}

function gravarGuardados(lista) {
  return gravar('guardados', lista);
}

function tamanhoTotal(lista) {
  return lista.reduce((soma, g) => soma + (g.original || '').length + (g.atual || '').length, 0);
}

// Aplica os limites removendo os itens abertos há mais tempo (menor
// ultimoAcesso) até caber.
function aplicarLimites(lista) {
  const ordenada = [...lista].sort((a, b) => b.ultimoAcesso - a.ultimoAcesso);
  while (
    ordenada.length > LIMITE_ARQUIVOS
    || tamanhoTotal(ordenada) > LIMITE_BYTES
  ) {
    ordenada.pop(); // remove o mais antigo (menor ultimoAcesso, no fim)
    if (ordenada.length === 0) break;
  }
  return ordenada;
}

// Guarda (ou renova) um PGN aberto. Retorna
// { guardado: bool, id, motivo? }. Arquivos grandes demais não são guardados.
export function guardarPgn({
  id, original, atual, rotulo, jogadores, resultado, aberturaEm, posicao,
}) {
  const agora = aberturaEm || Date.now();
  const tamanho = (original || '').length + (atual || '').length;
  if (tamanho > LIMITE_POR_ARQUIVO) {
    return { guardado: false, id, motivo: 'grande' };
  }
  const lista = lerGuardados();
  const item = {
    id: id || `pgn-${agora}-${Math.floor(agora % 100000)}`,
    original,
    atual: atual || original,
    rotulo,
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
    lista.push(item);
  }
  const final = aplicarLimites(lista);
  const ok = gravarGuardados(final);
  return { guardado: ok && final.some((g) => g.id === item.id), id: item.id };
}

// Atualiza campos (texto atual editado, posição de leitura) de um guardado.
export function atualizarGuardado(id, campos) {
  const lista = lerGuardados();
  const item = lista.find((g) => g.id === id);
  if (!item) return false;
  Object.assign(item, campos, { ultimoAcesso: agoraMs() });
  return gravarGuardados(aplicarLimites(lista));
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

export const LIMITES = { LIMITE_ARQUIVOS, LIMITE_BYTES, LIMITE_POR_ARQUIVO };
