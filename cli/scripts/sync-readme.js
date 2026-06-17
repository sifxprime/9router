#!/usr/bin/env node
// Sync the root README.md to cli/README.md so the npm package page shows the
// same content as GitHub. Rewrites relative paths (./images/, ./public/,
// ./i18n/, ./CHANGELOG.md) to absolute GitHub URLs because npmjs.com can't
// resolve relative links against the source repo.
//
// Run automatically via cli/package.json's prepublishOnly hook (chained with
// `node scripts/build-cli.js`).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC  = path.join(ROOT, "README.md");
const DST  = path.join(ROOT, "cli", "README.md");

// Branch we serve content from. Has to match what readers see when they land
// on https://github.com/sifxprime/krouter — kept here as a single constant so
// changing the default branch only needs an edit in one place.
const RAW_BASE  = "https://raw.githubusercontent.com/sifxprime/krouter/main";
const BLOB_BASE = "https://github.com/sifxprime/krouter/blob/main";

let md = fs.readFileSync(SRC, "utf8");

// Images: <img src="./..."> + ![alt](./...) → raw.githubusercontent.com URL
md = md.replace(/src="\.\/([^"]+\.(?:png|svg|jpg|jpeg|gif|webp))"/g, `src="${RAW_BASE}/$1"`);
md = md.replace(/!\[([^\]]*)\]\(\.\/([^)]+\.(?:png|svg|jpg|jpeg|gif|webp))\)/g, `![$1](${RAW_BASE}/$2)`);

// Other anchors: ./CHANGELOG.md, ./i18n/..., etc. — point at GitHub's blob view
md = md.replace(/href="\.\/([^"]+)"/g, `href="${BLOB_BASE}/$1"`);
md = md.replace(/\]\(\.\/([^)]+)\)/g, `](${BLOB_BASE}/$1)`);

// Header banner: add a short "Installed from npm? Full docs on GitHub" hint
// right after the title block so npm visitors know the canonical home.
const NPM_NOTE = `\n> **You're viewing this on npm.** Full docs, screenshots, and changelog: [github.com/sifxprime/krouter](https://github.com/sifxprime/krouter).\n`;
md = md.replace(/^(---\n)/m, NPM_NOTE + "\n$1");

fs.writeFileSync(DST, md);
console.log(`✅ Synced README → cli/README.md (${md.length.toLocaleString()} chars, paths absolutized for npm)`);
