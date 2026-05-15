# Frontend (Vite + TypeScript)

## Development

With the backend running on port 3000 (default), from this directory:

```bash
npm install
npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:3000` by default. Override with env **`VITE_DEV_PROXY_TARGET`**.

Set the backend **`FRONTEND_ORIGIN=http://localhost:5173`** so session cookies work with CORS.

## Production build

Output: **`dist/`** (configured in `vite.config.ts`).

```bash
npm install
npm run build
```

If the API is on another origin, set **`VITE_API_URL`** at build time (e.g. `https://api.example.com`) so the SPA calls the correct host. The backend must list your static site origin in **`FRONTEND_ORIGIN`**.
