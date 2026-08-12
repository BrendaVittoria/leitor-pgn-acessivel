// Orquestração do Leitor de PGN: telas, diálogos, ações e integração PWA
// (share target, file handlers, service worker). Sem framework, sem build.

import { Chess, DEFAULT_POSITION, validateFen } from '../vendor/chess.js';
import {
  iniciarAnunciador, anunciar, definirSom, acordarAudio, precarregarSons,
} from './anunciador.js';
import {
  resultadoFalado, descreverPosicaoBlocos, nomeCasa, descreverLanceFalado,
  comentarioFalado, nomeFormatoDescricao,
} from './fala.js';
import { interpretarEntrada, resolverPromocao } from './parser.js';
import {
  lerPgn, montarPartida, caminhoPorIndices, semInvisiveis,
} from './pgnArvore.js';
import {
  gerarPgnCompleto, gerarPgnLinha, nomeArquivoPgn, baixarPgn,
  arquivoParaCompartilhar, compartilharPgn,
} from './pgnGerar.js';
import { Leitura } from './leitura.js';
import { TabuleiroAcessivel } from './tabuleiro.js';
import { aplicarTema, preencherSelectDeTemas, obterTema } from './temas.js';
import * as store from './armazenamento.js';

const $ = (id) => document.getElementById(id);

// ---------------- Estado ----------------

let prefs = store.lerPreferencias();
let arquivoAtual = null; // { guardadoId, original, partidas: [...], rotulo }
let partidaIdx = 0;
let leitura = null;      // instância de Leitura
let tabuleiro = null;
let avisouNaoGuardou = false;
let avisouSoLeitura = false;
let avisouSemEspacoAoSalvar = false;

// Não coube: a partida abre e é lida igual, só não fica na lista do app — e
// nenhum PGN da pessoa foi apagado por causa dela. Cada motivo tem a sua
// frase porque cada um deixa uma saída diferente nas mãos de quem ouve.
//
// Todas dizem "neste app", nunca "no aparelho": o que acabou é a lista de
// PGNs guardados aqui dentro, não o espaço do celular. A diferença importa —
// "não coube no aparelho" seguido de "baixe o arquivo" é uma contradição, já
// que baixar é justamente gravar no aparelho, e isso continua funcionando.
const NAO_GUARDOU = {
  'sem-espaco': 'Acabou o espaço que este app tem para guardar PGNs. A leitura funciona '
    + 'normalmente, mas a partida não será mantida aqui. Para mantê-la, apague algum PGN '
    + 'na tela inicial.',
  'lista-cheia': 'Já há 20 PGNs guardados, que é o máximo. A leitura funciona normalmente, '
    + 'mas a partida não será mantida neste app. Apague algum PGN na tela inicial '
    + 'para abrir vaga.',
  indisponivel: 'Este navegador não está deixando guardar nada; o app segue como leitor, '
    + 'mas nada fica salvo ao fechar.',
  grande: 'Arquivo grande demais; não será mantido neste app. Para reler, abra o arquivo '
    + 'de novo.',
};

// Arquivo grande guardado sem cópia editável: ele reabre e retoma a posição,
// mas as anotações não sobrevivem ao fechamento do app. Dizer isso ANTES de a
// pessoa anotar meia hora é o mínimo — e uma vez por sessão basta, senão vira
// ladainha a cada arquivo aberto.
function avisarSoLeitura() {
  if (avisouSoLeitura) return;
  avisouSoLeitura = true;
  setTimeout(() => anunciar('Arquivo grande. Fica neste app para reabrir e continuar de onde '
    + 'parou, mas as alterações não são mantidas: para levá-las, use Salvar novo PGN.'), 1500);
}

// ---------------- Utilidades de fala/rótulo ----------------

