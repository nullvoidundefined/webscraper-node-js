import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

interface ScrapedItem {
  text: string;
  href?: string;
}

interface ScrapeResult {
  url: string;
  title: string;
  method: "cheerio" | "playwright";
  links: ScrapedItem[];
  headings: ScrapedItem[];
  paragraphs: string[];
  images: { src: string; alt: string }[];
  scrapedAt: string;
}

const SPA_INDICATORS = [
  '<div id="root"></div>',
  '<div id="app"></div>',
  '<div id="__next"></div>',
  '<div id="__nuxt">',
  "window.__NEXT_DATA__",
  "window.__NUXT__",
  "ng-app",
  "ng-version",
  '<script type="module"',
];

function needsBrowser(html: string, $: cheerio.CheerioAPI): boolean {
  // Almost no visible text content — likely JS-rendered
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  if (bodyText.length < 100) return true;

  // No paragraphs or headings but page has scripts — content is probably rendered client-side
  const hasContent = $("p").length > 0 || $("h1, h2, h3").length > 0;
  const hasScripts = $("script[src]").length > 2;
  if (!hasContent && hasScripts) return true;

  // Matches known SPA framework markers
  const htmlLower = html.toLowerCase();
  for (const indicator of SPA_INDICATORS) {
    if (htmlLower.includes(indicator.toLowerCase())) {
      // Found the marker — but only escalate if the page is also light on content
      if (!hasContent) return true;
    }
  }

  return false;
}

function extractData($: cheerio.CheerioAPI): Omit<ScrapeResult, "url" | "method" | "scrapedAt"> {
  const title = $("title").text().trim();

  const links: ScrapedItem[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && text) links.push({ text, href });
  });

  const headings: ScrapedItem[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = $(el).text().trim();
    if (text) headings.push({ text });
  });

  const paragraphs: string[] = [];
  $("p").each((_, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  const images: { src: string; alt: string }[] = [];
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    const alt = $(el).attr("alt") ?? "";
    if (src) images.push({ src, alt });
  });

  return { title, links, headings, paragraphs, images };
}

async function fetchWithCheerio(url: string): Promise<{ html: string; $: cheerio.CheerioAPI }> {
  const { data: html } = await axios.get<string>(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    timeout: 10_000,
  });
  return { html, $: cheerio.load(html) };
}

async function fetchWithPlaywright(url: string): Promise<cheerio.CheerioAPI> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const html = await page.content();
    return cheerio.load(html);
  } finally {
    await browser.close();
  }
}

async function scrape(url: string): Promise<ScrapeResult> {
  // Phase 1: fast fetch with Cheerio
  console.log("  [1/2] Fetching with Cheerio...");
  const { html, $ } = await fetchWithCheerio(url);

  let method: "cheerio" | "playwright" = "cheerio";
  let final$ = $;

  // Phase 2: detect if the page needs a real browser
  if (needsBrowser(html, $)) {
    console.log("  [2/2] Page appears JS-rendered — launching Playwright...");
    final$ = await fetchWithPlaywright(url);
    method = "playwright";
  } else {
    console.log("  [2/2] Static page detected — Cheerio is sufficient.");
  }

  return {
    url,
    method,
    ...extractData(final$),
    scrapedAt: new Date().toISOString(),
  };
}

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage: npx tsx src/scraper.ts <url>");
    process.exit(1);
  }

  console.log(`Scraping ${url}...\n`);
  const result = await scrape(url);

  console.log(`\nTitle: ${result.title}`);
  console.log(`Method: ${result.method}`);
  console.log(`Links: ${result.links.length}`);
  console.log(`Headings: ${result.headings.length}`);
  console.log(`Paragraphs: ${result.paragraphs.length}`);
  console.log(`Images: ${result.images.length}`);

  const outFile = path.join("output", "result.json");
  fs.mkdirSync("output", { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`\nFull results saved to ${outFile}`);
}

main().catch((err) => {
  console.error("Scrape failed:", err.message);
  process.exit(1);
});
