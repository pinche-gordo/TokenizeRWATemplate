# aaPanel deployment for `minting.digitaldimension.com.mx`

This project deploys cleanly to aaPanel as:

- static frontend served by nginx
- local Node backend for NFT upload routes on `127.0.0.1:3001`
- same-origin routing from `/api/*` to the backend

## Target layout

Recommended server paths:

- frontend build output: `/www/wwwroot/minting.digitaldimension.com.mx/frontend/dist`
- frontend source checkout: `/www/wwwroot/minting.digitaldimension.com.mx/frontend`
- backend source checkout: `/www/wwwroot/minting.digitaldimension.com.mx/server`

## Frontend

1. Copy the frontend project to the server.
   Path: `projects/TokenizeRWATemplate-frontend`
2. Create `.env` for production.
   Required:
   - `VITE_WEB3AUTH_CLIENT_ID=...`
   - `VITE_ALGOD_SERVER=https://testnet-api.algonode.cloud`
   - `VITE_ALGOD_NETWORK=testnet`
   - `VITE_INDEXER_SERVER=https://testnet-idx.algonode.cloud`
3. Leave `VITE_API_URL` unset if nginx will proxy `/api/` on the same host.
4. Build:
   - `npm install`
   - `npm run build`

## Backend

1. Copy the NFT server project to the server.
   Path: `projects/TokenizeRWATemplate-contracts/NFT_mint_server`
2. Create `.env`.
   Required:
   - `PINATA_JWT=...`
3. Install:
   - `npm install`
4. Run the backend with aaPanel Node Project manager or PM2 on `127.0.0.1:3001`.
   - `ALLOWED_ORIGINS=https://minting.digitaldimension.com.mx`
5. Health check:
   - `http://127.0.0.1:3001/health`

## nginx / aaPanel

Use `nginx-minting.digitaldimension.com.mx.conf` as the site config template.

Important behavior:

- `/api/*` proxies to the Node backend
- `/health` proxies to the backend health endpoint
- all other routes fall back to `/index.html` for the React SPA

In aaPanel:

1. Create site: `minting.digitaldimension.com.mx`
2. Set root to the built frontend `dist` directory
3. Paste the nginx config template into the site config
4. Enable Let's Encrypt / HTTPS
5. Restart nginx

## PM2 option

If you manage the backend outside aaPanel's Node Project UI:

- use `ecosystem.config.cjs`
- run from the backend directory:
  - `pm2 start /path/to/ecosystem.config.cjs`
  - `pm2 save`

## Online test checklist

- `https://minting.digitaldimension.com.mx` loads
- Web3Auth login opens on that domain
- wallet connects
- `/health` returns JSON through nginx
- NFT upload reaches `/api/pin-image`

