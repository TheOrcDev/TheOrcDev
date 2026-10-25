// update-youtube-readme.mjs
import fs from "node:fs/promises";

const CHANNEL_ID = "UCClMPKqtJ1LbRBCDP948g5Q";

// Long-form-only uploads playlist ("UULF" + channel id without the "UC" prefix).
// YouTube keeps Shorts (UUSH) and livestreams (UULV) out of it, so its feed only
// contains regular long-form videos. The plain channel feed mixes everything.
const LONG_FORM_PLAYLIST_ID = `UULF${CHANNEL_ID.slice(2)}`;
const LONG_FORM_FEED_URL = `https://www.youtube.com/feeds/videos.xml?playlist_id=${LONG_FORM_PLAYLIST_ID}`;
const LONG_FORM_PLAYLIST_URL = `https://www.youtube.com/playlist?list=${LONG_FORM_PLAYLIST_ID}`;

// Last-resort fallback when the playlist feed and playlist page are both blocked
// (YouTube sometimes answers 404 to datacenter IPs).
const VIDEOS_TAB_URL = "https://www.youtube.com/@OrcDev/videos";

// Anything this short or shorter is treated as a Short on the Videos tab.
const MIN_LONG_FORM_SECONDS = 180;

const README_PATH = "README.md";
const START = "<!-- YOUTUBE:START -->";
const END = "<!-- YOUTUBE:END -->";

const MAX_VIDEOS = Number(process.env.MAX_VIDEOS ?? 6);

// Layout controls
const COLUMNS = Number(process.env.COLUMNS ?? 3); // videos per row
const THUMB_WIDTH = Number(process.env.THUMB_WIDTH ?? 220); // px
const TITLE_MAX = Number(process.env.TITLE_MAX ?? 52); // chars

