#!/usr/bin/env node
"use strict";
/*
 * rebrand.js — build-time surgical rebrand of the bundled upstream core + frontend.
 *
 * WHY: CloudSpace ships an upstream subscription core + front-end fetched as compiled
 * release artifacts at Docker build time. We want the product to present only as
 * "CloudSpace" and to NOT leak the upstream "Sub-Store" identity to users or to anyone
 * scanning the image / API responses — WITHOUT breaking the core, because some
 * "Sub-Store" strings are FUNCTIONAL identifiers the core relies on:
 *   - SUB_STORE_* env var names (the core reads process.env.SUB_STORE_*)
 *   - cache/storage keys (#sub-store, .sub-store-*, x-sub-store-share-age-public-key)
 *   - gist sync identity descriptions ("Sub-Store Artifacts Repository",
 *     "Auto Generated Sub-Store Backup") — changing them loses the existing sync gist
 *   - the script-visible Platform field ("Sub-Store") that community scripts may check
 * Those are KEPT. Only user-visible / scan-visible self-identification is rewritten.
 *
 * The HTTP X-Powered-By header is handled OUTSIDE this script via the env var
 * SUB_STORE_X_POWERED_BY=CloudSpace (set in the Dockerfile) — no byte edit needed.
 *
 * Idempotent + drift-detecting: if an expected source string is absent AND its
 * replacement is also absent, the upstream format changed -> reported as DRIFT and
 * the script exits non-zero so the image build FAILS LOUDLY rather than silently
 * shipping an un-rebranded core.
 *
 * Usage:
 *   node rebrand.js --core <core-bundle.js> --frontend <frontend-dir>
 * Either flag may be omitted to skip that target.
 */

const fs = require("fs");
const path = require("path");

const PRODUCT = "CloudSpace"; // user-visible product name (unchanged)
const CORE_CODENAME = "cumulus"; // 底核 internal codename (logger prefix)

/* ---- core bundle rules: surgical, literal, anchored. Order: specific first. ---- */
const CORE_RULES = [
  // notify titles "🌍 Sub-Store ..." — emoji is \u{1F30D} (escaped text) in the bundle
  { find: "\\u{1F30D} Sub-Store", repl: "\\u{1F30D} " + PRODUCT, what: "notify titles" },
  // version banner: emit string + its parser regex (must change as a pair)
  { find: "Sub-Store -- v", repl: PRODUCT + " -- v", what: "version banner (emit)" },
  { find: "Sub-Store\\s+--\\s+v", repl: PRODUCT + "\\s+--\\s+v", what: "version banner (parser regex)" },
  // push fallback title default: title||"Sub-Store"  (leaves G1/Platform/X-Powered-By consts)
  { find: 'title||"Sub-Store"', repl: 'title||"' + PRODUCT + '"', what: "push fallback title" },
  // download filename prefixes: sub-store_data_ / _subscription_ / _collection_ / _file_
  { find: "sub-store_", repl: "cloudspace_", what: "download filename prefixes" },
  // internal logger name + its log-line parser regex (pair) -> [cumulus]
  { find: 'new Q1("sub-store")', repl: 'new Q1("' + CORE_CODENAME + '")', what: "logger name" },
  { find: "\\[sub-store\\]", repl: "\\[" + CORE_CODENAME + "\\]", what: "log parser regex" },
  // gist error/notify/log LABELS only ("找不到 Sub-Store Gist" etc.) — NOT a matching key
  // (the gist is matched by wl/G1 below, which we keep). Washing this hides it from logs.
  { find: "Sub-Store Gist", repl: PRODUCT + " Gist", what: "gist log/error labels" },
  // X-Powered-By default literal: the runtime header is already overridden by env
  // SUB_STORE_X_POWERED_BY=CloudSpace, but wash the on-disk default too for a clean bundle.
  { find: 'X_POWERED_BY")||"Sub-Store"', repl: 'X_POWERED_BY")||"' + PRODUCT + '"', what: "X-Powered-By default" },
];

// Functional identifiers that MUST survive rebrand (confirmed by usage analysis).
// Asserted present after rewrite; their loss fails the build.
const CORE_KEEP = [
  'G1="Sub-Store"', // gist artifact storage KEY: load(G1) / {[G1]:{content}}
  "Sub-Store Artifacts Repository", // gist sync identity (locate existing gist)
  "Auto Generated Sub-Store Backup", // gist backup desc
  'Platform:"Sub-Store"', // script-visible platform field (community-script compat)
];

