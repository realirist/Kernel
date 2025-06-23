const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const AbortController = require("abort-controller");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.options("/proxy", (req, res) => res.sendStatus(204));

const getBrowserHeaders = () => ({
  'User-Agent': 'Kernel',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Cache-Control': 'max-age=0'
});

const cache = new Map();

app.all("/proxy", async (req, res) => {
  try {
    const { method, url, headers: clientHeaders = {}, body: clientBody } = req.body;
    if (!method || !url) return res.status(400).send('Missing "method" or "url" in request body');
    if (url.startsWith(`${req.protocol}://${req.get("host")}`)) return res.status(400).send("Proxying to self is not allowed");
    if (method.toUpperCase() === "GET" && cache.has(url)) {
      const cached = cache.get(url);
      res.set(cached.headers);
      return res.status(cached.status).send(cached.body);
    }
    const browserHeaders = getBrowserHeaders();
    const forwardHeaders = new fetch.Headers();
    Object.entries(browserHeaders).forEach(([k, v]) => forwardHeaders.set(k, v));
    Object.entries(clientHeaders).forEach(([k, v]) => forwardHeaders.set(k, v));
    let fetchBody = null;
    const upperMethod = method.toUpperCase();
    if (!["GET", "HEAD"].includes(upperMethod) && clientBody !== undefined) {
      fetchBody = typeof clientBody === "object" ? JSON.stringify(clientBody) : clientBody.toString();
      if (!forwardHeaders.has("Content-Type")) forwardHeaders.set("Content-Type", "application/json");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const fetchResponse = await fetch(url, {
      method: upperMethod,
      headers: forwardHeaders,
      body: fetchBody,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    res.status(fetchResponse.status);
    fetchResponse.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (upperMethod === "GET") {
      const chunks = [];
      fetchResponse.body.on("data", chunk => chunks.push(chunk));
      fetchResponse.body.on("end", () => {
        const fullBody = Buffer.concat(chunks);
        cache.set(url, {
          status: fetchResponse.status,
          headers: Object.fromEntries(fetchResponse.headers.entries()),
          body: fullBody,
        });
      });
      fetchResponse.body.pipe(res);
    } else {
      fetchResponse.body.pipe(res);
    }
  } catch (err) {
    if (err.name === "AbortError") return res.status(504).send("Upstream request timed out");
    return res.status(502).send(`Fetch failed: ${err.message}`);
  }
});

app.listen(PORT, () => console.log(`Hella fast proxy running on port ${PORT}`));
