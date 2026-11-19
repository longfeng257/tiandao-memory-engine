import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const allowed = new Set(["index.js", "memory-engine.js", "task-gate.js", "recovery-store.js", "history-builder.js", "style.css", "tests/fixtures/widget-preview.html"]);
const server = http.createServer(async (request, response) => {
    let path;
    try { path = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "tests/fixtures/widget-preview.html"; }
    catch { response.writeHead(400); response.end("Invalid path"); return; }
    if (!allowed.has(path)) { response.writeHead(404); response.end("Not found"); return; }
    try {
        const content = await readFile(fileURLToPath(new URL(path, root)));
        response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(content);
    } catch { response.writeHead(500); response.end("Preview failed"); }
});
server.listen(17851, "127.0.0.1", () => console.log("Widget fixture: http://127.0.0.1:17851"));
