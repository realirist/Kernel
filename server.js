const express = require("express");
const cors = require("cors");
const net = require("net");
const { URL } = require("url");
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
  'Cache-Control': 'max-age=0',
  'Accept-Encoding': 'identity'
});

const cache = new Map();

// Handle CONNECT method for HTTP tunneling
const handleConnect = (req, res, target) => {
  return new Promise((resolve, reject) => {
    try {
      // Parse target host:port
      const [hostname, portStr] = target.split(':');
      const port = parseInt(portStr) || 443; // Default to 443 for HTTPS
      
      // Create connection to target server
      const targetSocket = net.createConnection(port, hostname);
      
      targetSocket.on('connect', () => {
        // Send 200 Connection Established response
        res.writeHead(200, 'Connection Established', {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, CONNECT',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        
        // Pipe data between client and target
        req.socket.pipe(targetSocket);
        targetSocket.pipe(req.socket);
        
        resolve();
      });
      
      targetSocket.on('error', (err) => {
        reject(new Error(`Target connection failed: ${err.message}`));
      });
      
      // Handle cleanup
      const cleanup = () => {
        if (!targetSocket.destroyed) targetSocket.destroy();
        if (!req.socket.destroyed) req.socket.destroy();
      };
      
      req.socket.on('error', cleanup);
      targetSocket.on('error', cleanup);
      req.socket.on('close', cleanup);
      targetSocket.on('close', cleanup);
      
      // Set timeout for connection
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Connection timeout'));
      }, 10000);
      
      targetSocket.on('connect', () => clearTimeout(timeout));
      
    } catch (err) {
      reject(err);
    }
  });
};

app.all("/proxy", async (req, res) => {
  try {
    const { method, url, headers: clientHeaders = {}, body: clientBody } = req.body;
    
    if (!method || !url) return res.status(400).send('Missing "method" or "url" in request body');
    if (url.startsWith(`${req.protocol}://${req.get("host")}`)) return res.status(400).send("Proxying to self is not allowed");
    
    const upperMethod = method.toUpperCase();
    
    // Handle CONNECT method
    if (upperMethod === "CONNECT") {
      console.log(`CONNECT request to: ${url}`);
      try {
        await handleConnect(req, res, url);
        console.log(`CONNECT tunnel established to: ${url}`);
        return;
      } catch (err) {
        console.error(`CONNECT failed for ${url}:`, err.message);
        return res.status(502).send(`CONNECT failed: ${err.message}`);
      }
    }
    
    // Handle caching for GET requests
    if (upperMethod === "GET" && cache.has(url)) {
      const cached = cache.get(url);
      res.set(cached.headers);
      return res.status(cached.status).send(cached.body);
    }
    
    const browserHeaders = getBrowserHeaders();
    const forwardHeaders = new fetch.Headers();
    Object.entries(browserHeaders).forEach(([k, v]) => forwardHeaders.set(k, v));
    Object.entries(clientHeaders).forEach(([k, v]) => forwardHeaders.set(k, v));
    
    let fetchBody = null;
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, CONNECT");
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

app.listen(PORT, () => {
  console.log(`Hella fast proxy running on port ${PORT}`);
  console.log(`Ready for Fiddler Everywhere integration`);
  console.log(`Supports: GET, POST, PUT, DELETE, OPTIONS, CONNECT`);
});
