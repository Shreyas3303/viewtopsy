#!/usr/bin/env node
// Serves the Viewtopsy web app at http://localhost:8000 (no dependencies).
// Needed for the beta "Connect with Twitch" feature: Twitch can only send you
// back to an http(s) address, not to a page opened as a file.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "frontend");
const port = Number(process.env.PORT) || 8000;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }).end(data);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Viewtopsy is running at http://localhost:${port}/  (Ctrl+C to stop)`);
  });
