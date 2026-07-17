// Temas de cores do tabuleiro — pensados para baixa visão: opções de alto
// contraste selecionáveis, aplicadas via variáveis CSS e salvas no aparelho.

export const TEMAS_TABULEIRO = [
  {
    id: 'padrao',
    nome: 'Padrão (cinza-azulado)',
    clara: '#b9c4ce',
    escura: '#5a6b7c',
    selecao: '#ffd75e',
    haloPecas: false,
  },
  {
    id: 'amarelo-preto',
    nome: 'Alto contraste: amarelo e preto',
    clara: '#ffdf33',
    escura: '#000000',
    selecao: '#ff2d2d',
    haloPecas: true, // peças pretas ganham contorno claro para não sumir no preto
  },
  {
    id: 'branco-preto',
    nome: 'Alto contraste: branco e preto',
    clara: '#ffffff',
    escura: '#000000',
    selecao: '#ff8c00',
    haloPecas: true,
  },
  {
    id: 'verde',
    nome: 'Verde clássico',
    clara: '#ebecd0',
    escura: '#779556',
    selecao: '#ffd75e',
    haloPecas: false,
  },
];

export function obterTema(id) {
  return TEMAS_TABULEIRO.find((t) => t.id === id) || TEMAS_TABULEIRO[0];
}

export function aplicarTema(id) {
  const tema = obterTema(id);
  const raiz = document.documentElement.style;
  raiz.setProperty('--casa-clara', tema.clara);
  raiz.setProperty('--casa-escura', tema.escura);
  raiz.setProperty('--cor-selecao', tema.selecao);
  raiz.setProperty(
    '--halo-peca',
    tema.haloPecas
      ? 'drop-shadow(0 0 1px #fff) drop-shadow(0 0 2px rgba(255,255,255,0.8))'
      : 'none',
  );
  return tema;
}

export function preencherSelectDeTemas(select, idAtual) {
  select.textContent = '';
  for (const tema of TEMAS_TABULEIRO) {
    const opcao = document.createElement('option');
    opcao.value = tema.id;
    opcao.textContent = tema.nome;
    if (tema.id === idAtual) opcao.selected = true;
    select.appendChild(opcao);
  }
}
