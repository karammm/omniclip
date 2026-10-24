// OmniClip service worker: offline app shell + Android share target inbox.
const SHELL = 'omniclip-shell-v1';
const INBOX = 'omniclip-share-inbox';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== INBOX).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function receiveShare(request) {
  const form = await request.formData();
  const inbox = await caches.open(INBOX);
  const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n').trim();
  const stamp = Date.now();
  if (text) await inbox.put(`/share-inbox/${stamp}-text`, new Response(text, { headers: { 'x-kind': 'text' } }));
  let i = 0;
  for (const file of form.getAll('file')) {
    if (!(file instanceof File) || file.size === 0) continue;
    await inbox.put(
      `/share-inbox/${stamp}-file-${i++}`,
      new Response(file, { headers: { 'x-kind': 'file', 'x-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' } }),
    );
  }
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (event.request.mode === 'navigate') {
    // network first so updates land immediately; fall back to the cached shell
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
