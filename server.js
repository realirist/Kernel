const express = require("express");
const cors = require("cors");
const net = require("net");
const { URL } = require("url");
const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");

// Use native AbortController if available (Node 16+), otherwise use polyfill
const AbortController = globalThis.AbortController || require("abort-controller");

// For Node.js < 18, you might need to install node-fetch
// npm install node-fetch@2
// const fetch = require('node-fetch');
// const { Headers } = require('node-fetch');

// For Node.js >= 18, fetch is built-in but might need to be imported
// const { fetch, Headers } = require('node-fetch'); // if using node-fetch
// or for Node 18+:
// global.fetch = fetch; // if fetch isn't global

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const FIREBASE_URL = "https://kernel-websockets-default-rtdb.firebaseio.com/websockets.json";

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

// Generate UUID for WebSocket connections
const generateWebSocketUUID = () => {
  const randomPart = () => {
    const num = Math.floor(Math.random() * 4294967296); // 0-4294967295
    return num.toString(16).padStart(8, '0');
  };
  
  return `UUID-WS-${randomPart()}-${randomPart()}-${randomPart()}-${randomPart()}`;
};

// Firebase operations
const updateFirebase = async (uuid, value) => {
  try {
    const response = await fetch(`${FIREBASE_URL}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        [uuid]: value
      })
    });
    
    if (!response.ok) {
      throw new Error(`Firebase update failed: ${response.status}`);
    }
    
    console.log(`Firebase updated: ${uuid} = ${value}`);
  } catch (error) {
    console.error(`Firebase update error for ${uuid}:`, error.message);
  }
};

const waitForFirebaseNull = async (uuid) => {
  const checkInterval = 1000; // Check every second
  const maxAttempts = 300; // 5 minutes maximum
  let attempts = 0;
  
  return new Promise((resolve) => {
    const checkFirebase = async () => {
      try {
        attempts++;
        const response = await fetch(`${FIREBASE_URL}`);
        const data = await response.json();
        
        if (!data || data[uuid] === null || data[uuid] === undefined) {
          console.log(`Firebase ${uuid} is null, resolving`);
          resolve();
          return;
        }
        
        if (attempts >= maxAttempts) {
          console.log(`Firebase ${uuid} timeout after ${maxAttempts} attempts`);
          resolve();
          return;
        }
        
        setTimeout(checkFirebase, checkInterval);
      } catch (error) {
        console.error(`Firebase check error for ${uuid}:`, error.message);
        resolve();
      }
    };
    
    checkFirebase();
  });
};

// WebSocket proxy handling
const handleWebSocketProxy = (ws, targetUrl) => {
  const uuid = generateWebSocketUUID();
  console.log(`New WebSocket connection: ${uuid} -> ${targetUrl}`);
  
  let targetWs;
  let messageQueue = [];
  let isProcessingQueue = false;
  
  const cleanup = async () => {
    console.log(`Cleaning up WebSocket ${uuid}`);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.close();
    }
    
    // Set Firebase to null when closing
    await updateFirebase(uuid, null);
  };
  
  const processMessageQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (messageQueue.length > 0) {
      const message = messageQueue.shift();
      
      // Generate random hex value
      const randomValue = Math.floor(Math.random() * 4294967296).toString(16);
      
      // Update Firebase with the message data
      await updateFirebase(uuid, randomValue);
      
      // Wait for Firebase to be set to null
      await waitForFirebaseNull(uuid);
      
      // Forward the message to target WebSocket
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(message);
      }
    }
    
    isProcessingQueue = false;
  };
  
  // Connect to target WebSocket
  try {
    targetWs = new WebSocket(targetUrl);
    
    targetWs.on('open', () => {
      console.log(`Connected to target WebSocket: ${targetUrl}`);
    });
    
    targetWs.on('message', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
    
    targetWs.on('close', () => {
      console.log(`Target WebSocket closed: ${targetUrl}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      cleanup();
    });
    
    targetWs.on('error', (error) => {
      console.error(`Target WebSocket error: ${error.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      cleanup();
    });
    
  } catch (error) {
    console.error(`Failed to connect to target WebSocket: ${error.message}`);
    ws.close();
    cleanup();
    return;
  }
  
  // Handle messages from client
  ws.on('message', async (data) => {
    messageQueue.push(data);
    processMessageQueue();
  });
  
  ws.on('close', () => {
    console.log(`Client WebSocket closed: ${uuid}`);
    cleanup();
  });
  
  ws.on('error', (error) => {
    console.error(`Client WebSocket error: ${error.message}`);
    cleanup();
  });
};

// WebSocket server
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = url.searchParams.get('target');
  
  if (!targetUrl) {
    console.log('WebSocket connection without target URL');
    ws.close(1008, 'Missing target URL parameter');
    return;
  }
  
  try {
    // Validate target URL
    new URL(targetUrl);
    if (!targetUrl.startsWith('ws://') && !targetUrl.startsWith('wss://')) {
      throw new Error('Invalid WebSocket URL scheme');
    }
    
    handleWebSocketProxy(ws, targetUrl);
  } catch (error) {
    console.error(`Invalid target URL: ${error.message}`);
    ws.close(1008, 'Invalid target URL');
  }
});

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
    
    console.log(`${method} ${url}`);
    
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
    const forwardHeaders = {};
    Object.entries(browserHeaders).forEach(([k, v]) => forwardHeaders[k] = v);
    Object.entries(clientHeaders).forEach(([k, v]) => forwardHeaders[k] = v);
    
    let fetchBody = null;
    if (!["GET", "HEAD"].includes(upperMethod) && clientBody !== undefined) {
      fetchBody = typeof clientBody === "object" ? JSON.stringify(clientBody) : clientBody.toString();
      if (!forwardHeaders["Content-Type"]) forwardHeaders["Content-Type"] = "application/json";
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    
    console.log(`Fetching: ${url}`);
    const fetchResponse = await fetch(url, {
      method: upperMethod,
      headers: forwardHeaders,
      body: fetchBody,
      redirect: "follow",
      signal: controller.signal,
    });
    
    console.log(`Response status: ${fetchResponse.status}`);
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
    
    // Handle response body - node-fetch v2 compatible
    let responseBody;
    const contentType = fetchResponse.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      responseBody = await fetchResponse.json();
    } else if (contentType.includes('text/') || contentType.includes('application/xml')) {
      responseBody = await fetchResponse.text();
    } else {
      // For binary data or unknown types, use arrayBuffer
      const arrayBuffer = await fetchResponse.arrayBuffer();
      responseBody = Buffer.from(arrayBuffer);
    }
    
    if (upperMethod === "GET") {
      cache.set(url, {
        status: fetchResponse.status,
        headers: Object.fromEntries(fetchResponse.headers.entries()),
        body: responseBody,
      });
    }
    
    res.send(responseBody);
    
  } catch (err) {
    if (err.name === "AbortError") return res.status(504).send("Upstream request timed out");
    return res.status(502).send(`Fetch failed: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Hella fast proxy running on port ${PORT}`);
  console.log(`Ready for Fiddler Everywhere integration`);
  console.log(`Supports: GET, POST, PUT, DELETE, OPTIONS, CONNECT, WebSocket`);
  console.log(`WebSocket usage: ws://localhost:${PORT}/?target=ws://example.com/websocket`);
});
