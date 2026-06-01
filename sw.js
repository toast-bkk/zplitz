/**
 * Zplitz Service Worker
 * - Cache static assets (HTML, manifest, icons)
 * - Cache CDN assets (Tailwind, Lucide, Chart.js, Fonts)
 * - Network-only for Apps Script API calls (offline behavior handled in app code)
 *
 * Update CACHE_VERSION เมื่อ deploy ใหม่ที่มีการเปลี่ยนแปลง — browser จะ download ใหม่หมด
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = 'zplitz-' + CACHE_VERSION;

// ไฟล์ที่จะ cache ไว้ตอน install (ครั้งแรกที่เปิดเว็บ)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json'
];

// Install event — pre-cache app shell
// หมายเหตุ: ไม่เรียก skipWaiting() ที่นี่ เพื่อให้ SW ใหม่รอในสถานะ "waiting"
//          แอปจะตรวจเจอแล้วแจ้งเตือนผู้ใช้ ให้กดอัปเดตเอง (ส่ง SKIP_WAITING มา)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
  );
});

// รับคำสั่งจากแอป
self.addEventListener('message', (event) => {
  if (!event.data) return;
  // ผู้ใช้กด "อัปเดตเลย" → activate SW ใหม่ทันที
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // แอปถามเวอร์ชันที่ทำงานอยู่จริง → ตอบกลับทาง port ที่ส่งมา
  if (event.data.type === 'GET_VERSION') {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ version: CACHE_VERSION });
  }
});

// Activate event — ลบ cache เก่า
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => (k.startsWith('zplitz-') || k.startsWith('triptally-')) && k !== CACHE_NAME)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // ควบคุม pages ที่เปิดอยู่ทันที
  );
});

// Fetch event — strategy ต่างกันตาม URL
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Apps Script API calls — network only, ไม่ cache
  //    (ข้อมูลต้องสด, app code มี localStorage cache ของตัวเองอยู่แล้ว)
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('script.googleusercontent.com')) {
    return; // ปล่อยให้ browser handle ตามปกติ
  }

  // 2. POST requests — network only (เช่นไม่น่าจะ cache POST อยู่แล้ว แต่ guard ไว้)
  if (event.request.method !== 'GET') return;

  // 3. Same-origin (index.html, sw.js, manifest, icons) → cache-first
  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // 4. CDN assets (Tailwind, Lucide, Chart.js, Google Fonts) → stale-while-revalidate
  //    ใช้ของใน cache ก่อน + fetch ใหม่ background → user รู้สึกเร็ว แต่ไม่ค้างเวอร์ชันเก่านาน
  if (url.hostname.includes('cdn.tailwindcss.com') ||
      url.hostname.includes('unpkg.com') ||
      url.hostname.includes('cdn.jsdelivr.net') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // 5. อื่นๆ — network first, fallback cache
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ===== Strategies =====
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    // เก็บ cache ถ้า response ok
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // offline + ไม่มี cache → fallback to index.html (SPA pattern)
    const indexFallback = await caches.match('./index.html');
    if (indexFallback) return indexFallback;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || fetchPromise;
}
