#!/usr/bin/env node
// Writes the demo chat used by the web app to data/chat/example.json,
// so the Python CLI can be tried on exactly the same stream.
const fs = require("fs");
const path = require("path");
const { generateSampleChat } = require("../frontend/sample.js");

const out = path.join(__dirname, "..", "data", "chat", "example.json");
fs.writeFileSync(out, JSON.stringify(generateSampleChat()) + "\n");
console.log(`Wrote ${out}`);
