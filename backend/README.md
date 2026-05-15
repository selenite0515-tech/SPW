# Backend API

See the repository root `README.md` for full monorepo documentation.

Quick start:

```bash
npm install
cp .env.example .env   # then edit DATABASE_URL, SESSION_SECRET, optional S3
npm run seed           # optional
npm run dev
```

`npm run verify` runs `node --check` on main source files.
