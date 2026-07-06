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

function parseSitemap(html) {
  const $ = cheerio.load(html);
  const items = [];
  let currentCategory = null;

  $("a").each((_, elem) => {
    const $a = $(elem);
    const href = $a.attr("href") || "";
    if (!href.startsWith("/")) return;
    const cleanPath = href.split("?")[0].split("#")[0];
    const segments = cleanPath.split("/").filter(Boolean);
    const text = $a.text().trim();
    if (segments.length === 0 || !text) return;

    if (segments.length === 1) {
      const parentTag = elem.parent && elem.parent.tagName;
      if (parentTag === "b" || parentTag === "strong") {
        currentCategory = text;
      }
    } else if (segments.length === 2 && currentCategory) {
      items.push({ category: currentCategory, name: text, url: BASE + cleanPath });
    }
  });

  // фоллбэк, если разметка сайта отличается от ожидаемой
  if (items.length === 0) {
    currentCategory = null;
    $("a").each((_, elem) => {
      const $a = $(elem);
      const href = $a.attr("href") || "";
      if (!href.startsWith("/")) return;
      const cleanPath = href.split("?")[0].split("#")[0];
      const segments = cleanPath.split("/").filter(Boolean);
      const text = $a.text().trim();
      if (segments.length === 1 && text) currentCategory = text;
      else if (segments.length === 2 && currentCategory && text) {
        items.push({ category: currentCategory, name: text, url: BASE + cleanPath });
      }
    });
  }

  const seen = new Set();
  return items.filter((it) => {
    const key = `${it.category}|${it.name}|${it.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function parseListingsPage(html, categoryLabel) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();

  $("a[href*='/site/']").each((_, elem) => {
    const $a = $(elem);
    const href = ($a.attr("href") || "").split("#")[0];
    if (!href) return;
    const profileUrl = href.startsWith("http") ? href : BASE + href;
    if (seen.has(profileUrl)) return;

    let container = $a.closest("li");
    if (container.length === 0) container = $a.closest("div");
    if (container.length === 0) container = $a.closest("p");
    if (container.length === 0) return;

    seen.add(profileUrl);

    const fullText = container.text().replace(/\s+/g, " ").trim();
    let name = $a.text().trim();
    if (!name) {
      name = ($a.attr("title") || "").replace("Profile: ", "").trim();
    }

    let websiteUrl = "";
    container.find("a").each((__, x) => {
      if (websiteUrl) return;
      const h = $(x).attr("href") || "";
      if (h && !h.includes("monerica.com") && !h.startsWith("/") && !h.startsWith("#")) {
        websiteUrl = h;
      }
    });

    const ratingMatch = fullText.match(/(\d(?:\.\d)?)\s*\((\d+)\)/);
    let desc = fullText;
    if (name) desc = desc.replace(name, "");
    if (ratingMatch) desc = desc.replace(ratingMatch[0], "");
    desc = desc.replace(/[\u2705\u2753\u274C\u{1F7E6}]/gu, "");
    desc = desc.replace(/\s+/g, " ").trim().replace(/^[·\-\s]+|[·\-\s]+$/g, "");

    rows.push({
      category: categoryLabel,
      name: name || "(без названия)",
      link: websiteUrl || profileUrl,
      description: desc,
    });
  });

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
