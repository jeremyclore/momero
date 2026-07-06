# Monerica → Excel

Небольшое Node.js/Express-приложение: сервер сам ходит на monerica.com
(без CORS-прокси), собирает каталог по выбранным категориям и стримит
прогресс в браузер. Результат экспортируется в `.xlsx` прямо на клиенте
(библиотека SheetJS).

## Локальный запуск

```bash
npm install
npm start
```

Откройте http://localhost:3000

## Деплой на Railway

### Вариант A: через GitHub
1. Залейте эту папку в новый репозиторий на GitHub.
2. В Railway: New Project → Deploy from GitHub repo → выберите репозиторий.
3. Railway сам определит Node.js по `package.json` и запустит `npm start`
   (см. `Procfile`). Ничего дополнительно настраивать не нужно.
4. Переменная `PORT` подставляется Railway автоматически — сервер уже её
   читает (`process.env.PORT`).

### Вариант B: через Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Структура проекта

```
server.js          — Express-сервер: /api/sitemap, /api/scrape (NDJSON-стрим)
public/index.html   — фронтенд (статика, отдаётся тем же сервером)
package.json        — зависимости: express, cheerio
Procfile             — команда запуска для Railway/Heroku-подобных платформ
```

## API

- `GET /api/sitemap` → `{ ok: true, items: [{category, name, url}, ...] }`
- `POST /api/scrape` body: `{ subcats: [...], delay: 400, pageLimit: 10 }`
  → ответ потоковый, NDJSON (по одному JSON-объекту на строку):
  - `{"type":"start","total":N}`
  - `{"type":"log","level":"info|warn|error","message":"..."}`
  - `{"type":"rows","rows":[{category,name,link,description}, ...]}`
  - `{"type":"progress","done":N,"total":N,"errors":N}`
  - `{"type":"done","stopped":false}`

Остановка сбора на клиенте делается через `AbortController` — обрыв
соединения ловится на сервере через `req.on('close', ...)`.

## Замечания

- Задержка между запросами (`delay`, мс) и лимит страниц пагинации на
  подкатегорию (`pageLimit`) регулируются в интерфейсе — не выставляйте
  слишком маленькую задержку, чтобы не перегружать чужой сайт.
- Полный обход всего каталога — это сотни подкатегорий, может занять
  ощутимое время. Прогресс и лог видны в реальном времени.
- Разметка сайта может со временем измениться — тогда потребуется
  поправить селекторы в `parseSitemap` / `parseListingsPage` в `server.js`.
