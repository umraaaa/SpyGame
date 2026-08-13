// iTunes 搜尋代理 —— 貼到 Cloudflare Worker（modules 格式）
// 瀏覽器改連這個 Worker，Worker 在伺服器端去打 iTunes，
// 繞過手機對 apple 網域的封鎖，並在邊緣快取 1 小時、降低 Apple 限流。

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const term = new URL(request.url).searchParams.get('term') || '';
    if (term === '') return new Response('{"results":[]}', { headers: { ...cors, 'Content-Type': 'application/json' } });

    const api = 'https://itunes.apple.com/search?media=music&entity=song&limit=8&country=TW&term=' + encodeURIComponent(term);
    const r = await fetch(api, { cf: { cacheTtl: 3600, cacheEverything: true } });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  },
};
