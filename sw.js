/* Service worker auto-destructeur.
   Les versions precedentes servaient l'ancienne page depuis le cache :
   Ctrl+Maj+R n'y changeait rien, le SW repondait avant le reseau.
   Celui-ci se desinscrit et vide tout. Les navigateurs verifient le SW
   a chaque navigation, il suffit donc d'ouvrir l'appli une fois. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.map(n => caches.delete(n)));
    await self.registration.unregister();
    const cl = await self.clients.matchAll({ type: 'window' });
    cl.forEach(c => c.navigate(c.url));
  })());
});