function nomeJogador(valor) {
  const v = (valor || '').trim();
  return v && v !== '?' ? v : null;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function formatarData(pgnDate) {
  if (!pgnDate) return null;
  const m = pgnDate.match(/^(\d{4}|\?{4})\.(\d{2}|\?\?)\.(\d{2}|\?\?)$/);
  if (!m) return pgnDate.includes('?') ? null : pgnDate;
  const [, ano, mes, dia] = m;
  if (dia !== '??' && mes !== '??' && ano !== '????') {
    return `${Number(dia)} de ${MESES[Number(mes) - 1]} de ${ano}`;
  }
  if (mes !== '??' && ano !== '????') return `${MESES[Number(mes) - 1]} de ${ano}`;
  if (ano !== '????') return ano;
  return null;
}

// Rótulo falado de uma partida para listas e cabeçalho (omitindo campos vazios).
function descreverPartida(tags, resultado) {
  const brancas = nomeJogador(tags.White) || 'Brancas';
  const pretas = nomeJogador(tags.Black) || 'Pretas';
  const partes = [`${brancas} contra ${pretas}`];
  const res = resultadoFalado(resultado);
  if (resultado && resultado !== '*') partes.push(res);
  const evento = nomeJogador(tags.Event);
  if (evento) partes.push(evento);
  const data = formatarData(tags.Date);
  if (data) partes.push(data);
  return partes.join(', ');
}

function cabecalhoCurto(tags, resultado) {
  const brancas = nomeJogador(tags.White) || 'Brancas';
  const pretas = nomeJogador(tags.Black) || 'Pretas';
  const base = `${brancas} contra ${pretas}`;
  // "Em andamento" é o estado padrão: só vale falar o resultado decidido.
  if (!resultado || resultado === '*') return base;
  return `${base} — ${resultadoFalado(resultado)}`;
}

// ---------------- Telas ----------------

function mostrarTela(nome) {
  for (const id of ['tela-inicial', 'tela-lista', 'tela-leitura']) {
    $(id).hidden = id !== nome;
  }
}

// ---------------- Leitura de arquivo (com fallback de codificação) ----------------

async function lerTextoArquivo(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---------------- Abrir PGN (as quatro portas convergem aqui) ----------------

function abrirTextoPgn(texto, { guardadoId = null, posicao = null, nomeArquivo = null } = {}) {
  // Reabrir um arquivo já guardado (mesmo texto original) renova a entrada
  // em vez de duplicá-la, e recupera as edições autossalvas e a posição.
  if (!guardadoId) {
    const existente = store.lerGuardados().find((g) => g.original === texto);
    if (existente) {
      guardadoId = existente.id;
      if (existente.atual && existente.atual !== texto) texto = existente.atual;
      if (!posicao) posicao = existente.posicao;
    }
  }

  const { partidas, ignoradas } = lerPgn(texto);
  if (partidas.length === 0) {
    anunciar('Não encontrei nenhuma partida válida neste conteúdo.');
    return false;
  }

  // O texto importado de verdade fica separado do que está sendo lido: numa
  // reabertura, `texto` já é a cópia com as edições da sessão passada, e é o
  // original guardado que o "Restaurar original" tem de devolver.
  const guardado = guardadoId ? store.obterGuardado(guardadoId) : null;
  const textoOriginal = guardado ? guardado.original : texto;

  // Num arquivo de uma partida só, o rótulo é a própria partida. Numa coleção
  // não: "Livro de finais.pgn" é o que a pessoa reconhece na lista, enquanto o
  // nome dos dois jogadores da PRIMEIRA partida não diz nada sobre as outras
  // nove mil. Quando o nome do arquivo existe, é ele que manda na coleção.
  const rotuloPartida = descreverPartida(partidas[0].tags, partidas[0].resultado);
  const nome = nomeArquivo || (guardado && guardado.nomeArquivo) || null;
  const rotulo = (partidas.length > 1 && nome) ? semExtensaoPgn(nome) : rotuloPartida;
  arquivoAtual = {
    guardadoId,
    original: textoOriginal,
    partidas,
    rotulo,
    nomeArquivo: nome,
    soLeitura: Boolean(guardado && guardado.soLeitura),
    modificado: textoOriginal.trim() !== texto.trim(),
  };

  // Guarda (ou renova) o arquivo — se a pessoa quiser guardar, e se couber.
  if (!guardadoId && prefs.guardarAutomatico) {
    const r = store.guardarPgn({
      original: texto,
      atual: texto,
      rotulo,
      nomeArquivo: nome,
      jogadores: `${nomeJogador(partidas[0].tags.White) || 'Brancas'} x ${nomeJogador(partidas[0].tags.Black) || 'Pretas'}`,
      resultado: partidas[0].resultado,
    });
    if (r.guardado) {
      arquivoAtual.guardadoId = r.id;
      arquivoAtual.soLeitura = r.soLeitura;
      if (r.soLeitura) avisarSoLeitura();
    } else if (!avisouNaoGuardou) {
      avisouNaoGuardou = true;
      setTimeout(() => anunciar(NAO_GUARDOU[r.motivo] || NAO_GUARDOU.grande), 1200);
    }
  } else if (!guardadoId) {
    // Guardar está desligado: leitura pura, e o app não finge que salvou.
    arquivoAtual.guardadoId = null;
  } else {
    if (arquivoAtual.soLeitura) avisarSoLeitura();
    store.renovarAcesso(guardadoId);
  }

  if (partidas.length === 1) {
    abrirPartida(0, { indices: posicao && posicao.indices });
  } else if (posicao && partidas[posicao.partidaIdx]) {
    // Retomada de coleção: volta direto à partida e ao lance guardados.
    abrirPartida(posicao.partidaIdx, { indices: posicao.indices });
  } else {
    let msg = `Arquivo com ${partidas.length} partidas. Escolha uma da lista.`;
    if (ignoradas > 0) {
      msg = `Arquivo com ${partidas.length} partidas legíveis. ${ignoradas} foram ignoradas por erro de formato.`;
    }
    mostrarListaPartidas(msg);
  }
  return true;
}

// Paginação: coleções gigantes (bancos com milhares de partidas) renderizam
// uma página por vez para a lista nunca travar o app (seção 8 da
// especificação) e, principalmente, para caber na cabeça de quem percorre a
// lista de ouvido — 50 botões já são bastante.
const POR_PAGINA = 50;
let paginaLista = 0;

function totalPaginas() {
  return Math.max(1, Math.ceil(arquivoAtual.partidas.length / POR_PAGINA));
}

// `naPartidaAtual` abre a lista já na página da partida em leitura — é o que
// "Trocar de partida" quer: a vizinhança de onde a pessoa está, não o começo
// de um arquivo de mil partidas.
function mostrarListaPartidas(mensagem, { naPartidaAtual = false } = {}) {
  mostrarTela('tela-lista');
  $('lista-descricao').textContent = mensagem;
  paginaLista = naPartidaAtual ? Math.floor(partidaIdx / POR_PAGINA) : 0;
  renderPaginaLista();
  anunciar(mensagem);
}

function renderPaginaLista({ focarPartida = null } = {}) {
  const total = arquivoAtual.partidas.length;
  const paginas = totalPaginas();
  paginaLista = Math.min(Math.max(paginaLista, 0), paginas - 1);
  const inicio = paginaLista * POR_PAGINA;
  const fim = Math.min(inicio + POR_PAGINA, total);

  const ol = $('lista-partidas');
  ol.textContent = '';
  ol.start = inicio + 1;
  for (let i = inicio; i < fim; i++) {
    const p = arquivoAtual.partidas[i];
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    // O número vai no texto do botão, não só na numeração do <ol>: é o que o
    // leitor de tela fala ao pousar nele, e é assim que a pessoa sabe em que
    // ponto da coleção está sem contar item por item.
    b.textContent = `${i + 1}. ${descreverPartida(p.tags, p.resultado)}`;
    b.dataset.partida = String(i);
    b.addEventListener('click', () => abrirPartida(i));
    li.appendChild(b);
    ol.appendChild(li);
  }

  const paginado = paginas > 1;
  $('paginacao-partidas').hidden = !paginado;
  if (paginado) {
    $('paginacao-info').textContent = `Página ${paginaLista + 1} de ${paginas}. `
      + `Partidas ${inicio + 1} a ${fim} de ${total}.`;
    $('btn-pagina-anterior').disabled = paginaLista === 0;
    $('btn-pagina-proxima').disabled = paginaLista >= paginas - 1;
    $('campo-pagina').max = String(paginas);
    $('campo-partida').max = String(total);
  }

  if (focarPartida !== null) {
    ol.querySelector(`button[data-partida="${focarPartida}"]`)?.focus();
  }
}

// Trocar de página leva o foco para a linha de informação da paginação: ela
// diz em voz alta onde a pessoa foi parar ("Página 3 de 8, partidas 101 a
// 150"), e dali um passo à frente já é o primeiro botão da página nova. Um
// anúncio por aria-live junto com a mudança de foco só faria os dois textos
// se atropelarem.
function irParaPagina(numero) {
  const paginas = totalPaginas();
  if (!Number.isInteger(numero) || numero < 1 || numero > paginas) {
    anunciar(`Página inválida. O arquivo tem ${paginas} ${paginas === 1 ? 'página' : 'páginas'}.`);
    return;
  }
  paginaLista = numero - 1;
  renderPaginaLista();
  $('paginacao-info').focus();
}

// "Ir para a partida" não abre a partida: leva até ela e põe o foco no botão,
// que se apresenta ("137. Fulano contra Sicrano..."). Abrir direto tiraria a
// chance de conferir se o número era mesmo aquele.
function irParaNumeroDePartida(numero) {
  const total = arquivoAtual.partidas.length;
  if (!Number.isInteger(numero) || numero < 1 || numero > total) {
    anunciar(`Partida inválida. O arquivo tem ${total} ${total === 1 ? 'partida' : 'partidas'}.`);
    return;
  }
  paginaLista = Math.floor((numero - 1) / POR_PAGINA);
  renderPaginaLista({ focarPartida: numero - 1 });
}

// Campo vazio ou com lixo devolve NaN, que as funções acima recusam com a
// mensagem certa em vez de saltar para lugar nenhum.
function numeroDoCampo(id) {
  return parseInt($(id).value, 10);
}

function abrirPartida(idx, { indices = null } = {}) {
  partidaIdx = idx;
  const partida = arquivoAtual.partidas[idx];
  leitura = new Leitura(partida, {
    perguntarBifurcacoes: () => prefs.perguntarBifurcacoes,
    aoMudar: () => { render(); persistirPosicao(); },
    aoAlterar: registrarAlteracao,
    aoAbrirBifurcacao: abrirBifurcacao,
  });
  if (indices && indices.length) {
    leitura.caminho = caminhoPorIndices(partida.raiz, indices);
  }
  mostrarTela('tela-leitura');
  configurarTabuleiro();
  aplicarPrefDigitacao();
  render();
  // Fecha caixas reveláveis do painel.
  fecharRevelaveis();
  const nomes = cabecalhoCurto(partida.tags, partida.resultado);
  // Numa coleção, o número da partida entra na frente do nome: percorrendo
  // partida a partida, é ele que diz onde a pessoa está no arquivo.
  const total = arquivoAtual.partidas.length;
  const onde = total > 1 ? `Partida ${idx + 1} de ${total}.` : 'Partida carregada.';
  if (!partida.temLances) {
    anunciar(`${onde} ${nomes}. Partida sem lances registrados.`);
  } else if (leitura.caminho.length > 1) {
    anunciar(`${onde} ${nomes}. Retomada no lance ${leitura.caminho.length - 1}.`);
  } else {
    anunciar(`${onde} ${nomes}.`);
  }
  persistir();
}

// Próxima/anterior partida do arquivo. Nos extremos os botões respondem em
// voz alta em vez de ficarem mortos — mesma regra dos botões de lance.
function irParaPartidaVizinha(passo) {
  if (!arquivoAtual) return;
  const total = arquivoAtual.partidas.length;
  const novo = partidaIdx + passo;
  if (novo < 0) {
    anunciar('Esta já é a primeira partida do arquivo.');
    return;
  }
  if (novo >= total) {
    anunciar('Esta já é a última partida do arquivo.');
    return;
  }
  abrirPartida(novo);
}

// ---------------- Renderização da tela de leitura ----------------

function estadoFen() {
  return leitura ? leitura.fenAtual() : DEFAULT_POSITION;
}

function render() {
  if (!leitura) return;
  const est = leitura.estado();
  const partida = leitura.partida;

  $('cabecalho-linha').textContent = cabecalhoCurto(partida.tags, partida.resultado);
  renderDetalhes(partida.tags);

  // Botões de navegação: sempre habilitados quando a partida tem lances —
  // apertar nos limites responde com anúncio ("Fim dos lances.", "Início da
  // partida."), nunca silêncio nem botão morto (seção 3.1 da especificação).
  // Só a posição avulsa/partida sem lances os desabilita.
  const semLances = partida.raiz.children.length === 0;
  $('btn-anterior').disabled = semLances;
  $('btn-proximo').disabled = semLances;
  $('btn-tab-anterior').disabled = semLances;
  $('btn-tab-proximo').disabled = semLances;
  $('btn-inicio').disabled = semLances;
  $('btn-final').disabled = semLances;
  $('btn-sair-variante').disabled = !est.podeSairVariante;
  $('btn-voltar-principal').disabled = !est.podeVoltarPrincipal;
  $('btn-variantes').disabled = !est.temVariantesNoLance;
  $('indicador-posicao').textContent = est.indicador;

  // Apagar lance: só quando há um lance atual para apagar
  $('btn-apagar-lance').disabled = est.ehRaiz;

  // Restaurar original: habilitado só quando há alterações
  $('btn-restaurar').disabled = !arquivoFoiModificado();
  const varias = arquivoAtual.partidas.length > 1;
  $('nav-partidas').hidden = !varias;
  if (varias) {
    $('indicador-partida').textContent = `Partida ${partidaIdx + 1} de ${arquivoAtual.partidas.length}`;
  }

  // Tabuleiro
  if (tabuleiro && !$('area-tabuleiro').hidden) {
    tabuleiro.atualizar();
    if (est.move) {
      tabuleiro.destacarLance(est.move.from, est.move.to, est.emVariante);
    } else {
      tabuleiro.destacarLance(null, null, false);
    }
  }

  // Lista de lances (só se aberta)
  if (!$('area-lances').hidden) renderArvore();

  // Comentário atual na caixa (se aberta)
  if (!$('area-comentario').hidden) {
    $('campo-comentario').value = est.comentario;
  }
}

function renderDetalhes(tags) {
  const dl = $('detalhes-partida');
  dl.textContent = '';
  const campos = [
    ['Event', 'Evento'], ['Site', 'Local'], ['Date', 'Data'], ['Round', 'Rodada'],
    ['Arbiter', 'Árbitro'], ['WhiteElo', 'ELO das brancas'], ['BlackElo', 'ELO das pretas'],
    ['TimeControl', 'Ritmo'], ['ECO', 'Código ECO'],
  ];
  let algum = false;
  for (const [chave, rotulo] of campos) {
    const valor = nomeJogador(tags[chave]);
    if (!valor) continue;
    algum = true;
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = rotulo;
    const dd = document.createElement('dd');
    dd.textContent = chave === 'Date' ? (formatarData(valor) || valor) : valor;
    div.appendChild(dt);
    div.appendChild(dd);
    dl.appendChild(div);
  }
  $('btn-detalhes').disabled = !algum;
}

// ---------------- Árvore de lances (lista com salto) ----------------

function renderArvore() {
  const cont = $('arvore-lances');
  cont.textContent = '';
  const raiz = leitura.partida.raiz;
  if (!raiz.children[0]) {
    const p = document.createElement('p');
    p.className = 'ajuda';
    p.textContent = 'Sem lances registrados.';
    cont.appendChild(p);
    return;
  }
  // A lista mostra o comentário já traduzido (setas e casas por extenso, sem
  // os comandos de máquina); o texto cru fica guardado no PGN e na caixa de
  // edição, que é onde ele pode ser mexido.
  const comentRaiz = comentarioFalado(raiz.comment);
  if (comentRaiz) {
    const c = document.createElement('p');
    c.className = 'comentario';
    c.textContent = `{${comentRaiz}}`;
    cont.appendChild(c);
  }
  const ol = document.createElement('ol');
  renderLinhaLista(raiz.children[0], ol);
  cont.appendChild(ol);
}

function renderLinhaLista(inicio, ol) {
  let no = inicio;
  let li = null;
  while (no) {
    const ehBranco = no.cor === 'w';
    if (ehBranco || !li) {
      li = document.createElement('li');
      ol.appendChild(li);
      if (!ehBranco) {
        const s = document.createElement('span');
        s.textContent = `${no.numero}… `;
        li.appendChild(s);
      }
    }
    if (ehBranco) {
      const s = document.createElement('span');
      s.textContent = `${no.numero}. `;
      li.appendChild(s);
    }
    li.appendChild(botaoLance(no));
    const coment = comentarioFalado(no.comment);
    if (coment) {
      const c = document.createElement('span');
      c.className = 'comentario';
      c.textContent = ` {${coment}} `;
      li.appendChild(c);
    }
    // Variantes deste lance (irmãos), só no nó principal do garfo.
    if (no.parent.children[0] === no && no.parent.children.length > 1) {
      for (let k = 1; k < no.parent.children.length; k++) {
        const subOl = document.createElement('ol');
        subOl.className = 'variante-lista';
        renderLinhaLista(no.parent.children[k], subOl);
        li.appendChild(subOl);
      }
      li = null; // após variante, o próximo lance começa novo item numerado
    }
    no = no.children[0];
  }
}

function botaoLance(no) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lance-btn';
  let texto = faladoCurto(no);
  b.textContent = texto;
  if (no === leitura.atual) b.setAttribute('aria-current', 'true');
  b.addEventListener('click', () => leitura.irParaNo(no));
  return b;
}

function faladoCurto(no) {
  // Reaproveita a fala do lance (import dinâmico evitado: replica leve).
  const mv = no.move;
  let s = mv ? descreverMoveCurto(mv) : '';
  if (no.san && no.san.endsWith('#')) s += ', mate';
  else if (no.san && no.san.endsWith('+')) s += ', xeque';
  return s;
}

// Fala curta para os botões da lista (sem importar fala.js de novo aqui).
function descreverMoveCurto(mv) {
  if (mv.san.startsWith('O-O-O')) return 'roque grande';
  if (mv.san.startsWith('O-O')) return 'roque pequeno';
  const destino = nomeCasa(mv.to);
  const nomes = { p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'dama', k: 'rei' };
  const cols = { a: 'anna', b: 'bella', c: 'cesar', d: 'david', e: 'eva', f: 'felix', g: 'gustav', h: 'hector' };
  let texto;
  if (mv.captured) {
    const quem = mv.piece === 'p' ? cols[mv.from[0]] : nomes[mv.piece];
    texto = `${quem} toma ${destino}`;
  } else if (mv.piece === 'p') {
    texto = destino;
  } else {
    texto = `${nomes[mv.piece]} ${destino}`;
  }
  if (mv.promotion) texto += `, promove a ${nomes[mv.promotion]}`;
  return texto;
}

// ---------------- Tabuleiro ----------------

function configurarTabuleiro() {
  if (!tabuleiro) {
    tabuleiro = new TabuleiroAcessivel($('area-tabuleiro'), {
      somenteLeitura: false,
      obterChess: () => new Chess(estadoFen()),
      aoTentarLance: aoTentarLanceTabuleiro,
      anunciar,
      // Digitar com o foco no tabuleiro leva a letra para a caixa de lances,
      // revelando-a se estiver oculta (comportamento herdado do relógio).
      aoDigitar: (caractere) => {
        revelarDigitacao();
        const campo = $('entrada-lance');
        campo.value += caractere;
        campo.focus();
      },
    });
  }
  aplicarPrefTabuleiro();
}

// As duas formas de ver a partida não precisam ser iguais, e não são: com o
// tabuleiro à vista, andar nos lances é o gesto do momento e as setas ficam
// coladas nele; sem tabuleiro, é "Descrever posição" que vira o gesto do
// momento — é a única forma de saber onde estão as peças —, então ele sai do
// painel e fica fixo na tela. O que nunca acontece é o mesmo comando aparecer
// duas vezes na mesma tela.
function aplicarPrefTabuleiro() {
  const mostrar = prefs.tabuleiro;
  $('area-tabuleiro').hidden = !mostrar;
  // Os botões de seta só existem enquanto o tabuleiro está à vista; sem ele
  // seriam um par de alvos duplicados no caminho do leitor de tela.
  $('nav-tabuleiro').hidden = !mostrar;
  $('linha-lances-texto').hidden = mostrar;
  // "Descrever posição" troca de lugar em vez de existir nos dois: fixo na
  // tela no modo sem tabuleiro, dentro do painel de ações no modo com.
  $('btn-descrever-fixo').hidden = mostrar;
  $('btn-descrever').hidden = !mostrar;
  $('btn-tabuleiro').setAttribute('aria-expanded', String(mostrar));
  $('btn-tabuleiro').textContent = mostrar ? 'Ocultar tabuleiro' : 'Mostrar tabuleiro';
  if (mostrar && leitura) {
    tabuleiro.atualizar();
    const est = leitura.estado();
    if (est.move) tabuleiro.destacarLance(est.move.from, est.move.to, est.emVariante);
  }
}

// Caixa de digitação de lances: revelada pelo botão "Digitar lances" (com
// preferência persistida) e aberta sozinha no modo de criação.
function aplicarPrefDigitacao(focar = false) {
  const mostrar = prefs.digitacao;
  $('area-entrada-lance').hidden = !mostrar;
  $('btn-digitar').setAttribute('aria-expanded', String(mostrar));
  $('btn-digitar').textContent = mostrar ? 'Ocultar digitação' : 'Digitar lances';
  if (mostrar && focar) $('entrada-lance').focus();
}

let promoPendente = null; // {de, para}

function aoTentarLanceTabuleiro(de, para, precisaPromocao) {
  acordarAudio();
  if (precisaPromocao) {
    promoPendente = { de, para };
    $('dialogo-promocao').showModal();
    return;
  }
  jogarCoord(de, para, null);
}

function jogarCoord(de, para, promo) {
  const chess = new Chess(estadoFen());
  let mv;
  try {
    mv = promo
      ? chess.move({ from: de, to: para, promotion: promo })
      : chess.move({ from: de, to: para });
  } catch {
    mv = null;
  }
  if (!mv) {
    anunciar('Lance ilegal nesta posição.');
    return;
  }
  leitura.jogarLance(mv.san);
}

// ---------------- Diálogo de bifurcação ----------------

function abrirBifurcacao(opcoes, escolher) {
  const dlg = $('dialogo-bifurcacao');
  const cont = $('opcoes-bifurcacao');
  cont.textContent = '';
  let resolvido = false;
  const finalizar = (no) => {
    if (resolvido) return;
    resolvido = true;
    dlg.close();
    escolher(no);
  };
  opcoes.forEach((op) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = op.rotulo;
    b.addEventListener('click', () => finalizar(op.no));
    cont.appendChild(b);
  });
  dlg.onclose = () => {
    if (!resolvido) {
      resolvido = true;
      escolher(null);
    }
  };
  dlg.showModal();
  cont.querySelector('button')?.focus();
}

