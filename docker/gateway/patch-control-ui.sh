#!/bin/sh
# Build-time patch for the OpenClaw Control UI: default its language to English.
#
# The Control UI has no server-side locale setting. On load it uses the locale
# persisted in localStorage["openclaw.i18n.locale"] and otherwise falls back to
# the browser's navigator.language — so a browser set to e.g. zh-CN gets a
# Chinese UI by default. This injects an inline script into index.html that
# seeds that key to "en" when it is not set yet. Users can still pick another
# language in the UI's Quick Settings; that choice is persisted and honoured.
#
# The gateway computes CSP sha256 hashes for every inline <script> in the HTML
# it serves, so the injected block is allowed without touching the CSP.
set -e
INDEX="$(npm root -g)/openclaw/dist/control-ui/index.html"
node - "$INDEX" <<'JS'
const fs = require("fs");
const file = process.argv[2];
let html = fs.readFileSync(file, "utf8");
const marker = "data-clawhuddle-default-locale";
if (html.includes(marker)) process.exit(0);
const snippet = [
  `<script ${marker}>`,
  `      // ClawHuddle: default the Control UI language to English instead of the browser locale.`,
  `      try {`,
  `        if (!localStorage.getItem("openclaw.i18n.locale")) localStorage.setItem("openclaw.i18n.locale", "en");`,
  `      } catch (e) {}`,
  `    </script>`,
].join("\n");
if (!html.includes("<head>")) throw new Error(`no <head> in ${file}`);
html = html.replace("<head>", `<head>\n    ${snippet}`);
fs.writeFileSync(file, html);
console.log(`patched ${file}`);
JS
