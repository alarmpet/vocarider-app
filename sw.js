/* VocaRider 서비스워커 — 생성물: tools/make-sw.mjs 가 이 템플릿의 자리표시(BUILD·SHELL)를 채워 dist/sw.js 로 쓴다. 직접 고치지 말고 이 파일을 고친다.
 *
 * 목적(D-155): 재방문 속도와 불안정한 네트워크(지하철) 대비. 전 파일 max-age=600 이라 10분 뒤엔 전부 재확인하고 오프라인 보호가 없었다.
 * 안전 원칙 — 이 파일이 망가지면 재방문자가 영영 깨진 앱을 볼 수 있다(교차 검토 luna·grok·agy 전 · sol·terra 지적 반영):
 *  · 이동(navigate)은 **네트워크 우선**(4초 제한·시간 초과 시 요청 중단) — 새 버전이 항상 도착한다.
 *    오프라인 대체 HTML 은 **설치 때 저장한 그 릴리스의 index.html 하나뿐**이다 — 네트워크에서 받은 새 HTML 을 덮어쓰지 않는다(덮어쓰면 옛 캐시에 새 번들 이름을 가리키는 HTML 이 생겨 오프라인에서 깨진다).
 *  · 설치는 **꼭 필요한 셸(index·JS·CSS)만** 저장한다. 해시 파일은 HTTP 캐시를 쓴다(방금 받은 것을 다시 받지 않는다 — 첫 판과 대역폭을 다투지 않는다). index.html 만 cache:reload.
 *  · 해시 파일명(bundle/*)은 캐시 우선(불변). assets/ 는 릴리스(BUILD)마다 따로 만든 캐시에 실행 중 저장 — 허용 쿼리(없음 또는 ?v=)·크기(4MB) 예산 안의 것만.
 *  · 미디어(오디오·비디오) 요소·Range 요청은 **손대지 않는다**(캐시가 전체 200 으로 답하면 미디어 범위 요청이 깨진다). 교차 출처·비 GET·sw.js·provenance.json 도 손대지 않는다.
 *  · 자동 강제 갱신(skipWaiting)·탭 가로채기(clients.claim) 없음. 새 앱 코드는 네트워크 HTML 로 도착하므로 새 서비스워커가 대기 중이어도 앱은 최신이다. 메시지 'skip-waiting' 으로만 수동 전환.
 *  · 저장·트림은 event.waitUntil 에 묶는다(워커가 응답 직후 종료돼도 끝까지).
 *  · 긴급 해제: `node tools/make-sw.mjs --kill` 이 만드는 sw.js(tombstone)를 배포하면 캐시를 지우고 **아무것도 가로채지 않는다**(등록 해제+재탐색은 재등록 루프를 만들어 쓰지 않는다). docs/runbooks/service-worker.md */
const BUILD = 'cf4072ee9e86';
const SHELL_FILES = ["index.html","bundle/index-BicruyvY.css","bundle/index-C9IaIwon.js","bundle/three-P4n13O-o.js"];   // 설치 때 저장할 것(스코프 기준 상대 경로 · index.html · ./ · 핵심 번들)
const SHELL = 'vr-shell-' + BUILD;
const RUNTIME = 'vr-run-' + BUILD;
const RUNTIME_MAX = 400;
const SHELL_MAX = 60;   // 셸 캐시(설치 5개 + 쓴 번들 이미지)도 상한을 둔다
const RUNTIME_MAX_BYTES = 4 * 1024 * 1024;
const NAV_TIMEOUT_MS = 4000;

const scopeUrl = (p) => new URL(p, self.registration.scope).href;