$('btn-cancelar-bifurcacao').addEventListener('click', () => $('dialogo-bifurcacao').close());

// ---------------- Persistência ----------------

// Partida que nunca chegou a ser aberta continua sendo, letra por letra, o
// que veio no arquivo: copiar o texto dela é mais fiel (nenhuma reescrita de
// formatação) e evita montar a árvore de mil partidas só para regravar uma.
function textoAtualArquivo() {
  return arquivoAtual.partidas
    .map((p) => (p.intacta ? p.textoBruto : gerarPgnCompleto(p)).trim())
    .join('\n\n');
}

// Bandeira, não comparação de textos: `render()` roda a cada lance navegado,
// e regerar o PGN inteiro para comparar travaria a navegação num arquivo de
// mil partidas. Quem levanta a bandeira é `persistir()`, chamado em toda
// mutação; só o "Restaurar original" a abaixa.
function arquivoFoiModificado() {
  return Boolean(arquivoAtual && arquivoAtual.modificado);
}

// Posição de leitura: salva a cada navegação (com um pequeno debounce para
// não reescrever o localStorage a cada toque em sequência rápida). É o que
// mantém o "Continuar última leitura, lance N" sempre atual.
let persistirPosicaoTimeout = null;

function persistirPosicao() {
  if (!arquivoAtual || !leitura || !arquivoAtual.guardadoId) return;
  if (persistirPosicaoTimeout) clearTimeout(persistirPosicaoTimeout);
  persistirPosicaoTimeout = setTimeout(() => {
    persistirPosicaoTimeout = null;
    if (!arquivoAtual || !leitura || !arquivoAtual.guardadoId) return;
    const indices = leitura.indicesAtuais();
    store.atualizarGuardado(arquivoAtual.guardadoId, {
      posicao: { partidaIdx, indices },
    });
    store.gravarUltimaLeitura({
      guardadoId: arquivoAtual.guardadoId,
      partidaIdx,
      indices,
      rotulo: arquivoAtual.rotulo,
      lance: leitura.caminho.length - 1,
    });
  }, 250);
}

// Mutações (lances novos, comentários, cabeçalho): salvam o texto editado
// na cópia guardada, além da posição. No guardado só de leitura não há cópia
// editada para salvar — e nem se gera o texto, que num arquivo grande custa
// caro à toa.
function persistir() {
  if (!arquivoAtual || !leitura) return;
  if (arquivoAtual.guardadoId && !arquivoAtual.soLeitura) {
    const r = store.atualizarGuardado(arquivoAtual.guardadoId, { atual: textoAtualArquivo() });
    // Alteração que não coube é trabalho que se perde ao fechar: isso não pode
    // acontecer em silêncio. Uma vez por sessão, para não virar ladainha a
    // cada lance anotado.
    if (!r.ok && r.motivo === 'sem-espaco' && !avisouSemEspacoAoSalvar) {
      avisouSemEspacoAoSalvar = true;
      anunciar('As alterações desta partida não estão sendo mantidas neste app: elas valem '
        + 'enquanto ele estiver aberto. Apague algum PGN na tela inicial para abrir espaço, '
        + 'ou use Salvar novo PGN para levá-las.');
    }
  }
  persistirPosicao();
}

// Toda mutação passa por aqui (é o `aoAlterar` da Leitura) — e só por aqui,
// nunca pela abertura de uma partida, que também persiste mas não altera nada.
function registrarAlteracao() {
  if (arquivoAtual) arquivoAtual.modificado = true;
  persistir();
}

// ---------------- Ações do painel ----------------

async function copiarFen() {
  const fen = estadoFen();
  try {
    await navigator.clipboard.writeText(fen);
    anunciar('FEN copiado.');
  } catch {
    anunciar('Não foi possível copiar: a área de transferência não está disponível.');
  }
}

function descreverPosicaoDialogo() {
  renderDescricao();
  $('dialogo-descrever').showModal();
  // Foco no título: o conteúdo do diálogo é para ler, então a leitura começa
  // no começo dele, e não no botão do fim.
  $('titulo-descrever').focus();
}

function renderDescricao() {
  const chess = new Chess(estadoFen());
  const blocos = descreverPosicaoBlocos(chess, prefs.formatoDescricao);
  const cont = $('blocos-descricao');
  cont.textContent = '';
  for (const bloco of blocos) {
    const p = document.createElement('p');
    p.textContent = bloco;
    cont.appendChild(p);
  }
  // O botão diz para onde ele leva, não onde se está: é o rótulo que funciona
  // sem ver o resto da tela.
  const outro = outroFormatoDescricao();
  $('btn-formato-descricao').textContent = `Mudar para descrição ${nomeFormatoDescricao(outro)}`;
}

function outroFormatoDescricao() {
  return prefs.formatoDescricao === 'fen' ? 'pecas' : 'fen';
}

function alternarFormatoDescricao() {
  prefs.formatoDescricao = outroFormatoDescricao();
  store.gravarPreferencias({ formatoDescricao: prefs.formatoDescricao });
  renderDescricao();
  // Volta ao começo da descrição: o texto todo mudou, e reler do início é o
  // motivo de ter trocado de formato.
  $('titulo-descrever').focus();
}

function abrirComentario() {
  const area = $('area-comentario');
  const abrir = area.hidden;
  fecharRevelaveis();
  area.hidden = !abrir;
  $('btn-comentar').setAttribute('aria-expanded', String(abrir));
  if (abrir) {
    $('campo-comentario').value = leitura.estado().comentario;
    $('campo-comentario').focus();
  }
}

function editarCabecalhoDialogo() {
  const t = leitura.partida.tags;
  $('tag-white').value = t.White && t.White !== '?' ? t.White : '';
  $('tag-black').value = t.Black && t.Black !== '?' ? t.Black : '';
  $('tag-event').value = t.Event && t.Event !== '?' ? t.Event : '';
  $('tag-site').value = t.Site && t.Site !== '?' ? t.Site : '';
  $('tag-date').value = t.Date && t.Date !== '?' ? t.Date : '';
  $('tag-round').value = t.Round && t.Round !== '?' ? t.Round : '';
  $('dialogo-cabecalho').showModal();
}

// ---------------- Salvar novo PGN ----------------

let pgnParaSalvar = null;

// Preenche o select de destino: novo arquivo ou acrescentar a um guardado.
function popularSelectDestino(idSelect) {
  const sel = $(idSelect);
  sel.textContent = '';
  const novo = document.createElement('option');
  novo.value = '';
  novo.textContent = 'Novo arquivo guardado';
  sel.appendChild(novo);
  // Guardado só de leitura fica fora da lista: ele não tem cópia editável
  // para receber a partida nova, e oferecê-lo seria oferecer um destino que
  // recusa tudo.
  const lista = store.lerGuardados()
    .filter((g) => !g.soLeitura)
    .sort((a, b) => b.ultimoAcesso - a.ultimoAcesso);
  for (const g of lista) {
    const op = document.createElement('option');
    op.value = g.id;
    op.textContent = `Adicionar a: ${g.rotulo || g.jogadores || 'PGN guardado'}`;
    sel.appendChild(op);
  }
}

// Lê o destino escolhido num select preenchido acima; null = novo arquivo.
function obterDestinoSelecionado(idSelect) {
  const valor = $(idSelect).value;
  return valor ? store.obterGuardado(valor) : null;
}

