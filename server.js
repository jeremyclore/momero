// Полифилл для Node 18.x: некоторые сборки не определяют глобальный File,
// из-за чего undici (используется внутри fetch) падает при загрузке модуля
// с ReferenceError: File is not defined. В Node 20+ это не требуется, но
// полифилл безвреден и в этом случае просто не сработает (typeof !== undefined).
if (typeof globalThis.File === "undefined") {
  const { Blob } = require("node:buffer");
  globalThis.File = class File extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = String(name);
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BASE = "https://monerica.com";
const UA = "Mozilla/5.0 (compatible; MonericaExporter/1.0; +https://github.com/) Node.js";

// ---------- fetch helper ----------

async function fetchHtml(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- parsing ----------

// Сайт отдаёт ссылки то относительными ("/businesses"), то абсолютными
// ("https://monerica.com/businesses") - приводим к единому виду: пути
// без домена, либо null, если ссылка ведёт на другой сайт.
function normalizeMonericaPath(href) {
  if (!href) return null;
  let url;
  try {
    url = new URL(href, BASE);
  } catch {
    return null;
  }
  if (!/(^|\.)monerica\.com$/.test(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return path || "/";
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = `${it.category}|${it.name}|${it.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Реальная разметка страницы /sitemap: ссылка на категорию (путь из одного
// сегмента, напр. /businesses) обёрнута в <strong> (жирным шрифтом),
// ссылки на подкатегории (/businesses/accounting) - обычные, без обёртки.
// У всех ссылок класс "no-app-link", но полагаться на класс не будем -
// он может быть служебным и без гарантий на будущее.
function parseSitemapByBoldWrapper($) {
  const items = [];
  let currentCategory = null;

  $("a").each((_, elem) => {
    const $a = $(elem);
    const href = $a.attr("href") || "";
    const path = normalizeMonericaPath(href);
    if (!path) return;
    const segments = path.split("/").filter(Boolean);
    const text = $a.text().trim();
    if (!text) return;

    const isBold = $a.closest("strong, b").length > 0;

    if (segments.length === 1 && isBold) {
      currentCategory = text;
    } else if (segments.length === 2 && currentCategory) {
      items.push({ category: currentCategory, name: text, url: BASE + path });
    }
  });

  return items;
}

// Фоллбэк на случай другой разметки: та же логика, но без требования
// жирного начертания - текущей категорией считается последняя встреченная
// ссылка с путём из одного сегмента.
function parseSitemapByLinkOrder($) {
  const items = [];
  let currentCategory = null;
  $("a").each((_, elem) => {
    const $a = $(elem);
    const href = $a.attr("href") || "";
    const path = normalizeMonericaPath(href);
    if (!path) return;
    const segments = path.split("/").filter(Boolean);
    const text = $a.text().trim();
    if (segments.length === 1 && text) {
      currentCategory = text;
    } else if (segments.length === 2 && currentCategory && text) {
      items.push({ category: currentCategory, name: text, url: BASE + path });
    }
  });
  return items;
}

function parseSitemap(html) {
  const $ = cheerio.load(html);

  let items = parseSitemapByBoldWrapper($);
  // Если основной метод почти ничего не нашёл (структура страницы
  // отличается от ожидаемой), пробуем более мягкий фоллбэк без требования
  // жирного начертания.
  if (items.length < 5) {
    const fallbackItems = parseSitemapByLinkOrder($);
    if (fallbackItems.length > items.length) items = fallbackItems;
  }

  return dedupeItems(items);
}

function findMaxPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $("a[href*='/page/']").each((_, elem) => {
    const href = $(elem).attr("href") || "";
    const m = href.match(/\/page\/(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return max;
}

function isMonericaHost(absoluteUrl) {
  try {
    const u = new URL(absoluteUrl);
    return /(^|\.)monerica\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

function resolveHref(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE).toString();
  } catch {
    return null;
  }
}

// "19", "(19)", "4.7" - похоже на рейтинг/счётчик отзывов, а не на название
function looksLikeRatingOrEmpty(text) {
  const t = (text || "").trim();
  if (t === "") return true;
  return /^\(?\d+(\.\d+)?\)?$/.test(t);
}

// Блок "Main Sponsors" - общесайтовая витрина, одинаковая на каждой странице
// пагинации любой категории. К конкретной подкатегории отношения не имеет и
// дублируется при обходе страниц, поэтому вырезаем его и всё, что после него,
// ещё до парсинга (там же обычно идёт футер сайта - он тоже не нужен).
function stripFooterSections(html) {
  const idx = html.search(/main sponsors/i);
  return idx === -1 ? html : html.slice(0, idx);
}

function parseListingsPage(rawHtml, categoryLabel) {
  const html = stripFooterSections(rawHtml);
  const $ = cheerio.load(html);
  const rows = [];

  // Контейнер одного листинга - <li>, содержащий ссылку на /site/...
  let containers = $("li")
    .filter((_, el) => $(el).find("a[href*='/site/']").length > 0)
    .toArray();

  // Фоллбэк для другой вёрстки (без <li>, например карточки-<div>): берём
  // самые глубокие div/p с такой ссылкой, чтобы не задвоить родительские
  // контейнеры.
  if (containers.length === 0) {
    containers = $("div, p")
      .filter((_, el) => {
        const $el = $(el);
        if ($el.find("a[href*='/site/']").length === 0) return false;
        return $el.find("div, p").filter((__, inner) => $(inner).find("a[href*='/site/']").length > 0).length === 0;
      })
      .toArray();
  }

  for (const el of containers) {
    const $c = $(el);
    const links = $c.find("a").toArray();
    if (links.length === 0) continue;

    let profileUrl = "";
    for (const a of links) {
      const href = $(a).attr("href") || "";
      if (href.includes("/site/")) {
        const resolved = resolveHref(href.split("#")[0]);
        if (resolved) {
          profileUrl = resolved;
          break;
        }
      }
    }
    if (!profileUrl) continue;

    // Название: первая ссылка с осмысленным текстом. Для обычных листингов
    // это ссылка на профиль (/site/...), для спонсорских карточек - ссылка
    // сразу на внешний сайт (у /site/ там только счётчик отзывов вида "(19)").
    let name = "";
    for (const a of links) {
      const t = $(a).text().trim();
      if (!looksLikeRatingOrEmpty(t)) {
        name = t;
        break;
      }
    }
    if (!name) {
      const withTitle = links.find((a) => ($(a).attr("title") || "").startsWith("Profile: "));
      if (withTitle) name = ($(withTitle).attr("title") || "").replace("Profile: ", "").trim();
    }
    if (!name) name = "(без названия)";

    // Сайт компании: первая ссылка, ведущая не на monerica.com
    let websiteUrl = "";
    for (const a of links) {
      const href = $(a).attr("href") || "";
      if (!href || href.startsWith("#")) continue;
      const resolved = resolveHref(href);
      if (resolved && !isMonericaHost(resolved)) {
        websiteUrl = resolved;
        break;
      }
    }

    const fullText = $c.text().replace(/\s+/g, " ").trim();
    const ratingMatch = fullText.match(/(\d(?:\.\d)?)\s*\((\d+)\)/);
    let desc = fullText;
    if (name) desc = desc.replace(name, "");
    if (ratingMatch) desc = desc.replace(ratingMatch[0], "");
    desc = desc.replace(/[\u2705\u2753\u274C\u{1F7E6}]/gu, "");
    desc = desc.replace(/\s+/g, " ").trim().replace(/^[·\-\s]+|[·\-\s]+$/g, "");

    rows.push({
      category: categoryLabel,
      name,
      link: websiteUrl || profileUrl,
      description: desc,
    });
  }

  return rows;
}

// ---------- routes ----------

app.get("/api/sitemap", async (req, res) => {
  try {
    const html = await fetchHtml(`${BASE}/sitemap`);
    const items = parseSitemap(html);
    res.json({ ok: true, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Стриминг NDJSON: каждая строка ответа - один JSON-объект-событие.
// Так проще, чем SSE + GET, и работает с POST-телом произвольного размера.
app.post("/api/scrape", async (req, res) => {
  const { subcats, delay = 400, pageLimit = 10 } = req.body || {};

  if (!Array.isArray(subcats) || subcats.length === 0) {
    res.status(400).json({ ok: false, error: "subcats пуст или не массив" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "Transfer-Encoding": "chunked",
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  let stopped = false;
  req.on("close", () => {
    stopped = true;
  });

  const safeDelay = Math.max(0, Number(delay) || 0);
  const safePageLimit = Math.max(1, Number(pageLimit) || 1);

  send({ type: "start", total: subcats.length });

  let done = 0;
  let errors = 0;

  for (const item of subcats) {
    if (stopped) break;
    const label = `${item.category} / ${item.name}`;
    send({ type: "log", level: "info", message: `${label} ...` });

    try {
      const html1 = await fetchHtml(item.url);
      const rows1 = parseListingsPage(html1, label);
      if (rows1.length) send({ type: "rows", rows: rows1 });

      const maxPage = Math.min(findMaxPage(html1), safePageLimit);
      for (let p = 2; p <= maxPage; p++) {
        if (stopped) break;
        await sleep(safeDelay);
        const pageUrl = `${item.url.replace(/\/$/, "")}/page/${p}`;
        try {
          const htmlP = await fetchHtml(pageUrl);
          const rowsP = parseListingsPage(htmlP, label);
          if (rowsP.length) send({ type: "rows", rows: rowsP });
        } catch (e) {
          send({ type: "log", level: "warn", message: `  стр. ${p}: ${e.message}` });
        }
      }
    } catch (e) {
      errors++;
      send({ type: "log", level: "error", message: `ошибка: ${e.message}` });
    }

    done++;
    send({ type: "progress", done, total: subcats.length, errors });
    await sleep(safeDelay);
  }

  send({ type: "done", stopped });
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Monerica exporter listening on port ${PORT}`);
});
