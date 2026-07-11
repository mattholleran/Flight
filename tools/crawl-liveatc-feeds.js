#!/usr/bin/env node
/**
 * Crawls liveatc.net's feed index and builds feeds.json for liveatc.html.
 *
 * Run on your own machine (needs real internet access + Node 18+ for the
 * built-in fetch — check with `node --version`):
 *
 *   node tools/crawl-liveatc-feeds.js
 *
 * Output: feeds.json at the repo root, next to liveatc.html, in the shape
 * the app already knows how to read:
 *   { "KSTL": [{"label":"kstl2_twr","mount":"kstl2_twr"}, ...], ... }
 *
 * Useful flags while testing (this was written without being able to fetch
 * liveatc.net from the sandbox that authored it, so the very first run
 * should be a small one — see --limit below — before committing to the
 * full site):
 *
 *   --limit N        only process the first N discovered airports (default: no limit)
 *   --filter REGEX    only keep ICAOs matching this regex (default: ^K, i.e. contiguous US;
 *                      use ".*" for everywhere LiveATC has feeds, or e.g. "^(K|PA|PH|TJ)" for
 *                      the US incl. Alaska/Hawaii/Puerto Rico)
 *   --delay MS        pause between each per-airport request (default: 1000ms — please
 *                      don't set this to something aggressive, this hits someone else's server)
 *   --out FILE        output path (default: feeds.json at the repo root)
 *   --index-only      just print the discovered ICAO list and exit, don't fetch per-airport pages
 *
 * The script checkpoints as it goes (writes --out after every airport), so
 * if it's interrupted (Ctrl-C, network blip, you close the laptop) you can
 * just run it again and it picks up where it left off — already-crawled
 * ICAOs in the output file are skipped.
 *
 * If something looks wrong (very few ICAOs discovered, feeds with no
 * mounts, garbled labels), the script saves raw HTML samples into
 * .crawl-debug/ so you can look at the actual page structure and send me
 * a sample — the mount= extraction should be robust since it's a simple,
 * stable pattern, but label extraction (turning surrounding text into
 * something like "Tower" instead of just repeating the mount name) is a
 * best-effort heuristic that may need adjusting against the real HTML.
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function argValue(name, def){
  const i = args.indexOf("--" + name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const LIMIT = parseInt(argValue("limit", "0"), 10) || 0;
const FILTER = new RegExp(argValue("filter", "^K"), "i");
const DELAY_MS = parseInt(argValue("delay", "1000"), 10);
const OUT_FILE = path.resolve(__dirname, "..", argValue("out", "feeds.json"));
const INDEX_ONLY = args.includes("--index-only");
const DEBUG_DIR = path.resolve(__dirname, "..", ".crawl-debug");

const USER_AGENT = "Mozilla/5.0 (compatible; personal-liveatc-panel-crawler/1.0; run manually, low-rate, non-commercial)";

function sleep(ms){ return new Promise((r) => setTimeout(r, ms)); }

async function fetchText(url){
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if(!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.text();
}

function saveDebugSample(name, html){
  try{
    if(!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, name + ".html"), html);
  } catch(e){ /* debug samples are best-effort, never fatal */ }
}

// ---- Phase 1: discover ICAO codes with feeds -----------------------------
// LiveATC's feed index pages list airports as links containing icao=XXXX.
// type=all is the broadest listing; if this turns out to be paginated or
// JS-rendered rather than one static HTML page, discoveredIcaos will come
// back suspiciously small and a debug sample gets saved so that's visible.
const INDEX_URLS = [
  "https://www.liveatc.net/feedindex.php?type=all"
];

async function discoverIcaos(){
  const found = new Set();
  for(const url of INDEX_URLS){
    console.log("Fetching index: " + url);
    let html;
    try{
      html = await fetchText(url);
    } catch(e){
      console.error("  Failed: " + e.message);
      continue;
    }
    saveDebugSample("index_" + url.replace(/[^a-z0-9]+/gi, "_").slice(0, 80), html);
    const re = /icao=([a-z0-9]{3,4})/gi;
    let m;
    while((m = re.exec(html))) found.add(m[1].toUpperCase());
    console.log("  Found " + found.size + " distinct ICAOs so far");
    await sleep(DELAY_MS);
  }
  return Array.from(found).sort();
}