// Acrescenta uma partida (texto PGN) ao fim de um arquivo guardado.
// Devolve mensagem de erro, ou null se deu certo.
function acrescentarAoGuardado(destino, texto) {
  const base = (destino.atual || destino.original).trim();
  const novoAtual = `${base}\n\n${texto}`;
  if (novoAtual.length > store.LIMITES.LIMITE_POR_ARQUIVO) {
    return 'O arquivo escolhido ficaria grande demais. Salve como novo arquivo.';
  }
  if (arquivoAtual && arquivoAtual.guardadoId === destino.id) {
    // Destino é o próprio arquivo aberto: acrescenta também na memória, senão
    // o autossalvamento seguinte apagaria a partida recém-adicionada.
    const { partidas } = lerPgn(texto);
    arquivoAtual.partidas.push(...partidas);
    $('nav-partidas').hidden = arquivoAtual.partidas.length < 2;
    store.atualizarGuardado(destino.id, { atual: textoAtualArquivo() });
  } else {
    store.atualizarGuardado(destino.id, { atual: novoAtual });
  }
  return null;
}

function abrirSalvar() {
  pgnParaSalvar = null;
  popularSelectDestino('salvar-destino');
  $('area-salvar-pronto').hidden = true;
  $('dialogo-salvar').querySelector('.opcoes-coluna').hidden = false;
  $('dialogo-salvar').showModal();
  $('btn-salvar-inteira').focus();
}

function prepararSalvar(modo) {
  const partida = leitura.partida;
  let texto;
  if (modo === 'linha') {
    const nota = `Extraído de: ${cabecalhoCurto(partida.tags, partida.resultado)}${leitura.emVariante() ? `, variante do lance ${leitura.caminho.length - 1}` : ''}`;
    texto = gerarPgnLinha(partida, leitura.caminho, nota);
  } else {
    texto = gerarPgnCompleto(partida);
  }
  pgnParaSalvar = {
    texto,
    nome: nomeArquivoPgn(arquivoAtual.rotulo),
  };
  const destino = obterDestinoSelecionado('salvar-destino');
  let mensagem = 'PGN salvo. Baixe ou compartilhe o arquivo.';
  if (destino) {
    const erro = acrescentarAoGuardado(destino, texto);
    if (erro) { anunciar(erro); return; }
    mensagem = `Partida adicionada a: ${destino.rotulo}. Baixe ou compartilhe a partida salva.`;
  } else {
    // Guarda como novo arquivo entre os guardados. Salvar é ato explícito, e
    // acontece mesmo com o "guardar automaticamente" desligado — mas se não
    // couber, a mensagem tem de dizer, senão a pessoa vai embora achando que
    // guardou. O arquivo continua pronto para baixar ou compartilhar.
    const r = store.guardarPgn({
      original: texto,
      atual: texto,
      rotulo: `${arquivoAtual.rotulo} (salvo)`,
      jogadores: arquivoAtual.rotulo,
      resultado: partida.resultado,
    });
    if (!r.guardado) {
      mensagem = 'O PGN está pronto, mas não será mantido neste app.';
    }
  }
  $('dialogo-salvar').querySelector('.opcoes-coluna').hidden = true;
  $('area-salvar-pronto').hidden = false;
  $('salvar-pronto-texto').textContent = mensagem;
  // Compartilhar só aparece se o navegador aceita algum dos formatos (.pgn ou .txt)
  $('btn-compartilhar-salvo').hidden = arquivoParaCompartilhar(texto, pgnParaSalvar.nome) === null;
  $('btn-copiar-salvo').hidden = !navigator.clipboard;
  anunciar(mensagem);
  atualizarGuardadosSeVisivel();
  $('btn-baixar-salvo').focus();
}

// ---------------- Criar PGN ----------------

function abrirCriar() {
  popularSelectDestino('criar-destino');
  $('area-criar-fen').hidden = true;
  $('btn-criar-fen-abrir').setAttribute('aria-expanded', 'false');
  $('erro-criar-fen').hidden = true;
  $('dialogo-criar').showModal();
  $('btn-criar-nova').focus();
}

function criarPartida(fen) {
  const tags = {
    Event: '?', Site: '?', Date: dataHoje(), Round: '?',
    White: '?', Black: '?', Result: '*',
  };
  if (fen) {
    tags.SetUp = '1';
    tags.FEN = fen;
  }
  const partida = montarPartida({ tagsText: tagsParaTexto(tags), bodyText: '*' });
  const destino = obterDestinoSelecionado('criar-destino');
  if (destino) {
    // Cria a partida dentro de um arquivo guardado existente e abre nela.
    const base = (destino.atual || destino.original).trim();
    const textoNovo = `${base}\n\n${gerarPgnCompleto(partida)}`;
    if (textoNovo.length > store.LIMITES.LIMITE_POR_ARQUIVO) {
      anunciar('O arquivo escolhido ficaria grande demais. Crie como novo arquivo.');
      return;
    }
    const { partidas } = lerPgn(base);
    partidas.push(partida);
    arquivoAtual = {
      guardadoId: destino.id,
      original: textoNovo,
      partidas,
      rotulo: destino.rotulo,
    };
    store.atualizarGuardado(destino.id, { atual: textoNovo });
    abrirPartida(partidas.length - 1);
    revelarDigitacao();
    anunciar(`Partida criada dentro de: ${destino.rotulo}. Jogue os lances.`);
    return;
  }
  arquivoAtual = {
    guardadoId: null,
    original: gerarPgnCompleto(partida),
    partidas: [partida],
    rotulo: 'Nova partida',
  };
  const r = store.guardarPgn({
    original: arquivoAtual.original,
    atual: arquivoAtual.original,
    rotulo: 'Nova partida',
    jogadores: 'Brancas x Pretas',
    resultado: '*',
  });
  if (r.guardado) arquivoAtual.guardadoId = r.id;
  abrirPartida(0);
  // A criação nasce com a entrada de lances ligada (seção 3.6), sem alterar
  // a preferência guardada — o botão "Ocultar digitação" continua mandando.
  revelarDigitacao();
  const base = fen ? 'Partida criada a partir do FEN.' : 'Partida nova.';
  // Criar sem conseguir guardar é o caso mais perigoso de todos: a partida
  // não existe em lugar nenhum além desta tela. Isso precisa ser dito na hora,
  // não descoberto depois.
  anunciar(r.guardado
    ? `${base} Jogue os lances.`
    : `${base} Atenção: ela não será mantida neste app, então só existe enquanto ele `
      + 'estiver aberto. Use Salvar novo PGN para baixar ou compartilhar.');
}

function revelarDigitacao() {
  $('area-entrada-lance').hidden = false;
  $('btn-digitar').setAttribute('aria-expanded', 'true');
  $('btn-digitar').textContent = 'Ocultar digitação';
}

function tagsParaTexto(tags) {
  return Object.entries(tags).map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n';
}

function dataHoje() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

// ---------------- Entrada de lance digitada ----------------

function processarEntradaLance() {
  const campo = $('entrada-lance');
  const valor = campo.value.trim();
  if (!valor) return;
  acordarAudio();
  // Comandos especiais (mesma família do relógio), antes do parser de lances:
  // uma letra sozinha nunca é um lance válido, então não há conflito.
  const comando = valor.toLowerCase();
  if (comando === '?') {
    anunciar('Comandos: p, resumo da posição. m, material capturado e vantagem. '
      + 'r, repete o lance atual. a ou back, apaga o lance atual. '
      + 'c e o lance certo, corrige o lance atual. '
      + 'Lances em notação inglesa: N cavalo, B bispo, '
      + 'R torre, Q dama, K rei; roque o-o ou o-o-o; Enter joga.');
    campo.value = '';
    return;
  }
  if (comando === 'p') { campo.value = ''; descreverPosicaoDialogo(); return; }
  if (comando === 'm') { campo.value = ''; leitura.material(); return; }
  if (comando === 'r') { campo.value = ''; leitura.repetir(); return; }
  if (comando === 'a' || comando === 'back' || comando === 'apagar') {
    campo.value = '';
    apagarLanceAtualUI();
    return;
  }
  // "c <lance>"/"corrigir <lance>": corrige o lance atual. Só a letra "c"
  // seguida de espaço vira comando — "c5", "cxd4" etc. continuam lances.
  if (comando === 'c' || comando === 'corrigir'
    || comando.startsWith('c ') || comando.startsWith('corrigir ')) {
    campo.value = '';
    corrigirLanceUI(valor.replace(/^(c|corrigir)\s*/i, '').trim());
    return;
  }
  const chess = new Chess(estadoFen());
  const r = interpretarEntrada(valor, chess);
  campo.value = '';
  if (r.tipo === 'lance') {
    leitura.jogarLance(r.san);
  } else if (r.tipo === 'promocao') {
    promoPendente = { baseSan: r.baseSan };
    $('dialogo-promocao').showModal();
  } else if (r.tipo === 'ambiguo') {
    abrirAmbiguo(r.opcoes);
  } else {
    anunciar(r.mensagem);
  }
}

function abrirAmbiguo(opcoes, aoEscolher = null) {
  const escolher = aoEscolher || ((san) => leitura.jogarLance(san));
  const cont = $('opcoes-ambiguo');
  cont.textContent = '';
  opcoes.forEach((op) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = op.descricao;
    b.addEventListener('click', () => {
      $('dialogo-ambiguo').close();
      escolher(op.san);
    });
    cont.appendChild(b);
  });
  $('dialogo-ambiguo').showModal();
  cont.querySelector('button')?.focus();
}

// ---------------- Apagar lance ----------------

// Apagar o último lance de uma linha é rápido (o caso do "back" do relógio);
// apagar um lance com continuação leva os seguintes junto e pede confirmação.
function apagarLanceAtualUI() {
  if (!leitura || leitura.ehRaiz) {
    anunciar('Nenhum lance para apagar aqui. Navegue até o lance que quer apagar.');
    return;
  }
  const seguintes = leitura.contarContinuacao();
  if (seguintes > 0) {
    const frase = seguintes === 1
      ? 'Apagar este lance e o lance seguinte?'
      : `Apagar este lance e os ${seguintes} lances seguintes?`;
    confirmar(frase, () => leitura.apagarLanceAtual());
  } else {
    leitura.apagarLanceAtual();
  }
}

// ---------------- Corrigir lance ----------------

// Interpreta a entrada com as mesmas tolerâncias dos lances, mas contra a
// posição ANTERIOR ao lance atual (é ela que valida a correção).
function corrigirLanceUI(entrada) {
  if (!leitura || leitura.ehRaiz) {
    anunciar('Nenhum lance para corrigir aqui. Navegue até o lance errado.');
    return;
  }
  if (!entrada) {
    anunciar('Para corrigir, digite c e o lance certo. Exemplo: c Nf3.');
    return;
  }
  const fenPai = leitura.atual.parent.fen || leitura.partida.fenInicial;
  const r = interpretarEntrada(entrada, new Chess(fenPai));
  if (r.tipo === 'lance') {
    aplicarCorrecao(r.san);
  } else if (r.tipo === 'promocao') {
    promoPendente = { baseSan: r.baseSan, corrigir: true };
    $('dialogo-promocao').showModal();
  } else if (r.tipo === 'ambiguo') {
    abrirAmbiguo(r.opcoes, (san) => aplicarCorrecao(san));
  } else {
    anunciar(r.mensagem);
  }
}

