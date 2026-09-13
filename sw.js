const VERSION='dockflow-shell-v1';
const SHELL=['/','/index.html','/app.jsx','/manifest.webmanifest','/icons/icon.svg','/icons/icon-192.png','/icons/icon-512.png'];
const CDN_SHELL=[
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js'
];
const CDN_ORIGINS=new Set(CDN_SHELL.map(url=>new URL(url).origin));
self.addEventListener('install',event=>event.waitUntil(caches.open(VERSION).then(async cache=>{
  await cache.addAll(SHELL);
  // A CDN outage must not prevent a new service worker installing; successful
  // entries are retained and a later navigation can retry missing dependencies.
  await Promise.allSettled(CDN_SHELL.map(url=>cache.add(url)));
}).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request; const url=new URL(request.url);
  if(request.method!=='GET'||url.pathname.startsWith('/api/')||(url.origin!==self.location.origin&&!CDN_ORIGINS.has(url.origin)))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>{const copy=response.clone();caches.open(VERSION).then(cache=>cache.put('/index.html',copy));return response}).catch(()=>caches.match('/index.html')));return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(VERSION).then(cache=>cache.put(request,response.clone()));return response})));
});
