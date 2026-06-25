"use strict";

const fs = require("node:fs");
const path = require("node:path");

const localPath = path.join(__dirname, "node_modules", "dorita980", "lib", "v2", "local.js");
if (!fs.existsSync(localPath)) {
  process.exit(0);
}

const needle = "connectTimeout: customOptions.connectTimeout";
let source = fs.readFileSync(localPath, "utf8");
if (source.includes(needle)) {
  process.exit(0);
}

source = source.replace(
  "port: customOptions.port || 8883,",
  [
    "connectTimeout: customOptions.connectTimeout || 15000,",
    "reconnectPeriod: customOptions.reconnectPeriod ?? 0,",
    "port: customOptions.port || 8883,",
  ].join("\n    "),
);
fs.writeFileSync(localPath, source);