// Aplica a correção — pedindo confirmação primeiro quando ela remove lances
// (mesma regra do "Apagar lance": remoção de lances sempre confirma).
function aplicarCorrecao(san) {
  const aval = leitura.avaliarCorrecao(san); // anuncia os erros de validação
  if (!aval) return;
  if (aval.removidos > 0) {
    const nome = descreverLanceFalado(aval.mv);
    const frase = aval.removidos === 1
      ? `Corrigir para ${nome} remove 1 lance seguinte que fica ilegal. Corrigir mesmo assim?`
      : `Corrigir para ${nome} remove ${aval.removidos} lances seguintes que ficam ilegais. Corrigir mesmo assim?`;
    confirmar(frase, () => {
      const res = leitura.corrigirLance(san);
      if (!res.ok && res.mensagem) anunciar(res.mensagem);
    });
    return;
  }
  const res = leitura.corrigirLance(san);
  if (!res.ok && res.mensagem) anunciar(res.mensagem);
}

// ---------------- Colar FEN (posição avulsa) ----------------

// Aceita o FEN do jeito que ele chega do mundo real: espaços estranhos
// (inclusive o espaço fixo que alguns teclados de celular colam), quebras de
// linha, aspas em volta, rótulo "FEN:" na frente, a tag PGN inteira
// [FEN "..."] e as formas curtas de 4 ou 5 campos (sem os contadores).
// Devolve string vazia quando não sobra nada aproveitável.
function normalizarFen(texto) {
  // Os invisíveis somem em vez de virar espaço: um LRM no meio da posição
  // partiria o campo do tabuleiro em dois e o FEN deixaria de valer.
  let t = semInvisiveis(texto).replace(/\s+/g, ' ').trim();
  // Só a tag sozinha vira FEN: num PGN inteiro ela vem acompanhada de lances,
  // que não podem ser jogados fora.
  const tag = t.match(/^\[\s*FEN\s+"([^"]+)"\s*\]$/i);
  if (tag) t = tag[1];
  t = t.replace(/^fen\b\s*[:=]?\s*/i, '');
  t = t.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const campos = t.split(' ');
  // Formas curtas: completa os contadores que faltam, como fazem os sites.
  // Só quando o primeiro campo é mesmo um tabuleiro — assim um texto qualquer
  // de quatro palavras não vira "FEN" e não recebe um erro sem sentido.
  if (pareceTabuleiro(campos[0])) {
    if (campos.length === 4) campos.push('0', '1');
    else if (campos.length === 5) campos.push('1');
  }
  return campos.join(' ');
}

function pareceTabuleiro(campo) {
  return /^[pnbrqk1-8]+(\/[pnbrqk1-8]+){7}$/i.test(campo || '');
}

// Traduz o motivo da recusa do chess.js — a mensagem vai para o leitor de
// tela, então precisa fazer sentido em português.
const MOTIVOS_FEN = [
  [/six space-delimited fields/, 'faltam campos. Um FEN tem posição, vez de jogar, roques, en passant e os dois contadores'],
  [/move number/, 'o número do lance precisa ser um inteiro maior que zero'],
  [/half move/, 'o contador de lances sem captura precisa ser um número inteiro'],
  [/en-passant/, 'a casa de en passant não confere com a vez de jogar'],
  [/castling availability/, 'os roques só aceitam as letras K, Q, k, q ou um traço'],
  [/side-to-move/, 'falta dizer de quem é a vez: w para as brancas ou b para as pretas'],
  [/8 '\/'-delimited rows/, 'a posição precisa ter 8 fileiras separadas por barra'],
  [/consecutive number/, 'há dois números seguidos numa fileira'],
  [/invalid piece/, 'há uma letra de peça que não existe'],
  [/too many squares in rank/, 'alguma fileira não soma 8 casas'],
  [/missing white king/, 'falta o rei branco'],
  [/missing black king/, 'falta o rei preto'],
  [/too many white kings/, 'há mais de um rei branco'],
  [/too many black kings/, 'há mais de um rei preto'],
  [/pawns are on the edge rows/, 'há peão na primeira ou na oitava fileira'],
];

function motivoFenInvalido(erro, fen) {
  // Nem parece um FEN: dizer isso vale mais que traduzir o erro técnico.
  // (Com as 8 fileiras no lugar, o erro do chess.js é mais específico e útil.)
  if (fen && fen.split(' ')[0].split('/').length !== 8) {
    return 'isto não parece um FEN. Ele começa com as 8 fileiras separadas por barra';
  }
  for (const [padrao, texto] of MOTIVOS_FEN) {
    if (padrao.test(erro || '')) return texto;
  }
  return 'formato não reconhecido';
}

// Abre um FEN válido como posição avulsa (usado pelo Colar FEN e pelo botão
// de colar da área de transferência).
function abrirFenAvulso(fen) {
  const tags = {
    Event: '?', Site: '?', Date: dataHoje(), Round: '?',
    White: '?', Black: '?', Result: '*', SetUp: '1', FEN: fen,
  };
  const partida = montarPartida({ tagsText: tagsParaTexto(tags), bodyText: '*' });
  arquivoAtual = {
    guardadoId: null,
    original: gerarPgnCompleto(partida),
    partidas: [partida],
    rotulo: 'Posição avulsa',
  };
  const r = store.guardarPgn({
    original: arquivoAtual.original, atual: arquivoAtual.original,
    rotulo: 'Posição avulsa', jogadores: 'Posição', resultado: '*',
  });
  if (r.guardado) arquivoAtual.guardadoId = r.id;
  abrirPartida(0);
  anunciar('Posição carregada. Sem lances para navegar; explore ou jogue a partir daqui.');
}

function carregarFen() {
  const fen = normalizarFen($('campo-fen').value);
  const erro = $('erro-fen');
  if (!fen) {
    erro.textContent = 'Cole um FEN primeiro.';
    erro.hidden = false;
    anunciar('Cole um FEN primeiro.');
    return;
  }
  const v = validateFen(fen);
  if (!v.ok) {
    const motivo = motivoFenInvalido(v.error, fen);
    erro.textContent = `FEN inválido: ${motivo}.`;
    erro.hidden = false;
    anunciar('FEN inválido.');
    return;
  }
  erro.hidden = true;
  $('campo-fen').value = '';
  abrirFenAvulso(fen);
}

// ---------------- Colar da área de transferência ----------------

// Um botão só, que lê a área de transferência e decide sozinho: FEN válido
// abre como posição avulsa; senão, tenta como PGN. Onde a API não existe
// (navegador antigo, contexto inseguro), o botão fica escondido e a caixa
// "Colar PGN ou FEN" continua como rede de segurança universal.
function temLeituraDeClipboard() {
  return Boolean(navigator.clipboard && navigator.clipboard.readText);
}

// No Android, o Chrome pode abrir um diálogo nativo pedindo permissão para
// ler a área de transferência — e a promessa do readText fica pendurada até
// alguém responder. Quem usa leitor de tela nem sempre percebe esse diálogo:
// o botão simplesmente emudece, e o app parece travado. Daí o prazo: passado
// ele, a pessoa ouve o que fazer em vez de esperar no escuro. A leitura segue
// viva — se a permissão vier depois, o PGN ainda abre.
const PRAZO_CLIPBOARD = 6000;

function usarTextoColado(texto) {
  const limpo = (texto || '').trim();
  if (!limpo) {
    anunciar('A área de transferência está vazia. Copie um PGN ou um FEN primeiro.');
    return;
  }
  abrirTextoOuFen(limpo);
}

async function colarDaAreaDeTransferencia() {
  // Voltando do WhatsApp, a página pode ainda não ter o foco, e aí o Android
  // recusa a leitura. Dizer isso é mais útil que um "não consegui" genérico.
  if (!document.hasFocus()) {
    anunciar('Toque uma vez na tela do app e tente de novo, ou cole o texto na caixa Colar PGN ou FEN.');
    return;
  }

  let respondeu = false;
  const leitura = navigator.clipboard.readText().then(
    (texto) => { respondeu = true; return texto; },
    (erro) => { respondeu = true; throw erro; },
  );
  const prazo = new Promise((resolve) => setTimeout(resolve, PRAZO_CLIPBOARD));

  await Promise.race([leitura.catch(() => {}), prazo]);
  if (!respondeu) {
    anunciar('O navegador está pedindo permissão para ler a área de transferência. Procure o aviso na tela e confirme, ou cole o texto na caixa Colar PGN ou FEN.');
    // Se a permissão for concedida depois, o PGN abre sem novo toque.
    leitura.then(usarTextoColado, () => {});
    return;
  }

  try {
    usarTextoColado(await leitura);
  } catch {
    // Permissão negada ou leitura bloqueada: erro específico + fallback.
    anunciar('Não consegui ler a área de transferência. Cole o texto na caixa Colar PGN ou FEN.');
  }
}

// Decide sozinho entre FEN e PGN: o que sobra depois de normalizar valida
// como FEN, abre como posição avulsa. Um PGN inteiro nunca passa por aí —
// vira uma linha só, com campos demais. Devolve 'fen', 'pgn' ou null.
function abrirTextoOuFen(texto, nomeArquivo = null) {
  const fen = normalizarFen(texto);
  if (fen && validateFen(fen).ok) {
    abrirFenAvulso(fen);
    return 'fen';
  }
  // O erro específico já é anunciado lá dentro quando não é PGN.
  return abrirTextoPgn(texto, { nomeArquivo }) ? 'pgn' : null;
}

// "Livro de finais.pgn" vira "Livro de finais": a extensão é ruído numa lista
// falada, e todo item dela é um PGN de qualquer jeito.
function semExtensaoPgn(nome) {
  return String(nome).replace(/\.(pgn|txt)$/i, '').trim() || String(nome);
}

// ---------------- Colar na página (Control mais V) ----------------

// Quinta porta de entrada: com o arquivo .pgn copiado no gerenciador de
// arquivos, um Control mais V na tela inicial já abre — o navegador entrega o
// conteúdo junto com o evento, sem pedir permissão nem abrir seletor. Texto
// colado solto também vale. Só na tela inicial: no meio de uma leitura, um
// atalho desses trocaria a partida aberta sem querer.
async function aoColarNaPagina(evento) {
  if (!$('tela-inicial') || $('tela-inicial').hidden) return;
  const alvo = evento.target;
  // Dentro de uma caixa de texto o Control mais V é dela, não nosso.
  if (alvo && alvo.matches && alvo.matches('input, textarea, [contenteditable]')) return;
  const dados = evento.clipboardData;
  if (!dados) return;

  const arquivo = dados.files && dados.files[0];
  if (arquivo) {
    evento.preventDefault();
    if (arquivo.size > store.LIMITES.LIMITE_SO_LEITURA) {
      anunciar(`O arquivo ${arquivo.name} é grande demais para este app.`);
      return;
    }
    let texto = '';
    try {
      texto = await lerTextoArquivo(arquivo);
    } catch {
      anunciar(`Não consegui ler o arquivo ${arquivo.name}.`);
      return;
    }
    if (!abrirTextoOuFen(texto, arquivo.name)) {
      anunciar(`Não encontrei nenhuma partida válida em ${arquivo.name}.`);
    }
    return;
  }

  const texto = (dados.getData('text') || '').trim();
  if (!texto) return;
  evento.preventDefault();
  abrirTextoOuFen(texto);
}

// ---------------- PGNs guardados (tela inicial) ----------------

