// Anunciador central: única região aria-live do app + sons de lance e desfecho.
// Copiado do relógio (mesma filosofia): centralizar evita anúncios
// duplicados/concorrentes, e a única região viva do app inteiro é esta.

let regiao = null;
let timeoutPendente = null;

export function iniciarAnunciador(elemento) {
  regiao = elemento;
}

export function anunciar(texto) {
  if (!regiao) return;
  // Limpa e regrava com um pequeno atraso para forçar o leitor de tela a
  // reler mesmo quando o texto é idêntico ao anterior.
  if (timeoutPendente) clearTimeout(timeoutPendente);
  regiao.textContent = '';
  timeoutPendente = setTimeout(() => {
    regiao.textContent = texto;
    timeoutPendente = null;
  }, 50);
}

// ---------------- Contexto de áudio ----------------

let audioCtx = null;
let somLigado = true;

export function definirSom(ligado) {
  somLigado = Boolean(ligado);
}

function obterContexto() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ---------------- Amostras (arquivos em sounds/) ----------------

// Mesmas amostras do relógio. Os arquivos são decodificados uma única vez e
// guardados como AudioBuffer: tocar vira só criar um source, sem latência de
// rede nem de decodificação no meio da leitura. O service worker guarda os
// mp3 no cache, então isso também funciona offline.
const AMOSTRAS = {
  move: './sounds/move.mp3',
  capture: './sounds/capture.mp3',
  checkmate: './sounds/checkmate.mp3',
  draw: './sounds/draw.mp3',
};

const buffers = new Map();
let carregamento = null;

/**
 * Baixa e decodifica as amostras. Chamar no primeiro gesto do usuário, quando
 * o AudioContext já pode existir. Falha em silêncio: sem amostra, o som de
 * lance cai no sintetizado e os de desfecho simplesmente não tocam.
 */
export function precarregarSons() {
  if (carregamento) return carregamento;
  const ctx = obterContexto();
  if (!ctx) return Promise.resolve();
  carregamento = Promise.all(
    Object.entries(AMOSTRAS).map(async ([nome, url]) => {
      try {
        const resposta = await fetch(url);
        if (!resposta.ok) return;
        buffers.set(nome, await ctx.decodeAudioData(await resposta.arrayBuffer()));
      } catch { /* segue sem esta amostra */ }
    }),
  );
  return carregamento;
}

// Toca uma amostra já decodificada. Retorna false se ela não estiver
// disponível, para quem chamou decidir se usa um som sintetizado no lugar.
function tocarAmostra(nome, volume = 1) {
  const buffer = buffers.get(nome);
  if (!buffer) return false;
  const ctx = obterContexto();
  if (!ctx) return false;
  const fonte = ctx.createBufferSource();
  const ganho = ctx.createGain();
  ganho.gain.value = volume;
  fonte.buffer = buffer;
  fonte.connect(ganho).connect(ctx.destination);
  fonte.start();
  return true;
}

// Sons de desfecho — sem equivalente sintetizado: se o arquivo não carregou,
// o desfecho continua anunciado por voz, apenas sem som.
export function somXequeMate() { if (somLigado) tocarAmostra('checkmate'); }
export function somEmpate() { if (somLigado) tocarAmostra('draw'); }

// ---------------- Sons sintetizados (reserva) ----------------

// "Toc" curto e grave, como peça de madeira pousando no tabuleiro: um
// triângulo com queda rápida de frequência soa percussivo, não musical.
function toc(ctx, inicio, frequencia, volume) {
  const osc = ctx.createOscillator();
  const ganho = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(frequencia, inicio);
  osc.frequency.exponentialRampToValueAtTime(frequencia * 0.45, inicio + 0.07);
  ganho.gain.setValueAtTime(0.0001, inicio);
  ganho.gain.exponentialRampToValueAtTime(volume, inicio + 0.005);
  ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.09);
  osc.connect(ganho).connect(ctx.destination);
  osc.start(inicio);
  osc.stop(inicio + 0.12);
}

// Som de lance: as amostras de move/capture são bem mais distinguíveis que os
// tocs sintetizados. Se o arquivo não estiver disponível (primeiro lance antes
// do pré-carregamento terminar, ou falha na rede), cai no sintetizado: um toc
// para movimento e um segundo toc mais agudo para captura. Precisa ser agudo:
// alto-falante de celular não reproduz graves.
export function somLance(captura = false) {
  if (!somLigado) return;
  if (tocarAmostra(captura ? 'capture' : 'move')) return;
  const ctx = obterContexto();
  if (!ctx) return;
  const agora = ctx.currentTime;
  toc(ctx, agora, 340, 0.35);
  if (captura) toc(ctx, agora + 0.1, 620, 0.4);
}

// Desperta o contexto de áudio a partir de um gesto do usuário (necessário
// para o primeiro som funcionar em celulares).
export function acordarAudio() {
  obterContexto();
}
