// Anunciador central: única região aria-live do app + sons "toc" de madeira.
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

// ---------------- Sons (Web Audio) ----------------

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

// Som de lance: um toc para movimento; captura ganha um segundo toc mais
// agudo. Precisa ser agudo: alto-falante de celular não reproduz graves.
export function somLance(captura = false) {
  if (!somLigado) return;
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