function renderGuardados() {
  const lista = store.lerGuardados()
    .sort((a, b) => b.ultimoAcesso - a.ultimoAcesso);
  const ol = $('lista-guardados');
  ol.textContent = '';
  $('guardados-vazio').hidden = lista.length > 0;
  $('btn-apagar-todos').hidden = lista.length === 0;
  for (const g of lista) {
    const nome = g.rotulo || g.jogadores || 'PGN guardado';
    const li = document.createElement('li');
    const abrir = document.createElement('button');
    abrir.type = 'button';
    abrir.className = 'guardado-abrir';
    // Com vinte arquivos na lista, saber qual deles não guarda as anotações
    // tem de vir do próprio rótulo — não de lembrar de um aviso falado.
    abrir.textContent = g.soLeitura ? `${nome} — só leitura` : nome;
    abrir.addEventListener('click', () => abrirGuardado(g.id));
    li.appendChild(abrir);

    // As ações de cada arquivo ficam atrás de um botão "Ações", como os
    // painéis do resto do app: com cinco botões soltos por arquivo, uma
    // lista de meia dúzia de PGNs virava uma parede para atravessar.
    const acoes = document.createElement('div');
    acoes.className = 'guardado-acoes';
    acoes.hidden = true;
    const arquivo = arquivoParaCompartilhar(g.atual || g.original, nomeArquivoPgn(nome));
    if (arquivo) {
      const comp = botao('Compartilhar', `Compartilhar: ${nome}`, async () => {
        try { await compartilharPgn(arquivo, nome); } catch (e) {
          if (e && e.name !== 'AbortError') anunciar('Não foi possível compartilhar. Use o botão Baixar.');
        }
      });
      acoes.appendChild(comp);
    }
    if (navigator.clipboard) {
      acoes.appendChild(botao('Copiar', `Copiar: ${nome}`, async () => {
        try {
          await navigator.clipboard.writeText(g.atual || g.original);
          anunciar('PGN copiado para a área de transferência.');
        } catch {
          anunciar('Não foi possível copiar. Use o botão Baixar.');
        }
      }));
    }
    acoes.appendChild(botao('Baixar', `Baixar: ${nome}`, () => {
      baixarPgn(g.atual || g.original, nomeArquivoPgn(nome));
    }));
    // Abrir um guardado cai na última partida lida, que é o que quase sempre
    // se quer. Quem quer outra precisa de um caminho direto para a lista sem
    // ter de abrir uma partida qualquer antes para depois sair dela.
    if (g.posicao && g.posicao.partidaIdx > 0) {
      acoes.appendChild(botao('Ver lista de partidas', `Ver lista de partidas: ${nome}`, () => {
        abrirGuardado(g.id, { naLista: true });
      }));
    }
    acoes.appendChild(botao('Apagar', `Apagar: ${nome}`, () => {
      // "do aparelho" assustava à toa: apagar aqui tira o PGN da lista deste
      // app, e o arquivo que a pessoa recebeu ou baixou continua onde estava.
      confirmar('Apagar este PGN da lista deste app?', () => {
        const posicao = [...ol.children].indexOf(li);
        store.apagarGuardado(g.id);
        renderGuardados();
        anunciar('PGN apagado.');
        focarAposApagarGuardado(posicao);
      });
    }));

    const menu = botao('Ações', `Ações: ${nome}`, () => alternarAcoesGuardado(menu, acoes));
    menu.className = 'guardado-menu';
    menu.setAttribute('aria-expanded', 'false');
    li.appendChild(menu);
    li.appendChild(acoes);
    ol.appendChild(li);
  }
}

// Um menu aberto por vez: dois abertos e a lista volta a ficar comprida,
// que é justamente o que o menu veio evitar.
function alternarAcoesGuardado(menu, acoes) {
  const abrir = acoes.hidden;
  for (const outro of $('lista-guardados').querySelectorAll('.guardado-acoes')) {
    if (outro === acoes) continue;
    outro.hidden = true;
    outro.parentElement.querySelector('.guardado-menu').setAttribute('aria-expanded', 'false');
  }
  acoes.hidden = !abrir;
  menu.setAttribute('aria-expanded', String(abrir));
}

// Apagar refaz a lista inteira, e o botão apertado deixa de existir: sem
// levar o foco, o leitor de tela fica sem lugar nenhum. Vai para o arquivo
// que assumiu a posição do apagado — ou para o título da seção, se acabaram.
function focarAposApagarGuardado(posicao) {
  const itens = $('lista-guardados').children;
  if (!itens.length) { $('titulo-guardados').focus(); return; }
  const i = Math.min(posicao, itens.length - 1);
  itens[i].querySelector('.guardado-abrir').focus();
}

function atualizarGuardadosSeVisivel() {
  if (!$('tela-inicial').hidden) renderGuardados();
}

function botao(texto, rotuloAcessivel, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = texto;
  if (rotuloAcessivel) b.setAttribute('aria-label', rotuloAcessivel);
  b.addEventListener('click', onClick);
  return b;
}

function abrirGuardado(id, { naLista = false } = {}) {
  const g = store.obterGuardado(id);
  if (!g) return;
  // Sem posição, a coleção abre na lista sozinha — é o caminho que o
  // "Ver lista de partidas" reaproveita para não cair na última partida lida.
  abrirTextoPgn(g.atual || g.original, {
    guardadoId: id,
    posicao: naLista ? null : g.posicao,
  });
}

// ---------------- Espaço do aparelho ----------------

// O tamanho é dito como o tamanho do ARQUIVO, um byte por caractere — que é
// o número que a pessoa conhece, o que o celular mostra no gerenciador de
// arquivos. Por dentro o navegador gasta o dobro (guarda tudo em UTF-16, dois
// bytes por caractere, medido: ASCII e acentuado batem no mesmo teto de
// caracteres), mas dizer que um livro de 1,6 MB "ocupa 3,2 MB" não ajuda
// ninguém a decidir nada — é contabilidade interna do navegador. O que
// interessa é quanto PGN cabe, e isso se mede em tamanho de PGN.
function emMegabytes(caracteres) {
  if (caracteres >= 1048576) {
    return `${(caracteres / 1048576).toFixed(1).replace('.', ',')} MB`;
  }
  if (caracteres >= 1024) return `${Math.round(caracteres / 1024)} KB`;
  return `${caracteres} bytes`;
}

function descrever(caracteres) {
  return emMegabytes(caracteres);
}

let textoDasMedidas = '';

// A medição escreve de verdade no armazenamento até o navegador recusar, e
// leva um instante num celular: por isso ela avisa antes e só então mede,
// para o anúncio não ficar preso atrás do trabalho.
function medirEspacoDialogo() {
  const cont = $('blocos-espaco');
  cont.textContent = '';
  const p = document.createElement('p');
  p.textContent = 'Medindo o espaço deste aparelho…';
  cont.appendChild(p);
  $('btn-copiar-espaco').hidden = true;
  $('dialogo-espaco').showModal();
  $('titulo-espaco').focus();
  anunciar('Medindo o espaço deste aparelho. Um instante.');
  setTimeout(() => {
    const guardados = store.lerGuardados();
    const usado = store.tamanhoTotal(guardados);
    const { livre, atingiuTeto } = store.medirEspacoLivre();
    const linhas = [
      guardados.length === 0
        ? 'Guardados: nenhum arquivo.'
        : `Guardados: ${guardados.length} ${guardados.length === 1 ? 'arquivo' : 'arquivos'}, somando ${descrever(usado)} de PGN.`,
      atingiuTeto
        ? `Ainda cabe: mais de ${descrever(livre)} de PGN. A medição parou de procurar aqui; neste aparelho o espaço não é problema.`
        : `Ainda cabe: ${descrever(livre)} de PGN.`,
      atingiuTeto
        ? 'Teto deste navegador: acima do que a medição foi buscar.'
        : `Teto estimado deste navegador: cerca de ${descrever(usado + livre)} de PGN no total.`,
      `Regra do app: PGN até ${emMegabytes(store.LIMITES.LIMITE_POR_ARQUIVO)} guarda também as suas alterações; acima disso, é guardado só para leitura.`,
    ];
    textoDasMedidas = linhas.join('\n');
    cont.textContent = '';
    for (const linha of linhas) {
      const item = document.createElement('p');
      item.textContent = linha;
      cont.appendChild(item);
    }
    $('btn-copiar-espaco').hidden = !navigator.clipboard;
    $('titulo-espaco').focus();
    anunciar(`Medição pronta. ${linhas[0]} ${linhas[1]}`);
  }, 120);
}

// ---------------- Continuar última leitura ----------------

function configurarContinuar() {
  const ultima = store.lerUltimaLeitura();
  const area = $('area-continuar');
  if (ultima && ultima.guardadoId && store.obterGuardado(ultima.guardadoId)) {
    area.hidden = false;
    const rotulo = ultima.rotulo || 'última partida';
    $('btn-continuar').textContent = `Continuar: ${rotulo}, lance ${ultima.lance || 0}`;
  } else {
    area.hidden = true;
  }
}

function continuarUltima() {
  const ultima = store.lerUltimaLeitura();
  if (!ultima) return;
  const g = store.obterGuardado(ultima.guardadoId);
  if (!g) { anunciar('A última leitura não está mais disponível.'); return; }
  abrirTextoPgn(g.atual || g.original, {
    guardadoId: g.id,
    posicao: { partidaIdx: ultima.partidaIdx || 0, indices: ultima.indices || [] },
  });
}

// ---------------- Restaurar original ----------------

function restaurarOriginal() {
  confirmar('Descartar suas alterações e voltar ao original?', () => {
    const texto = arquivoAtual.original;
    const idx = partidaIdx;
    const { partidas } = lerPgn(texto);
    arquivoAtual.partidas = partidas;
    arquivoAtual.modificado = false;
    if (arquivoAtual.guardadoId && !arquivoAtual.soLeitura) {
      store.atualizarGuardado(arquivoAtual.guardadoId, { atual: texto });
    }
    abrirPartida(Math.min(idx, partidas.length - 1));
    anunciar('Alterações descartadas. Voltou ao original.');
  });
}

// ---------------- Confirmação genérica ----------------

let confirmarCallback = null;

function confirmar(texto, callback) {
  $('confirmar-texto').textContent = texto;
  confirmarCallback = callback;
  $('dialogo-confirmar').showModal();
  $('btn-confirmar-nao').focus();
}

// ---------------- Painéis reveláveis ----------------

function fecharRevelaveis() {
  for (const [btn, area] of [
    ['btn-colar-fen', 'area-colar-fen'],
    ['btn-comentar', 'area-comentario'],
  ]) {
    $(area).hidden = true;
    $(btn).setAttribute('aria-expanded', 'false');
  }
}

function alternarRevelavel(btnId, areaId, aoAbrir) {
  const area = $(areaId);
  const abrir = area.hidden;
  fecharRevelaveis();
  area.hidden = !abrir;
  $(btnId).setAttribute('aria-expanded', String(abrir));
  if (abrir && aoAbrir) aoAbrir();
}

// ---------------- Navegação por teclado ----------------

function aoTeclaGlobal(e) {
  if ($('tela-leitura').hidden) return;
  // Já tratada por outro controle (setas do tabuleiro movendo o foco entre
  // casas, por exemplo): não navegar lances por cima.
  if (e.defaultPrevented) return;
  const alvo = e.target;
  // Não capturar quando digitando em campos de texto nem em seletores
  // (as setas do <select> trocam a opção, não o lance).
  if (alvo && alvo.matches && alvo.matches('input, textarea, select')) return;
  if (alvo && alvo.closest && alvo.closest('dialog')) return;
  switch (e.key) {
    case 'ArrowRight': case '.': e.preventDefault(); leitura.proximo(); break;
    case 'ArrowLeft': case ',': e.preventDefault(); leitura.anterior(); break;
    case 'Home': e.preventDefault(); leitura.inicio(); break;
    case 'End': e.preventDefault(); leitura.fim(); break;
    case 'ArrowUp':
      e.preventDefault();
      if (e.shiftKey) leitura.voltarPrincipal();
      else leitura.sairVariante();
      break;
    case 'ArrowDown': e.preventDefault(); leitura.variantesDoLance(); break;
    default: break;
  }
}