// Retry settings
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/atom+xml, application/xml, text/xml, text/html, application/json, */*",
  Cookie: "CONSENT=YES+1; SOCS=CAI",
  "Accept-Language": "en-US,en;q=0.9",
};

function extractVideoIdFromLink(link) {
  const url = new URL(link);

  // Common case: https://www.youtube.com/watch?v=VIDEO_ID
  const v = url.searchParams.get("v");
  if (v) return v;

  // Shorts: https://www.youtube.com/shorts/VIDEO_ID
  const parts = url.pathname.split("/").filter(Boolean);
  const shortsIdx = parts.indexOf("shorts");
  if (shortsIdx !== -1 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];

  // youtu.be: https://youtu.be/VIDEO_ID
  if (url.hostname === "youtu.be" && parts[0]) return parts[0];

  return null;
}

function decodeXmlEntities(str) {
  // Minimal decoding for common entities in titles
  return String(str)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(str, max) {
  const s = String(str).trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status !== 404 && status !== 403 && status !== 400 && status !== 401;
}

async function fetchText(url) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: FETCH_HEADERS,
      });

      if (res.ok) {
        const text = await res.text();
        console.log(`Fetched ${url} (${text.length} bytes).`);
        return text;
      }

      lastError = new Error(`HTTP ${res.status} ${res.statusText}`);
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${lastError.message}`);

      if (!isRetryableStatus(res.status)) {
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < MAX_RETRIES && lastError) {
      console.log(`Retrying in ${RETRY_DELAY_MS * attempt}ms...`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

function extractAttr(tag, attrName) {
  const m = tag.match(new RegExp(`${attrName}="([^"]+)"`));
  return m?.[1] ?? "";
}

function parseEntries(xml) {
  const entries = [];
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

  for (const block of entryBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkTags = block.match(/<link[^>]*\/?>/g) ?? [];
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);

    // YouTube can reorder attributes, so find alternate link by attributes instead of strict order
    let link = "";
    for (const tag of linkTags) {
      const rel = extractAttr(tag, "rel");
      const href = extractAttr(tag, "href");
      if (rel === "alternate" && href) {
        link = href;
        break;
      }
    }

    if (!link && videoIdMatch?.[1]) {
      link = `https://www.youtube.com/watch?v=${videoIdMatch[1].trim()}`;
    }

    const rawTitle = titleMatch?.[1] ?? "";
    const title = decodeXmlEntities(rawTitle);
    const published = publishedMatch?.[1] ?? "";

    if (!title || !link) continue;
    if (new URL(link).pathname.startsWith("/shorts/")) continue;
    entries.push({ title, link, published });
  }

  return entries;
}

function parseDuration(text) {
  const parts = String(text ?? "").split(":").map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function extractYtInitialData(html) {
  const marker = "var ytInitialData = ";
  const markerAt = html.indexOf(marker);
  if (markerAt === -1) return null;

  const braceStart = html.indexOf("{", markerAt);
  if (braceStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(html.slice(braceStart, i + 1));
      }
    }
  }

  return null;
}

function collectLockups(data) {
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  const selected =
    tabs.map((t) => t.tabRenderer).find((t) => t?.selected)?.content ??
    tabs[0]?.tabRenderer?.content ??
    data;

  const lockups = [];
  const seen = new Set();

  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      const vm = node.lockupViewModel;
      if (vm?.contentId && !seen.has(vm.contentId)) {
        seen.add(vm.contentId);
        lockups.push(vm);
      }
      for (const value of Object.values(node)) walk(value);
    }
  })(selected);

  return lockups;
}

function lockupToEntry(lockup, { requireLongDuration }) {
  const text = JSON.stringify(lockup);
  const durations = [...text.matchAll(/"text":"(\d{1,2}(?::\d{2}){1,2})"/g)];
  const seconds = durations.length ? parseDuration(durations[0][1]) : 0;
  const isLive = /"text":"LIVE"|"text":"Streamed |"text":"Streaming /i.test(text);
  const title = lockup.metadata?.lockupMetadataViewModel?.title?.content ?? "";
  const contentType = String(lockup.contentType ?? "");
  const isShort = /SHORT/i.test(contentType);

  if (!title || isLive || isShort) return null;
  if (requireLongDuration && seconds <= MIN_LONG_FORM_SECONDS) return null;

  return {
    title,
    link: `https://www.youtube.com/watch?v=${lockup.contentId}`,
    published: "",
  };
}

function parseLockupPage(html, { requireLongDuration }) {
  const data = extractYtInitialData(html);
  if (!data) return [];
  return collectLockups(data)
    .map((lockup) => lockupToEntry(lockup, { requireLongDuration }))
    .filter(Boolean);
}

async function withOfficialTitles(entries) {
  const head = entries.slice(0, MAX_VIDEOS);
  const resolved = [];

  for (const entry of head) {
    const id = extractVideoIdFromLink(entry.link);
    if (!id) {
      resolved.push(entry);
      continue;
    }

    try {
      const raw = await fetchText(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(entry.link)}&format=json`
      );
      const data = JSON.parse(raw);
      resolved.push(data?.title ? { ...entry, title: data.title } : entry);
    } catch (err) {
      console.warn(`oembed title lookup failed for ${id}: ${err.message}`);
      resolved.push(entry);
    }
  }

  return [...resolved, ...entries.slice(MAX_VIDEOS)];
}

async function getLongFormEntries() {
  const errors = [];

  try {
    const entries = parseEntries(await fetchText(LONG_FORM_FEED_URL));
    if (entries.length > 0) {
      console.log(`Using long-form playlist feed (${entries.length} entries).`);
      return entries;
    }
    errors.push("long-form feed returned no entries");
  } catch (err) {
    errors.push(`long-form feed: ${err.message}`);
  }

  try {
    const entries = parseLockupPage(await fetchText(LONG_FORM_PLAYLIST_URL), {
      requireLongDuration: false,
    });
    if (entries.length > 0) {
      console.log(`Using long-form playlist page fallback (${entries.length} entries).`);
      return entries;
    }
    errors.push("long-form playlist page returned no entries");
  } catch (err) {
    errors.push(`long-form playlist page: ${err.message}`);
  }

  try {
    const entries = parseLockupPage(await fetchText(VIDEOS_TAB_URL), {
      requireLongDuration: true,
    });
    if (entries.length > 0) {
      console.log(`Using Videos tab fallback (${entries.length} entries).`);
      return await withOfficialTitles(entries);
    }
    errors.push("videos tab returned no entries");
  } catch (err) {
    errors.push(`videos tab: ${err.message}`);
  }

  throw new Error(`All YouTube sources failed: ${errors.join(" | ")}`);
}

function renderGrid(entries) {
  const videos = entries
    .slice(0, MAX_VIDEOS)
    .map((e) => {
      const vid = extractVideoIdFromLink(e.link);
      if (!vid) return null;

      // "mqdefault.jpg" is smaller than hqdefault/maxres and looks cleaner in grids
      const thumb = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;

      const safeTitle = escapeHtml(truncate(e.title, TITLE_MAX));
      const href = escapeHtml(e.link);

      return { vid, thumb, href, title: safeTitle };
    })
    .filter(Boolean);

  if (videos.length === 0) {
    return "<!-- No videos found -->";
  }

  let html = `<table>\n`;

  for (let i = 0; i < videos.length; i += COLUMNS) {
    const row = videos.slice(i, i + COLUMNS);

    html += `  <tr>\n`;
    for (const v of row) {
      html +=
        `    <td align="center" valign="top" width="${Math.floor(100 / COLUMNS)}%">\n` +
        `      <a href="${v.href}">\n` +
        `        <img src="${v.thumb}" width="${THUMB_WIDTH}" alt="${v.title}" />\n` +
        `      </a>\n` +
        `      <br />\n` +
        `      <sub><b>${v.title}</b></sub>\n` +
        `    </td>\n`;
    }

    // Pad row with empty cells so the table stays aligned
    if (row.length < COLUMNS) {
      for (let k = 0; k < COLUMNS - row.length; k++) {
        html += `    <td></td>\n`;
      }
    }

    html += `  </tr>\n`;
  }

  html += `</table>`;
  return html;
}

function replaceSection(readme, replacement) {
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Markers not found or invalid. Ensure README contains:\n${START}\n...\n${END}`
    );
  }

  const before = readme.slice(0, startIdx + START.length);
  const after = readme.slice(endIdx);

  return `${before}\n\n${replacement}\n\n${after}`;
}

async function main() {
  console.log("Fetching latest long-form YouTube videos...");
  const entries = await getLongFormEntries();

  const preview = entries.slice(0, MAX_VIDEOS).map((e) => {
    const id = extractVideoIdFromLink(e.link);
    return `${id ?? "?"} ${e.title}`;
  });
  console.log(`Found ${entries.length} long-form videos. Using: ${preview.join(" | ")}`);

  const newSection = renderGrid(entries);
  const readme = await fs.readFile(README_PATH, "utf8");
  const updated = replaceSection(readme, newSection);

  if (updated === readme) {
    console.log("README unchanged.");
    return;
  }

  await fs.writeFile(README_PATH, updated, "utf8");
  console.log("README updated successfully.");
}

main().catch((err) => {
  // Fail loudly by default so a broken source shows up as a failed run (and a
  // notification) instead of the README silently going stale.
  // Set STRICT_YT_UPDATE=false to tolerate temporary upstream issues.
  const strict = String(process.env.STRICT_YT_UPDATE ?? "true") === "true";
  console.error("YouTube README update error:", err?.message ?? err);
  process.exit(strict ? 1 : 0);
});