// ---- Phase 2: per-airport feed + label extraction ------------------------
function extractFeedsFromAirportPage(html, icao){
  const mounts = new Set();
  const mountRe = /mount=([a-z0-9_]+)/gi;
  let m;
  while((m = mountRe.exec(html))) mounts.add(m[1].toLowerCase());

  const feeds = [];
  mounts.forEach((mount) => {
    // Best-effort label: look at a chunk of HTML right before this mount's
    // first occurrence, strip tags, and pull out the last short run of
    // words — often something like "Tower", "Ground", "Twr/Gnd/Del", etc.
    // Falls back to the raw mount name if nothing clean turns up, which is
    // exactly what the app already does for un-labeled cached lookups, so
    // it's never worse than what's already there.
    const idx = html.toLowerCase().indexOf("mount=" + mount);
    let label = mount;
    if(idx !== -1){
      // Extend to the end of the enclosing tag (the next ">") so the window
      // never ends mid-tag — cutting there was leaving fragments like
      // 'Denver Tower <a href="hlisten.php?' instead of a clean label.
      const tagEnd = html.indexOf(">", idx);
      const windowEnd = tagEnd !== -1 ? tagEnd + 1 : idx;
      const windowHtml = html.slice(Math.max(0, idx - 300), windowEnd);
      const text = windowHtml
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
        .replace(/[<>"]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const words = text.split(" ").filter(Boolean);
      const tail = words.slice(-4).join(" ").trim();
      if(tail && tail.length >= 2 && tail.length <= 40 && /[a-z]/i.test(tail)){
        label = tail;
      }
    }
    feeds.push({ label, mount });
  });
  return feeds;
}

function loadExisting(){
  try{ return JSON.parse(fs.readFileSync(OUT_FILE, "utf8")); }
  catch(e){ return {}; }
}

function saveOutput(data){
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
}

async function main(){
  console.log("Discovering airports with feeds...");
  let icaos = await discoverIcaos();
  console.log("Discovered " + icaos.length + " total ICAOs before filtering.");

  icaos = icaos.filter((icao) => FILTER.test(icao));
  console.log(icaos.length + " ICAOs match filter " + FILTER + ".");

  if(icaos.length < 20){
    console.warn(
      "WARNING: fewer than 20 airports discovered — the index page's HTML\n" +
      "structure may not be what this script expects (e.g. paginated or\n" +
      "loaded via JavaScript rather than present in the static HTML).\n" +
      "Check .crawl-debug/ for the raw page and share it if this looks wrong."
    );
  }

  if(LIMIT > 0) icaos = icaos.slice(0, LIMIT);
  if(INDEX_ONLY){
    console.log(icaos.join("\n"));
    return;
  }

  const output = loadExisting();
  let processed = 0, skipped = 0, failed = 0;

  for(const icao of icaos){
    if(output[icao]){ skipped++; continue; }
    const url = "https://www.liveatc.net/search/?icao=" + icao.toLowerCase();
    try{
      const html = await fetchText(url);
      const feeds = extractFeedsFromAirportPage(html, icao);
      if(feeds.length === 0){
        saveDebugSample("noMounts_" + icao, html);
        console.log(icao + ": no feeds found");
      } else {
        output[icao] = feeds;
        console.log(icao + ": " + feeds.length + " feed(s) -> " + feeds.map((f) => f.mount).join(", "));
      }
      processed++;
    } catch(e){
      console.error(icao + ": FAILED (" + e.message + ")");
      failed++;
    }
    saveOutput(output); // checkpoint after every airport
    await sleep(DELAY_MS);
  }

  console.log("");
  console.log("Done. Processed " + processed + ", skipped (already cached) " + skipped + ", failed " + failed + ".");
  console.log("Wrote " + OUT_FILE);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