// ---------------- Ligações de eventos ----------------

function ligarEventos() {
  // Tela inicial
  $('btn-abrir-arquivo').addEventListener('click', () => $('arquivo-pgn').click());
  $('arquivo-pgn').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const texto = await lerTextoArquivo(file);
    const nomeArquivo = file.name;
    e.target.value = '';
    abrirTextoPgn(texto, { nomeArquivo });
  });
  $('btn-colar-transferencia').addEventListener('click', colarDaAreaDeTransferencia);
  document.addEventListener('paste', aoColarNaPagina);
  $('btn-colar-pgn').addEventListener('click', () => {
    const abrir = $('area-colar').hidden;
    $('area-colar').hidden = !abrir;
    $('btn-colar-pgn').setAttribute('aria-expanded', String(abrir));
    if (abrir) $('campo-colar').focus();
  });
  $('btn-carregar-colado').addEventListener('click', () => {
    const texto = $('campo-colar').value;
    if (!texto.trim()) { mostrarErroColar('Cole um PGN ou um FEN primeiro.'); return; }
    // A caixa aceita as duas coisas: quem só tem a posição cola o FEN aqui
    // mesmo, sem precisar abrir uma partida antes.
    const fen = normalizarFen(texto);
    if (fen && validateFen(fen).ok) {
      $('erro-colar').hidden = true;
      $('campo-colar').value = '';
      abrirFenAvulso(fen);
      return;
    }
    const ok = abrirTextoPgn(texto);
    if (!ok) {
      mostrarErroColar(fen && pareceTabuleiro(fen.split(' ')[0])
        ? `FEN inválido: ${motivoFenInvalido(validateFen(fen).error, fen)}.`
        : 'Não encontrei nenhum PGN nem FEN válido neste conteúdo.');
    } else $('campo-colar').value = '';
  });
  $('btn-criar-pgn').addEventListener('click', abrirCriar);
  $('btn-continuar').addEventListener('click', continuarUltima);
  $('chk-guardar').addEventListener('change', (e) => {
    prefs.guardarAutomatico = e.target.checked;
    store.gravarPreferencias({ guardarAutomatico: prefs.guardarAutomatico });
    // Desligar não apaga nada do que já está lá: quem apaga é a pessoa.
    anunciar(prefs.guardarAutomatico
      ? 'Os PGNs abertos voltam a ser mantidos neste app.'
      : 'Os PGNs abertos não serão mais mantidos neste app. Os que já estão guardados continuam aí.');
  });
  $('btn-espaco').addEventListener('click', medirEspacoDialogo);
  $('btn-fechar-espaco').addEventListener('click', () => $('dialogo-espaco').close());
  $('btn-copiar-espaco').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(textoDasMedidas);
      anunciar('Medidas copiadas para a área de transferência.');
    } catch {
      anunciar('Não foi possível copiar. As medidas estão na tela.');
    }
  });
  $('btn-apagar-todos').addEventListener('click', () => {
    confirmar('Apagar todos os PGNs da lista deste app?', () => {
      store.apagarTodosGuardados();
      renderGuardados();
      anunciar('Todos os PGNs guardados foram apagados.');
    });
  });

  // Lista de partidas
  $('btn-voltar-inicial').addEventListener('click', irParaInicio);
  $('btn-pagina-anterior').addEventListener('click', () => irParaPagina(paginaLista));
  $('btn-pagina-proxima').addEventListener('click', () => irParaPagina(paginaLista + 2));
  $('btn-ir-pagina').addEventListener('click', () => irParaPagina(numeroDoCampo('campo-pagina')));
  $('btn-ir-partida').addEventListener('click', () => irParaNumeroDePartida(numeroDoCampo('campo-partida')));
  // Enter no campo faz o que o botão ao lado faz: digitar o número e apertar
  // Enter é o gesto natural, e obrigar a achar o "Ir" seria um passo a mais.
  $('campo-pagina').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); irParaPagina(numeroDoCampo('campo-pagina')); }
  });
  $('campo-partida').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); irParaNumeroDePartida(numeroDoCampo('campo-partida')); }
  });

  // Navegação entre partidas do arquivo
  $('btn-partida-anterior').addEventListener('click', () => irParaPartidaVizinha(-1));
  $('btn-partida-proxima').addEventListener('click', () => irParaPartidaVizinha(1));

  // Navegação de lances
  $('btn-anterior').addEventListener('click', () => leitura.anterior());
  $('btn-proximo').addEventListener('click', () => { acordarAudio(); leitura.proximo(); });
  $('btn-tab-anterior').addEventListener('click', () => leitura.anterior());
  $('btn-tab-proximo').addEventListener('click', () => { acordarAudio(); leitura.proximo(); });
  $('btn-inicio').addEventListener('click', () => leitura.inicio());
  $('btn-final').addEventListener('click', () => leitura.fim());
  $('btn-sair-variante').addEventListener('click', () => leitura.sairVariante());
  $('btn-voltar-principal').addEventListener('click', () => leitura.voltarPrincipal());
  $('btn-variantes').addEventListener('click', () => leitura.variantesDoLance());

  // Detalhes / tabuleiro / lances / ações
  $('btn-detalhes').addEventListener('click', () => {
    const dl = $('detalhes-partida');
    const abrir = dl.hidden;
    dl.hidden = !abrir;
    $('btn-detalhes').setAttribute('aria-expanded', String(abrir));
  });
  $('btn-tabuleiro').addEventListener('click', () => {
    prefs.tabuleiro = !prefs.tabuleiro;
    store.gravarPreferencias({ tabuleiro: prefs.tabuleiro });
    aplicarPrefTabuleiro();
  });
  $('btn-digitar').addEventListener('click', () => {
    // Alterna a partir do estado visível (a criação pode ter revelado a
    // caixa sem mexer na preferência) e persiste a escolha.
    prefs.digitacao = $('area-entrada-lance').hidden;
    store.gravarPreferencias({ digitacao: prefs.digitacao });
    aplicarPrefDigitacao(true);
  });
  $('btn-ver-lances').addEventListener('click', () => {
    const area = $('area-lances');
    const abrir = area.hidden;
    area.hidden = !abrir;
    $('btn-ver-lances').setAttribute('aria-expanded', String(abrir));
    if (abrir) renderArvore();
  });
  $('btn-acoes').addEventListener('click', () => {
    const area = $('painel-acoes');
    const abrir = area.hidden;
    area.hidden = !abrir;
    $('btn-acoes').setAttribute('aria-expanded', String(abrir));
  });

  // Painel de ações
  $('btn-copiar-fen').addEventListener('click', copiarFen);
  $('btn-colar-fen').addEventListener('click', () => {
    alternarRevelavel('btn-colar-fen', 'area-colar-fen', () => $('campo-fen').focus());
  });
  $('btn-carregar-fen').addEventListener('click', carregarFen);
  $('btn-descrever').addEventListener('click', descreverPosicaoDialogo);
  $('btn-descrever-fixo').addEventListener('click', descreverPosicaoDialogo);
  $('btn-comentar').addEventListener('click', abrirComentario);
  $('btn-gravar-comentario').addEventListener('click', () => {
    leitura.adicionarComentario($('campo-comentario').value);
    $('area-comentario').hidden = true;
    $('btn-comentar').setAttribute('aria-expanded', 'false');
  });
  $('btn-apagar-lance').addEventListener('click', apagarLanceAtualUI);
  $('btn-editar-cabecalho').addEventListener('click', editarCabecalhoDialogo);
  $('btn-salvar-pgn').addEventListener('click', abrirSalvar);
  $('btn-restaurar').addEventListener('click', restaurarOriginal);
  const verLista = () => {
    mostrarListaPartidas(
      `Arquivo com ${arquivoAtual.partidas.length} partidas. Escolha uma da lista.`,
      { naPartidaAtual: true },
    );
  };
  // O mesmo comando em dois botões seria duplicação — mas "Trocar de partida"
  // vive no painel de ações, que vem recolhido, e voltar à lista não pode
  // custar abrir um painel. O do painel sai; fica o que está sempre à vista.
  $('btn-ver-lista').addEventListener('click', verLista);
  $('btn-outro-pgn').addEventListener('click', irParaInicio);
  $('btn-voltar-inicial-leitura').addEventListener('click', irParaInicio);

  $('chk-perguntar').addEventListener('change', (e) => {
    prefs.perguntarBifurcacoes = e.target.checked;
    store.gravarPreferencias({ perguntarBifurcacoes: prefs.perguntarBifurcacoes });
  });
  $('chk-som').addEventListener('change', (e) => {
    prefs.som = e.target.checked;
    definirSom(prefs.som);
    store.gravarPreferencias({ som: prefs.som });
  });
  $('sel-tema').addEventListener('change', (e) => {
    prefs.tema = e.target.value;
    store.gravarPreferencias({ tema: prefs.tema });
    const tema = aplicarTema(prefs.tema);
    anunciar(`Cores das casas: ${tema.nome}.`);
  });

  // Entrada de lance
  $('entrada-lance').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); processarEntradaLance(); }
  });

  // Diálogos: salvar
  $('btn-salvar-inteira').addEventListener('click', () => prepararSalvar('inteira'));
  $('btn-salvar-linha').addEventListener('click', () => prepararSalvar('linha'));
  $('btn-cancelar-salvar').addEventListener('click', () => $('dialogo-salvar').close());
  $('btn-fechar-salvar').addEventListener('click', () => $('dialogo-salvar').close());
  $('btn-baixar-salvo').addEventListener('click', () => {
    if (pgnParaSalvar) baixarPgn(pgnParaSalvar.texto, pgnParaSalvar.nome);
  });
  $('btn-compartilhar-salvo').addEventListener('click', async () => {
    if (!pgnParaSalvar) return;
    const arquivo = arquivoParaCompartilhar(pgnParaSalvar.texto, pgnParaSalvar.nome);
    if (!arquivo) return;
    try { await compartilharPgn(arquivo, arquivoAtual.rotulo); } catch (e) {
      if (e && e.name !== 'AbortError') anunciar('Não foi possível compartilhar. Use o botão Copiar PGN ou Baixar.');
    }
  });
  $('btn-copiar-salvo').addEventListener('click', async () => {
    if (!pgnParaSalvar) return;
    try {
      await navigator.clipboard.writeText(pgnParaSalvar.texto);
      anunciar('PGN copiado para a área de transferência.');
    } catch {
      anunciar('Não foi possível copiar. Use o botão Baixar.');
    }
  });

  // Diálogos: criar
  $('btn-criar-nova').addEventListener('click', () => { $('dialogo-criar').close(); criarPartida(null); });
  $('btn-criar-fen-abrir').addEventListener('click', () => {
    const area = $('area-criar-fen');
    const abrir = area.hidden;
    area.hidden = !abrir;
    $('btn-criar-fen-abrir').setAttribute('aria-expanded', String(abrir));
    if (abrir) $('campo-criar-fen').focus();
  });
  $('btn-criar-fen').addEventListener('click', () => {
    const fen = normalizarFen($('campo-criar-fen').value);
    const v = fen ? validateFen(fen) : { ok: false };
    if (!v.ok) {
      $('erro-criar-fen').textContent = fen
        ? `FEN inválido: ${motivoFenInvalido(v.error, fen)}.`
        : 'Cole um FEN primeiro.';
      $('erro-criar-fen').hidden = false;
      return;
    }
    $('campo-criar-fen').value = '';
    $('dialogo-criar').close();
    criarPartida(fen);
  });
  $('btn-cancelar-criar').addEventListener('click', () => $('dialogo-criar').close());

  // Diálogo: descrever
  $('btn-formato-descricao').addEventListener('click', alternarFormatoDescricao);
  $('btn-fechar-descrever').addEventListener('click', () => $('dialogo-descrever').close());

  // Diálogo: promoção
  for (const b of document.querySelectorAll('#dialogo-promocao [data-promocao]')) {
    b.addEventListener('click', () => {
      const peca = b.dataset.promocao;
      $('dialogo-promocao').close();
      resolverPromocaoPendente(peca);
    });
  }
  $('btn-cancelar-promocao').addEventListener('click', () => {
    $('dialogo-promocao').close();
    promoPendente = null;
    anunciar('Promoção cancelada.');
  });

  // Diálogo: ambíguo
  $('btn-cancelar-ambiguo').addEventListener('click', () => $('dialogo-ambiguo').close());

  // Diálogo: cabeçalho
  $('form-cabecalho').addEventListener('submit', (e) => {
    // method="dialog" fecha sozinho; gravamos os valores.
    leitura.editarCabecalho({
      White: $('tag-white').value,
      Black: $('tag-black').value,
      Event: $('tag-event').value,
      Site: $('tag-site').value,
      Date: $('tag-date').value,
      Round: $('tag-round').value,
    });
    void e;
  });
  $('btn-cancelar-cabecalho').addEventListener('click', () => $('dialogo-cabecalho').close());

  // Diálogo: confirmar
  $('btn-confirmar-sim').addEventListener('click', () => {
    $('dialogo-confirmar').close();
    if (confirmarCallback) confirmarCallback();
    confirmarCallback = null;
  });
  $('btn-confirmar-nao').addEventListener('click', () => $('dialogo-confirmar').close());

  // Teclado global
  document.addEventListener('keydown', aoTeclaGlobal);
}

