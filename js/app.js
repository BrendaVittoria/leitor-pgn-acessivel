// Orquestração do Leitor de PGN: telas, diálogos, ações e integração PWA
// (share target, file handlers, service worker). Sem framework, sem build.

import { Chess, DEFAULT_POSITION, validateFen } from '../vendor/chess.js';
import { iniciarAnunciador, anunciar, definirSom, acordarAudio } from './anunciador.js';
import {
  resultadoFalado, descreverPosicaoBlocos, nomeCasa, descreverLanceFalado,
} from './fala.js';
import { interpretarEntrada, resolverPromocao } from './parser.js';
import {
  lerPgn, montarPartida, caminhoPorIndices,
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
let avisouArquivoGrande = false;

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

function abrirTextoPgn(texto, { guardadoId = null, posicao = null } = {}) {
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

  const rotulo = descreverPartida(partidas[0].tags, partidas[0].resultado);
  arquivoAtual = {
    guardadoId,
    original: texto,
    partidas,
    rotulo,
  };

  // Guarda (ou renova) o arquivo, salvo se for grande demais.
  if (!guardadoId) {
    const r = store.guardarPgn({
      original: texto,
      atual: texto,
      rotulo,
      jogadores: `${nomeJogador(partidas[0].tags.White) || 'Brancas'} x ${nomeJogador(partidas[0].tags.Black) || 'Pretas'}`,
      resultado: partidas[0].resultado,
    });
    if (r.guardado) {
      arquivoAtual.guardadoId = r.id;
    } else if (r.motivo === 'grande' && !avisouArquivoGrande) {
      avisouArquivoGrande = true;
      setTimeout(() => anunciar('Arquivo grande; não ficará guardado. Para reler, abra o arquivo de novo.'), 1200);
    }
  } else {
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
// em lotes para a lista nunca travar o app (seção 8 da especificação).
const LOTE_LISTA = 50;
let listaLimite = 0;

function mostrarListaPartidas(mensagem) {
  mostrarTela('tela-lista');
  $('lista-descricao').textContent = mensagem;
  $('lista-partidas').textContent = '';
  listaLimite = 0;
  acrescentarLotePartidas();
  anunciar(mensagem);
}

function acrescentarLotePartidas() {
  const ol = $('lista-partidas');
  const total = arquivoAtual.partidas.length;
  const fim = Math.min(listaLimite + LOTE_LISTA, total);
  for (let i = listaLimite; i < fim; i++) {
    const p = arquivoAtual.partidas[i];
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = descreverPartida(p.tags, p.resultado);
    b.addEventListener('click', () => abrirPartida(i));
    li.appendChild(b);
    ol.appendChild(li);
  }
  listaLimite = fim;
  const btnMais = $('btn-mais-partidas');
  btnMais.hidden = listaLimite >= total;
  if (!btnMais.hidden) {
    btnMais.textContent = `Mostrar mais ${Math.min(LOTE_LISTA, total - listaLimite)} partidas`;
  }
}

function abrirPartida(idx, { indices = null } = {}) {
  partidaIdx = idx;
  const partida = arquivoAtual.partidas[idx];
  leitura = new Leitura(partida, {
    perguntarBifurcacoes: () => prefs.perguntarBifurcacoes,
    aoMudar: () => { render(); persistirPosicao(); },
    aoAlterar: persistir,
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
  if (!partida.temLances) {
    anunciar(`Partida carregada. ${nomes}. Partida sem lances registrados.`);
  } else if (leitura.caminho.length > 1) {
    anunciar(`Partida carregada. ${nomes}. Retomada no lance ${leitura.caminho.length - 1}.`);
  } else {
    anunciar(`Partida carregada. ${nomes}.`);
  }
  persistir();
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
  $('btn-trocar-partida').hidden = arquivoAtual.partidas.length < 2;

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
  if (raiz.comment) {
    const c = document.createElement('p');
    c.className = 'comentario';
    c.textContent = `{${raiz.comment}}`;
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
    if (no.comment) {
      const c = document.createElement('span');
      c.className = 'comentario';
      c.textContent = ` {${no.comment}} `;
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

function aplicarPrefTabuleiro() {
  const mostrar = prefs.tabuleiro;
  $('area-tabuleiro').hidden = !mostrar;
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

function textoAtualArquivo() {
  return arquivoAtual.partidas.map((p) => gerarPgnCompleto(p)).join('\n\n');
}

function arquivoFoiModificado() {
  if (!arquivoAtual) return false;
  return textoAtualArquivo().trim() !== arquivoAtual.original.trim();
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
// na cópia guardada, além da posição.
function persistir() {
  if (!arquivoAtual || !leitura) return;
  if (arquivoAtual.guardadoId) {
    store.atualizarGuardado(arquivoAtual.guardadoId, { atual: textoAtualArquivo() });
  }
  persistirPosicao();
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
  const chess = new Chess(estadoFen());
  const blocos = descreverPosicaoBlocos(chess);
  const cont = $('blocos-descricao');
  cont.textContent = '';
  for (const bloco of blocos) {
    const p = document.createElement('p');
    p.textContent = bloco;
    cont.appendChild(p);
  }
  $('dialogo-descrever').showModal();
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
  const lista = store.lerGuardados().sort((a, b) => b.ultimoAcesso - a.ultimoAcesso);
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
    $('btn-trocar-partida').hidden = arquivoAtual.partidas.length < 2;
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
    // Guarda como novo arquivo entre os guardados.
    store.guardarPgn({
      original: texto,
      atual: texto,
      rotulo: `${arquivoAtual.rotulo} (salvo)`,
      jogadores: arquivoAtual.rotulo,
      resultado: partida.resultado,
    });
  }
  $('dialogo-salvar').querySelector('.opcoes-coluna').hidden = true;
  $('area-salvar-pronto').hidden = false;
  $('salvar-pronto-texto').textContent = mensagem;
  // Compartilhar só aparece se o navegador aceita algum dos formatos (.pgn ou .txt)
  $('btn-compartilhar-salvo').hidden = arquivoParaCompartilhar(texto, pgnParaSalvar.nome) === null;
  $('btn-copiar-salvo').hidden = !navigator.clipboard;
  anunciar(destino ? 'Partida adicionada.' : 'PGN salvo.');
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
  anunciar(fen ? 'Partida criada a partir do FEN. Jogue os lances.' : 'Partida nova. Jogue os lances.');
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
  const fen = $('campo-fen').value.trim();
  const erro = $('erro-fen');
  const v = validateFen(fen);
  if (!v.ok) {
    erro.textContent = `FEN inválido: ${v.error || 'formato não reconhecido'}.`;
    erro.hidden = false;
    anunciar('FEN inválido.');
    return;
  }
  erro.hidden = true;
  abrirFenAvulso(fen);
}

// ---------------- Colar da área de transferência ----------------

// Um botão só, que lê a área de transferência e decide sozinho: FEN válido
// abre como posição avulsa; senão, tenta como PGN. Onde a API não existe
// (navegador antigo, contexto inseguro), o botão fica escondido e a caixa
// "Colar PGN" continua como rede de segurança universal.
function temLeituraDeClipboard() {
  return Boolean(navigator.clipboard && navigator.clipboard.readText);
}

async function colarDaAreaDeTransferencia() {
  let texto = '';
  try {
    texto = await navigator.clipboard.readText();
  } catch {
    // Permissão negada ou leitura bloqueada: erro específico + fallback.
    anunciar('Não consegui ler a área de transferência. Cole o texto na caixa Colar PGN.');
    return;
  }
  texto = (texto || '').trim();
  if (!texto) {
    anunciar('A área de transferência está vazia. Copie um PGN ou um FEN primeiro.');
    return;
  }
  // FEN: texto de uma linha só que valida como FEN.
  if (!texto.includes('\n') && validateFen(texto).ok) {
    abrirFenAvulso(texto);
    return;
  }
  abrirTextoPgn(texto); // erro específico já é anunciado quando não é PGN
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
    const li = document.createElement('li');
    const abrir = document.createElement('button');
    abrir.type = 'button';
    abrir.className = 'guardado-abrir';
    abrir.textContent = g.rotulo || g.jogadores || 'PGN guardado';
    abrir.addEventListener('click', () => abrirGuardado(g.id));
    li.appendChild(abrir);

    const acoes = document.createElement('div');
    acoes.className = 'guardado-acoes';
    const arquivo = arquivoParaCompartilhar(g.atual || g.original, nomeArquivoPgn(g.rotulo));
    if (arquivo) {
      const comp = botao('Compartilhar', `Compartilhar: ${g.rotulo}`, async () => {
        try { await compartilharPgn(arquivo, g.rotulo); } catch (e) {
          if (e && e.name !== 'AbortError') anunciar('Não foi possível compartilhar. Use o botão Baixar.');
        }
      });
      acoes.appendChild(comp);
    }
    if (navigator.clipboard) {
      acoes.appendChild(botao('Copiar', `Copiar: ${g.rotulo}`, async () => {
        try {
          await navigator.clipboard.writeText(g.atual || g.original);
          anunciar('PGN copiado para a área de transferência.');
        } catch {
          anunciar('Não foi possível copiar. Use o botão Baixar.');
        }
      }));
    }
    acoes.appendChild(botao('Baixar', `Baixar: ${g.rotulo}`, () => {
      baixarPgn(g.atual || g.original, nomeArquivoPgn(g.rotulo));
    }));
    acoes.appendChild(botao('Apagar', `Apagar: ${g.rotulo}`, () => {
      confirmar('Apagar este PGN do aparelho?', () => {
        store.apagarGuardado(g.id);
        renderGuardados();
        anunciar('PGN apagado.');
      });
    }));
    li.appendChild(acoes);
    ol.appendChild(li);
  }
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

function abrirGuardado(id) {
  const g = store.obterGuardado(id);
  if (!g) return;
  abrirTextoPgn(g.atual || g.original, { guardadoId: id, posicao: g.posicao });
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
    if (arquivoAtual.guardadoId) {
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
    e.target.value = '';
    abrirTextoPgn(texto);
  });
  $('btn-colar-transferencia').addEventListener('click', colarDaAreaDeTransferencia);
  $('btn-colar-pgn').addEventListener('click', () => {
    const abrir = $('area-colar').hidden;
    $('area-colar').hidden = !abrir;
    $('btn-colar-pgn').setAttribute('aria-expanded', String(abrir));
    if (abrir) $('campo-colar').focus();
  });
  $('btn-carregar-colado').addEventListener('click', () => {
    const texto = $('campo-colar').value;
    if (!texto.trim()) { mostrarErroColar('Cole um texto PGN primeiro.'); return; }
    const ok = abrirTextoPgn(texto);
    if (!ok) mostrarErroColar('Não encontrei nenhuma partida válida neste conteúdo.');
    else $('campo-colar').value = '';
  });
  $('btn-criar-pgn').addEventListener('click', abrirCriar);
  $('btn-continuar').addEventListener('click', continuarUltima);
  $('btn-apagar-todos').addEventListener('click', () => {
    confirmar('Apagar todos os PGNs guardados do aparelho?', () => {
      store.apagarTodosGuardados();
      renderGuardados();
      anunciar('Todos os PGNs guardados foram apagados.');
    });
  });

  // Lista de partidas
  $('btn-voltar-inicial').addEventListener('click', irParaInicio);
  $('btn-mais-partidas').addEventListener('click', () => {
    acrescentarLotePartidas();
    anunciar(`Mostrando ${listaLimite} de ${arquivoAtual.partidas.length} partidas.`);
  });

  // Navegação de lances
  $('btn-anterior').addEventListener('click', () => leitura.anterior());
  $('btn-proximo').addEventListener('click', () => { acordarAudio(); leitura.proximo(); });
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
  $('btn-trocar-partida').addEventListener('click', () => {
    mostrarListaPartidas(`Arquivo com ${arquivoAtual.partidas.length} partidas. Escolha uma da lista.`);
  });
  $('btn-outro-pgn').addEventListener('click', irParaInicio);

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
    const fen = $('campo-criar-fen').value.trim();
    const v = validateFen(fen);
    if (!v.ok) {
      $('erro-criar-fen').textContent = `FEN inválido: ${v.error || 'formato não reconhecido'}.`;
      $('erro-criar-fen').hidden = false;
      return;
    }
    $('dialogo-criar').close();
    criarPartida(fen);
  });
  $('btn-cancelar-criar').addEventListener('click', () => $('dialogo-criar').close());

  // Diálogo: descrever
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
}

// ---------------- PWA: share target, file handlers, service worker ----------------

async function verificarCompartilhamento() {
  const params = new URLSearchParams(location.search);
  if (!params.has('compartilhado')) return false;
  try {
    const resp = await fetch('./__shared_pgn');
    if (resp && resp.ok) {
      const texto = await resp.text();
      history.replaceState(null, '', './');
      if (texto.trim()) {
        abrirTextoPgn(texto);
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
        abrirTextoPgn(texto);
      } catch { /* ignora */ }
    });
  }
}

function registrarServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline não disponível */ });
  }
}

// ---------------- Inicialização ----------------

function aplicarPrefsIniciais() {
  definirSom(prefs.som);
  $('chk-som').checked = prefs.som;
  $('chk-perguntar').checked = prefs.perguntarBifurcacoes;
  // Tema das casas (baixa visão): aplicado já na carga, antes do tabuleiro.
  prefs.tema = obterTema(prefs.tema).id; // id inválido cai no padrão
  aplicarTema(prefs.tema);
  preencherSelectDeTemas($('sel-tema'), prefs.tema);
  // Progressivo: o botão de colar direto só aparece onde a API existe.
  $('btn-colar-transferencia').hidden = !temLeituraDeClipboard();
}

async function iniciar() {
  iniciarAnunciador($('anunciador'));
  aplicarPrefsIniciais();
  ligarEventos();
  registrarServiceWorker();
  configurarFileHandler();

  const veioDeCompartilhamento = await verificarCompartilhamento();
  if (!veioDeCompartilhamento) {
    mostrarTela('tela-inicial');
    renderGuardados();
    configurarContinuar();
  }
}

iniciar();
