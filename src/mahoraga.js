import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 15_000;
const TIMEOUT_MS = 12_000;

const REMOVE = [
  "script", "style", "noscript", "svg", "iframe",
  "nav", "footer", "header", "aside", "form",
  '[role="navigation"]', '[role="banner"]',
  '[role="complementary"]',
  ".advertisement", ".advert", ".ads",
  ".cookie-banner", ".social-share"
];

function validateUrl(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Somente URLs HTTP e HTTPS são permitidas.");
  }
  if (url.username || url.password) {
    throw new Error("URLs com credenciais não são permitidas.");
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Endereço local não permitido.");
  }

  return url;
}

async function readLimited(response) {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_HTML_BYTES) {
    throw new Error("HTML excedeu o limite de 2 MB.");
  }
  if (!response.body) throw new Error("Resposta sem conteúdo.");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("HTML excedeu o limite de 2 MB.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function extractHtml(html, url) {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]')
    .attr("content")?.trim() || "";

  for (const selector of REMOVE) $(selector).remove();

  const main = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");

  const headings = main.find("h1, h2, h3")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean)
    .slice(0, 40);

  const rawText = main.find("p, li")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const text = rawText.slice(0, MAX_TEXT_CHARS);

  return {
    url,
    title,
    description,
    headings,
    text,
    textTruncated: rawText.length > MAX_TEXT_CHARS,
    extractedCharacters: text.length
  };
}

export async function analyzePage(inputUrl) {
  const url = validateUrl(inputUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        "User-Agent": "MahoragaIPTV/0.1",
        "Accept": "text/html"
      }
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
      await response.body?.cancel();
      throw new Error("A resposta não é HTML.");
    }

    const bytes = await readLimited(response);
    const html = new TextDecoder("utf-8").decode(bytes);
    return extractHtml(html, response.url || url.href);
  } finally {
    clearTimeout(timer);
  }
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const inputUrl = process.argv[2];
  if (!inputUrl) {
    console.error("Uso: npm run mahoraga -- https://example.com/");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await analyzePage(inputUrl), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }, null, 2));
      process.exitCode = 1;
    }
  }
}