/** 요청을 어떻게 다룰지 — 순수 함수(테스트 가능). 'pass' = 손대지 않는다 */
function routeOf(req, origin, scope) {
  if (!req || req.method !== 'GET') return 'pass';
  let url; try { url = new URL(req.url); } catch (e) { return 'pass'; }
  if (url.origin !== origin) return 'pass';
  if (req.headers && typeof req.headers.has === 'function' && req.headers.has('range')) return 'pass';
  if (req.destination === 'audio' || req.destination === 'video') return 'pass';
  const path = url.pathname;
  if (/\/(sw\.js|provenance\.json)$/.test(path)) return 'pass';   // 버전 확인은 항상 네트워크
  if (req.mode === 'navigate') return 'navigate';
  const base = scope ? new URL(scope).pathname : '/';
  const rel = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '');
  if (rel.startsWith('bundle/')) return url.search === '' ? 'shell' : 'pass';   // 해시 파일명에 쿼리를 붙여 캐시를 늘리는 요청은 저장하지 않는다
  // assets/ · props-manifest: 쿼리가 없거나 ?v=<빌드> 뿐일 때만 — 임의 쿼리 조합으로 저장공간을 채우지 못하게
  if ((rel.startsWith('assets/') || rel.startsWith('tools/assets/props-manifest.json')) && (url.search === '' || /^\?v=[\w.-]+$/.test(url.search))) return 'runtime';
  return 'pass';
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);   // 먼저 들어온 것부터
}

/** 캐시 우선. 저장·트림은 waitUntil 로 묶는다. 200·basic·크기 예산 안의 것만 저장한다. */
async function cacheFirst(event, req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // 크기를 **알 수 있고** 예산 안일 때만 저장한다 — content-length 가 없는(chunked) 응답은 크기를 모르므로 저장하지 않는다(luna·luna6·agy 검토: 길이 0 으로 읽혀 예산을 우회했다)
  const len = Number(res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (res && res.status === 200 && res.type === 'basic' && Number.isFinite(len) && len > 0 && len <= RUNTIME_MAX_BYTES) {
    event.waitUntil(cache.put(req, res.clone()).then(() => (max ? trim(cache, max) : null)).catch(() => { /* 용량 초과 등 — 저장만 포기 */ }));
  }
  return res;
}

/** 이동: 네트워크 우선(시간 제한 · 초과하면 요청 중단) → 실패하면 **설치 때 저장한 index.html**. 네트워크 HTML 은 저장하지 않는다. */
async function navigate(req) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, NAV_TIMEOUT_MS);
  try {
    return await fetch(req, ctl ? { cache: 'no-cache', signal: ctl.signal } : { cache: 'no-cache' });
  } catch (err) {
    const cache = await caches.open(SHELL);
    return (await cache.match(scopeUrl('index.html'))) || (await cache.match(scopeUrl('./'))) || Response.error();
  } finally { clearTimeout(timer); }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const hadActive = (await caches.keys()).includes(SHELL) && (await cache.keys()).length > 0;   // 같은 릴리스 캐시가 이미 채워져 있으면(활성 워커가 쓰는 중일 수 있다) 실패해도 지우지 않는다
    try {
      // index.html 만 cache:reload(항상 최신 · 이 릴리스의 번들 이름과 짝). 해시 번들은 HTTP 캐시를 써서 방금 받은 것을 다시 받지 않는다.
      await cache.addAll(SHELL_FILES.map((p) => new Request(scopeUrl(p), /^(\.\/|index\.html)$/.test(p) ? { cache: 'reload' } : undefined)));
      // 배포 중간 상태·CDN 지연 대비: 고정할 index.html 이 이 릴리스의 핵심 번들 이름을 실제로 가리켜야 한다 — 아니면 설치 실패(옛 워커 유지)
      const html = await (await cache.match(scopeUrl('index.html'))).text();
      const missing = SHELL_FILES.filter((p) => /^bundle\/index-[\w-]+\.js$/.test(p) && !html.includes(p));
      if (missing.length) throw new Error('index.html 이 이 릴리스의 번들을 가리키지 않는다: ' + missing.join(','));
    } catch (err) {
      if (!hadActive) await caches.delete(SHELL);   // 부분 저장을 남기지 않는다 — 설치 실패 → 옛 버전이 계속 돈다(활성 중인 캐시는 건드리지 않는다)
      throw err;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME]);
    for (const k of await caches.keys()) if (k.startsWith('vr-') && !keep.has(k)) await caches.delete(k);
  })());
});

self.addEventListener('message', (event) => { if (event.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const route = routeOf(event.request, self.location.origin, self.registration.scope);
  if (route === 'pass') return;   // 브라우저 기본 동작
  if (route === 'navigate') event.respondWith(navigate(event.request));
  else if (route === 'shell') event.respondWith(cacheFirst(event, event.request, SHELL, SHELL_MAX));
  else event.respondWith(cacheFirst(event, event.request, RUNTIME, RUNTIME_MAX));
});
