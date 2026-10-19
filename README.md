# supplier — 冠好供應商通訊錄 (Cloudflare Workers port)

Open-source port of the original 冠好供應商通訊錄 SPA. Originally hosted at
`https://supplier.quicklyrecap.com/`, now deployed to `https://supplier.mswu.tw/`.

- **Runtime**: Cloudflare Workers (V8 isolate)
- **Database**: D1 (SQLite at the edge)
- **Frontend**: Carbon-black + orange SPA (Nunito, identical to original)
- **Auth**: Basic auth for writes (`admin` / `Wms180403`)
- **CRUD**: full create / read / update / delete + 8-sheet search

## Layout

```
src/index.js          # worker entry — API + serves the SPA shell
migrations/0001_init.sql  # D1 schema
wrangler.toml         # CF Workers config (D1 binding + custom domain)
```

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/categories` | open | sheet list with counts |
| GET | `/api/meta` | open | counts + per-sheet columns |
| GET | `/api/search?sheet=&q=&limit=&offset=` | open | LIKE search across 18 fields |
| GET | `/api/record/:id` | open | single record |
| POST | `/api/create` | basic | create row |
| POST | `/api/update` | basic | update row by `_id` |
| DELETE | `/api/delete/:id` | basic | delete row by `_id` |
| POST | `/api/seed` | seed-token or basic | bulk insert per sheet |

## Local dev

```bash
nvm use 22
wrangler d1 migrations apply supplier --local
wrangler dev
```

## Deploy

```bash
wrangler d1 migrations apply supplier --remote
wrangler deploy
```

## Origin

Forked/mirrored from internal `supplier.quicklyrecap.com` (500 records, 8 sheets):
供應商整理 (245) / 加工 (2) / 報關行拖車行 (17) / 潛在供應商 (19) / 潛在供應商 (膜) (5) / 物料 (72) / 紙類包材聯絡人 (58) / 膜 (82).
