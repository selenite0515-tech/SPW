# Payslip app (monorepo)

Employee payslips with server-side payroll math, digital attestation, PDF generation, and optional **S3-compatible** object storage for PDFs. This repository splits a **Node/Express API** (`backend/`) from a **Vite + TypeScript SPA** (`frontend/`).

## Layout

| Path | Role |
|------|------|
| `backend/` | Express API, PostgreSQL access, migrations, PDF generation, S3 upload, session auth |
| `frontend/` | Vite SPA (`frontend/dist` after build) |
| `backend/scripts/migrations/` | Optional raw SQL (also mirrored by programmatic migrate in `backend/src/db.js`) |

## Run order (development)

1. **PostgreSQL** running and `DATABASE_URL` set (see `backend/.env.example`).
2. **Backend** — from `backend/`:

   ```bash
   npm install
   npm run seed   # optional: demo users + payroll rows
   npm run dev    # http://localhost:3000 — API + optional static SPA in production only
   ```

3. **Frontend** — from `frontend/` (separate terminal):

   ```bash
   npm install
   npm run dev    # http://localhost:5173 — proxies /api to backend (see vite.config.ts)
   ```

Set `FRONTEND_ORIGIN=http://localhost:5173` in the backend `.env` when using the Vite dev server so **CORS** and **cookie** sessions work.

## Production

- **Option A — single host:** build the SPA (`cd frontend && npm run build`), deploy `frontend/dist`, and run the backend with `NODE_ENV=production`. The server serves `frontend/dist` when present and falls back to SPA `index.html` for non-`/api` routes.
- **Option B — split origins:** host `frontend/dist` on a static CDN or object storage; set backend `FRONTEND_ORIGIN` to that origin (comma-separated for several). Use `VITE_API_URL` in the frontend build pointing at the API origin. **Cookies + CORS** require `credentials: true` and an explicit allowed origin (not `*`).

## Environment variables

See **`backend/.env.example`** for `DATABASE_URL`, `SESSION_SECRET`, **S3** settings (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` for MinIO), `PDF_STORAGE_DIR` (local dev fallback), `FRONTEND_ORIGIN`, and `PRESIGNED_PDF_TTL_SECONDS`.

### S3 / MinIO vs AWS

- **AWS S3:** use the regional endpoint, virtual-hosted style is typical (`S3_FORCE_PATH_STYLE=false`), and IAM credentials with least privilege (`s3:PutObject`, `s3:GetObject` on the payslip prefix).
- **MinIO (self-hosted):** set `S3_ENDPOINT` to your MinIO URL (e.g. `http://127.0.0.1:9000`), `S3_FORCE_PATH_STYLE=true`, and create a bucket matching `S3_BUCKET`. Same AWS SDK; no AWS account required.

In **`NODE_ENV=production`**, incomplete S3 configuration **fails fast** at startup. In **development**, missing S3 env falls back to **`PDF_STORAGE_DIR`** / `./data/pdfs` (not for production — see `backend/.env.example`).

## Admin access

Administrative API routes require an authenticated user whose **job post code** is `ADM` or `ADMIN` (case-insensitive), derived from `job_posts.code` (not only `employees.role`). Demo seed links the admin user to post **ADM**.

## PDF download threat model (short)

Employees download PDFs via **`GET /api/payslip/:year/:month/pdf`**: the session is checked, then the server either **redirects (302)** to a **short-lived presigned GET URL** (S3) or streams the file from disk (local dev). Anyone who obtains the presigned URL before expiry can download that object; TTL is bounded by `PRESIGNED_PDF_TTL_SECONDS` (default 300). Prefer HTTPS for the API and for MinIO/S3 endpoints.

## Verification

```bash
cd backend && npm run verify
cd frontend && npm run build
```

If npm is unavailable, `node --check` on the backend entry files is an acceptable fallback (see `backend/package.json` `verify` script).