function resolverPromocaoPendente(peca) {
  if (!promoPendente) return;
  if (promoPendente.baseSan) {
    // Correção usa a posição anterior ao lance atual; jogar usa a atual.
    const corrigir = promoPendente.corrigir;
    const fenBase = corrigir
      ? (leitura.atual.parent.fen || leitura.partida.fenInicial)
      : estadoFen();
    const lance = resolverPromocao(promoPendente.baseSan, peca, new Chess(fenBase));
    promoPendente = null;
    if (!lance) { anunciar('Promoção inválida.'); return; }
    if (corrigir) aplicarCorrecao(lance.san);
    else leitura.jogarLance(lance.san);
  } else {
    const { de, para } = promoPendente;
    promoPendente = null;
    jogarCoord(de, para, peca);
  }
}

function mostrarErroColar(msg) {
  $('erro-colar').textContent = msg;
  $('erro-colar').hidden = false;
  anunciar(msg);
}

function irParaInicio() {
  mostrarTela('tela-inicial');
  arquivoAtual = null;
  leitura = null;
  renderGuardados();
  configurarContinuar();
  // O botão apertado some junto com a tela: sem levar o foco para o primeiro
  // botão da tela inicial, o leitor de tela fica sem foco nenhum e parece que
  // o toque não fez nada.
  $('btn-abrir-arquivo').focus();
  anunciar('Tela inicial.');
}

// ---------------- PWA: share target, file handlers, service worker ----------------

async function verificarCompartilhamento() {
  const params = new URLSearchParams(location.search);
  if (!params.has('compartilhado')) return false;
  // O service worker recusou o arquivo (binário ou grande demais): avisa, em
  // vez de voltar à tela inicial em silêncio.
  if (params.get('compartilhado') === 'erro') {
    history.replaceState(null, '', './');
    anunciar('O arquivo compartilhado não é um texto PGN.');
    return false;
  }
  try {
    const resp = await fetch('./__shared_pgn');
    if (resp && resp.ok) {
      const nomeArquivo = decodeURIComponent(resp.headers.get('X-Nome-Arquivo') || '') || null;
      const texto = await resp.text();
      history.replaceState(null, '', './');
      if (texto.trim()) {
        abrirTextoPgn(texto, { nomeArquivo });
        return true;
      }
    }
  } catch { /* sem SW ou sem conteúdo */ }
  history.replaceState(null, '', './');
  return false;
}

function configurarFileHandler() {
  if ('launchQueue' in window && 'setConsumer' in window.launchQueue) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params || !params.files || !params.files.length) return;
      try {
        const blob = await params.files[0].getFile();
        const texto = await lerTextoArquivo(blob);
        abrirTextoPgn(texto, { nomeArquivo: blob.name || params.files[0].name });
      } catch { /* ignora */ }
    });
  }
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // updateViaCache: 'none' impede que o próprio sw.js venha do cache HTTP, e o
  // update() a cada abertura faz o app buscar uma versão nova assim que ela é
  // publicada, em vez de esperar a checagem automática do navegador
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((registro) => registro.update())
    .catch(() => { /* offline não disponível */ });
}

// Descarta o app guardado no aparelho (cache + service worker) e recarrega da
// rede. É a saída para quem ficou com uma cópia offline defeituosa ou sem
// cópia nenhuma.
async function reinstalarApp(apagarDados) {
  if (apagarDados) {
    try { localStorage.clear(); } catch { /* modo privado bloqueia */ }
  }
  try {
    if ('caches' in window) {
      const chaves = await caches.keys();
      // só os caches deste app (o relógio divide o mesmo endereço), e nunca o
      // do compartilhamento: pode haver um PGN recém-recebido esperando ali
      await Promise.all(chaves
        .filter((chave) => chave.startsWith('leitor-pgn-') && chave !== 'leitor-pgn-share')
        .map((chave) => caches.delete(chave)));
    }
  } catch { /* segue mesmo assim: o unregister abaixo já ajuda */ }
  try {
    const registros = await navigator.serviceWorker.getRegistrations();
    // idem: desregistra só o SW deste app, não o do relógio
    await Promise.all(registros
      .filter((registro) => location.href.startsWith(registro.scope))
      .map((registro) => registro.unregister()));
  } catch { /* idem */ }
  location.reload();
}

// Se a inicialização quebrar, a tela inicial fica de pé mas sem nenhum botão
// funcionando — o usuário fica tentando usar um app morto, sem entender. Este
// painel é montado inteiramente em JS, sem depender de elemento do index.html
// nem de classe do styles.css, porque são justamente esses arquivos que podem
// estar com problema.
function mostrarFalhaDeInicializacao(erro) {
  const painel = document.createElement('section');
  painel.setAttribute('role', 'alert');
  painel.style.cssText = 'max-width:40rem;margin:1rem auto;padding:1rem;line-height:1.5';

  const titulo = document.createElement('h2');
  titulo.textContent = 'O aplicativo não conseguiu abrir';
  titulo.tabIndex = -1;

  const texto = document.createElement('p');
  texto.textContent = 'Provavelmente a cópia guardada neste aparelho para uso '
    + 'offline está incompleta. Baixar o aplicativo de novo costuma resolver. '
    + 'Seus PGNs guardados serão mantidos.';

  const botao = document.createElement('button');
  botao.type = 'button';
  botao.textContent = 'Baixar o aplicativo de novo e recarregar';
  botao.style.cssText = 'font-size:1rem;padding:0.75rem 1rem;margin:0.5rem 0';
  botao.addEventListener('click', () => {
    botao.disabled = true;
    botao.textContent = 'Baixando…';
    reinstalarApp(false);
  });

  const apagar = document.createElement('button');
  apagar.type = 'button';
  apagar.textContent = 'Se não resolver: apagar também os dados salvos';
  apagar.style.cssText = 'font-size:0.9rem;padding:0.5rem;display:block;margin-top:0.5rem';
  apagar.addEventListener('click', () => {
    const certeza = confirm('Isso apaga os PGNs guardados e as preferências deste '
      + 'aparelho. Continuar?');
    if (certeza) reinstalarApp(true);
  });

  const detalhe = document.createElement('p');
  detalhe.style.cssText = 'font-size:0.85rem;opacity:0.8;margin-top:1rem';
  detalhe.textContent = `Detalhe técnico: ${(erro && erro.message) || erro}`;

  painel.append(titulo, texto, botao, apagar, detalhe);
  document.body.insertBefore(painel, document.body.firstChild);
  titulo.focus();
}

// ---------------- Inicialização ----------------

function aplicarPrefsIniciais() {
  definirSom(prefs.som);
  $('chk-som').checked = prefs.som;
  $('chk-perguntar').checked = prefs.perguntarBifurcacoes;
  $('chk-guardar').checked = prefs.guardarAutomatico;
  // Tema das casas (baixa visão): aplicado já na carga, antes do tabuleiro.
  prefs.tema = obterTema(prefs.tema).id; // id inválido cai no padrão
  if (prefs.formatoDescricao !== 'fen') prefs.formatoDescricao = 'pecas';
  aplicarTema(prefs.tema);
  preencherSelectDeTemas($('sel-tema'), prefs.tema);
  // Progressivo: o botão de colar direto só aparece onde a API existe.
  $('btn-colar-transferencia').hidden = !temLeituraDeClipboard();
  ajustarFiltroDeArquivo();
}

// iPhone e iPad: o seletor do app Arquivos entende o accept só por tipo MIME
// registrado no sistema, e .pgn não é um deles — as extensões da lista são
// ignoradas e sobra o text/plain, que deixa escolhíveis apenas os .txt (os
// .pgn aparecem apagados). Sem accept nenhum, tudo fica escolhível e o
// arquivo é validado depois, na leitura do texto, como já acontece com o
// compartilhamento. Nos outros sistemas o filtro é mantido, porque lá ele
// funciona e poupa o usuário de garimpar entre arquivos que não servem.
function ajustarFiltroDeArquivo() {
  const ehIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ehIOS) $('arquivo-pgn').removeAttribute('accept');
}

async function iniciar() {
  // registrado antes de tudo: mesmo que a inicialização quebre, o service
  // worker fica instalado e busca a correção na próxima abertura com internet
  registrarServiceWorker();

  iniciarAnunciador($('anunciador'));
  aplicarPrefsIniciais();
  ligarEventos();

  // O navegador só libera áudio depois de um gesto do usuário; o primeiro
  // toque/tecla também é a deixa para baixar e decodificar as amostras, bem
  // antes do primeiro lance.
  const prepararAudio = () => precarregarSons();
  document.addEventListener('pointerdown', prepararAudio, { once: true });
  document.addEventListener('keydown', prepararAudio, { once: true });

  configurarFileHandler();

  const veioDeCompartilhamento = await verificarCompartilhamento();
  if (!veioDeCompartilhamento) {
    mostrarTela('tela-inicial');
    renderGuardados();
    configurarContinuar();
  }

  // marca que a inicialização foi até o fim; a rede de segurança embutida no
  // index.html usa isso para saber que não precisa entrar em ação
  document.documentElement.dataset.appPronto = '1';
}

iniciar().catch(mostrarFalhaDeInicializacao);
