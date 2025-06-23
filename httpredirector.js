const express = require("express");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.options("/proxy", (req, res) => res.sendStatus(204));
const getBrowserHeaders = () => ({
  'User-Agent': 'Kernel',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0'
});
app.all("/proxy", async (req, res) => {
  try {
    const { method, url, headers: clientHeaders = {}, body: clientBody } = req.body;
    if (!method || !url) {
      return res.status(400).send('Missing "method" or "url" in request body');
    }
    if (url.startsWith(`${req.protocol}://${req.get("host")}`)) {
      return res.status(400).send("Proxying to self is not allowed");
    }
    const browserHeaders = getBrowserHeaders();
    const forwardHeaders = new fetch.Headers();
    Object.entries(browserHeaders).forEach(([key, value]) => {
      forwardHeaders.set(key, value);
    });
    Object.entries(clientHeaders).forEach(([key, value]) => {
      forwardHeaders.set(key, value);
    });
    let fetchBody = null;
    const upperMethod = method.toUpperCase();
    
    if (!["GET", "HEAD"].includes(upperMethod)) {
      if (clientBody !== undefined) {
        fetchBody = typeof clientBody === "object" ? JSON.stringify(clientBody) : clientBody.toString();
        if (!forwardHeaders.has("Content-Type")) {
          forwardHeaders.set("Content-Type", "application/json");
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const fetchResponse = await fetch(url, {
      method: upperMethod,
      headers: forwardHeaders,
      body: fetchBody,
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    
    const responseBuffer = await fetchResponse.buffer();
    const responseHeaders = {};
    
    fetchResponse.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    responseHeaders["Access-Control-Allow-Origin"] = "*";
    responseHeaders["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    responseHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    
    res.status(fetchResponse.status).set(responseHeaders).send(responseBuffer);
    
  } catch (err) {
    console.error('Proxy error:', err.message);
    
    if (err.name === "AbortError") {
      return res.status(504).send("Upstream request timed out");
    }
    
    return res.status(502).send(`Fetch failed: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Enhanced proxy running on port ${PORT}`);
});
