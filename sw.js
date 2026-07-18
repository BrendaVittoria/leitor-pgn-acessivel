// Service worker: cache do app shell (offline desde a segunda visita) + o
// handler do POST do share target (o ponto mais delicado do projeto).
// Estratégia de shell: stale-while-revalidate, como no relógio.

const CACHE = 'leitor-pgn-v3';
const CACHE_COMPARTILHADO = 'leitor-pgn-share';

const ARQUIVOS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/leitura.js',
  './js/pgnArvore.js',
  './js/pgnGerar.js',
  './js/tabuleiro.js',
  './js/parser.js',
  './js/fala.js',
  './js/anunciador.js',
  './js/armazenamento.js',
  './js/temas.js',
  './vendor/chess.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/pecas/wk.svg',
  './icons/pecas/wq.svg',
  './icons/pecas/wr.svg',
  './icons/pecas/wb.svg',
  './icons/pecas/wn.svg',
  './icons/pecas/wp.svg',
  './icons/pecas/bk.svg',
  './icons/pecas/bq.svg',
  './icons/pecas/br.svg',
  './icons/pecas/bb.svg',
  './icons/pecas/bn.svg',
  './icons/pecas/bp.svg',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ARQUIVOS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(
        chaves
          .filter((chave) => chave !== CACHE && chave !== CACHE_COMPARTILHADO)
          .map((chave) => caches.delete(chave)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const requisicao = evento.request;
  const url = new URL(requisicao.url);

  // 1. Share target: POST com o PGN compartilhado (arquivo ou texto).
  if (requisicao.method === 'POST' && url.pathname.endsWith('/share-target')) {
    evento.respondWith(tratarCompartilhamento(requisicao));
    return;
  }

  // 2. Entrega do PGN compartilhado guardado, pedido pela página ao carregar.
  if (requisicao.method === 'GET' && url.pathname.endsWith('/__shared_pgn')) {
    evento.respondWith(entregarCompartilhado());
    return;
  }

  if (requisicao.method !== 'GET' || !requisicao.url.startsWith(self.location.origin)) return;

  const chave = requisicao.mode === 'navigate' ? './index.html' : requisicao;
  const renovar = caches.open(CACHE).then(async (cache) => {
    try {
      const daRede = requisicao.mode === 'navigate'
        ? await fetch('./index.html', { cache: 'no-cache' })
        : await fetch(requisicao, { cache: 'no-cache' });
      if (daRede && daRede.ok) await cache.put(chave, daRede.clone());
      return daRede;
    } catch {
      return null;
    }
  });

  evento.respondWith(
    caches.match(chave).then((emCache) => emCache || renovar.then((r) => r || Response.error())),
  );
  evento.waitUntil(renovar);
});

// Recebe o POST do compartilhamento, extrai o PGN (arquivo ou texto puro),
// guarda num cache temporário e redireciona (303) para a página, que então
// busca o conteúdo em ./__shared_pgn.
async function tratarCompartilhamento(requisicao) {
  let texto = '';
  try {
    const form = await requisicao.formData();
    const arquivo = form.get('pgn');
    if (arquivo && typeof arquivo.text === 'function' && arquivo.size) {
      texto = await arquivo.text();
    } else {
      texto = form.get('text') || form.get('url') || '';
    }
  } catch {
    texto = '';
  }
  const cache = await caches.open(CACHE_COMPARTILHADO);
  await cache.put('./__shared_pgn', new Response(texto, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }));
  return Response.redirect('./?compartilhado=1', 303);
}

async function entregarCompartilhado() {
  const cache = await caches.open(CACHE_COMPARTILHADO);
  const resp = await cache.match('./__shared_pgn');
  if (resp) {
    // Consome uma vez: remove após entregar.
    await cache.delete('./__shared_pgn');
    return resp;
  }
  return new Response('', { headers: { 'Content-Type': 'text/plain' } });
}
