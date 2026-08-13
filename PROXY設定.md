# 搜尋代理設定（手機連不到 iTunes 時用）

當手機直連 `itunes.apple.com` 一直失敗（fetch Load failed、JSONP 也失敗），
代表你的裝置/網路擋掉了對 Apple API 的請求。解法是架一個在**別的網域**的代理。
用 Cloudflare Worker，免費、不用懂網路設定，約 5 分鐘。

## 步驟

1. 到 https://dash.cloudflare.com 註冊 / 登入（免費帳號即可）。
2. 左邊選 **Workers & Pages** → **Create** → **Create Worker**。
3. 隨便取個名字（例如 `itunes-proxy`）→ **Deploy**（先部署預設範本）。
4. 進去按 **Edit code**，把整個編輯器內容刪掉，貼上本資料夾 `cloudflare-worker.js` 的內容 → 右上 **Deploy**。
5. 複製它給你的網址，長得像：
   `https://itunes-proxy.你的帳號.workers.dev`
6. 打開 `app.js`，找到這行（大約在 iTunes 搜尋區塊）：
   ```js
   const PROXY = '';
   ```
   把網址貼進去（結尾不要加斜線或參數）：
   ```js
   const PROXY = 'https://itunes-proxy.你的帳號.workers.dev';
   ```
7. 把 `app.js` 重新推上 GitHub Pages。手機無痕開一次，確認標題版本號有更新，再搜尋。

## 驗證代理本身有沒有通

瀏覽器直接開（把網址換成你的）：
```
https://itunes-proxy.你的帳號.workers.dev?term=晴天
```
看到一坨 JSON（裡面有 results）就代表 Worker 正常。

## 備註

- 設了 `PROXY` 後，搜尋一律走代理；萬一代理掛了，程式還是會退回原本的 fetch / JSONP。
- Worker 免費額度每天 10 萬次請求，派對遊戲用完全夠。
- 不想用 Cloudflare、想改用你的群暉 NAS 也可以，但要自己處理外網存取（DDNS + 反向代理 + HTTPS 憑證），比較麻煩，需要的話再問我。