function countOccurrences(hay, needle) {
  if (needle === "") return 0;
  return hay.split(needle).length - 1;
}

function rebrandCore(corePath) {
  console.log("[rebrand] core: " + corePath);
  let src = fs.readFileSync(corePath, "utf8");
  let changed = 0;
  const drift = [];
  for (const rule of CORE_RULES) {
    const n = countOccurrences(src, rule.find);
    if (n > 0) {
      src = src.split(rule.find).join(rule.repl);
      changed += n;
      console.log("  [ok]   " + rule.what + ": " + n + " replaced");
    } else if (countOccurrences(src, rule.repl) > 0) {
      console.log("  [skip] " + rule.what + ": already rebranded (idempotent)");
    } else {
      drift.push(rule.what + "  (anchor: " + rule.find + ")");
      console.log("  [DRIFT] " + rule.what + ": anchor NOT FOUND and not already rebranded");
    }
  }
  // assert functional identifiers survived
  const lost = [];
  for (const keep of CORE_KEEP) {
    if (countOccurrences(src, keep) === 0) lost.push(keep);
  }
  fs.writeFileSync(corePath, src);
  // transparency: show what capitalized "Sub-Store" remains (should be KEEP-list only)
  const residual = countOccurrences(src, "Sub-Store");
  console.log("  core: " + changed + " replacements; residual 'Sub-Store' (kept identifiers) = " + residual);
  if (lost.length) {
    console.error("  [FATAL] functional identifier(s) lost during rebrand: " + lost.join(", "));
  }
  return { drift, lost };
}

const FRONTEND_TEXT_EXT = new Set([".js", ".html", ".json", ".webmanifest", ".css", ".txt", ".vue"]);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function rebrandFrontend(frontendDir) {
  console.log("[rebrand] frontend: " + frontendDir);
  const files = walk(frontendDir, []);
  let total = 0;
  let touched = 0;
  let gzRemoved = 0;
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    // drop precompressed variants so served bytes match the rebranded plain files
    if (ext === ".gz" || ext === ".br") {
      fs.unlinkSync(f);
      gzRemoved++;
      continue;
    }
    if (!FRONTEND_TEXT_EXT.has(ext)) continue;
    let s = fs.readFileSync(f, "utf8");
    // Only capitalized display forms; leaves lowercase sub-store-* (cache keys) and
    // sub-store-org (upstream org slug in URLs) physically intact but product-hidden.
    const n = countOccurrences(s, "Sub-Store") + countOccurrences(s, "SubStore");
    if (n === 0) continue;
    s = s.split("Sub-Store").join(PRODUCT).split("SubStore").join(PRODUCT);
    fs.writeFileSync(f, s);
    total += n;
    touched++;
  }
  console.log("  frontend: " + total + " replacements across " + touched + " files; removed " + gzRemoved + " precompressed (.gz/.br)");
  return total;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--core") out.core = argv[++i];
    else if (argv[i] === "--frontend") out.frontend = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.core && !args.frontend) {
    console.error("usage: node rebrand.js --core <core-bundle.js> --frontend <frontend-dir>");
    process.exit(2);
  }
  let drift = [];
  let lost = [];
  if (args.core) {
    if (!fs.existsSync(args.core)) {
      console.error("[FATAL] core bundle not found: " + args.core);
      process.exit(1);
    }
    const r = rebrandCore(args.core);
    drift = drift.concat(r.drift);
    lost = lost.concat(r.lost);
  }
  if (args.frontend) {
    if (!fs.existsSync(args.frontend)) {
      console.error("[FATAL] frontend dir not found: " + args.frontend);
      process.exit(1);
    }
    rebrandFrontend(args.frontend);
  }
  if (lost.length) {
    console.error("[FATAL] rebrand removed functional identifier(s); aborting build.");
    process.exit(1);
  }
  if (drift.length) {
    console.error("[FATAL] upstream format drift — these anchors were not found:\n  - " + drift.join("\n  - "));
    console.error("Update scripts/rebrand.js anchors against the new upstream artifact before shipping.");
    process.exit(1);
  }
  console.log("[rebrand] done.");
}

main();
