// scripts/update-youtube-readme.mjs
import fs from "node:fs/promises";

const FEED_URL =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCClMPKqtJ1LbRBCDP948g5Q";

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

async function fetchFeedXml() {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(FEED_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; GitHubActions/1.0; +https://github.com)",
          "Accept": "application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      
      if (res.ok) {
        return await res.text();
      }
      
      lastError = new Error(`HTTP ${res.status} ${res.statusText}`);
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`);
      
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    }
    
    if (attempt < MAX_RETRIES) {
      console.log(`Retrying in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
    }
  }
  
  throw new Error(`Failed to fetch RSS feed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

function parseEntries(xml) {
  const entries = [];
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

  for (const block of entryBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(
      /<link[^>]*rel="alternate"[^>]*href="([^"]+)"[^>]*\/?>/
    );
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);

    const rawTitle = titleMatch?.[1] ?? "";
    const title = decodeXmlEntities(rawTitle);
    const link = linkMatch?.[1] ?? "";
    const published = publishedMatch?.[1] ?? "";

    if (!title || !link) continue;
    entries.push({ title, link, published });
  }

  return entries;
}

function renderGrid(entries) {
  const videos = entries.slice(0, MAX_VIDEOS).map((e) => {
    const vid = extractVideoIdFromLink(e.link);
    if (!vid) return null;

    // "mqdefault.jpg" is smaller than hqdefault/maxres and looks cleaner in grids
    const thumb = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;

    const safeTitle = escapeHtml(truncate(e.title, TITLE_MAX));
    const href = escapeHtml(e.link);

    return { thumb, href, title: safeTitle };
  }).filter(Boolean);

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
  console.log("Fetching YouTube RSS feed...");
  const xml = await fetchFeedXml();
  const entries = parseEntries(xml);

  console.log(`Parsed ${entries.length} entries from feed.`);

  if (entries.length === 0) {
    throw new Error("No entries parsed from the feed. The feed format may have changed.");
  }

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
  console.error(err);
  process.exit(1);
});
