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
const FIREBASE_URL = "https://kernel-websockets-default-rtdb.firebaseio.com/websockets";

app.use(cors());
app.use(express.json());
app.options("/proxy", (req, res) => res.sendStatus(204));

const getBrowserHeaders = (userAgent = 'Kernel') => ({
  'User-Agent': userAgent,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Cache-Control': 'max-age=0',
  'Accept-Encoding': 'identity'
});

const cache = new Map();

// Store active WebSocket connections by UUID
const activeWebSockets = new Map();

// Generate UUID for WebSocket connections
const generateWebSocketUUID = () => {
  const randomPart = () => {
    const num = Math.floor(Math.random() * 4294967296); // 0-4294967295
    return num.toString(16).padStart(8, '0');
  };
  
  return `UUID-WS-${randomPart()}-${randomPart()}-${randomPart()}-${randomPart()}`;
};

// Firebase operations
const updateFirebase = async (uuid, message) => {
  try {
    // Convert message to base64
    const base64Message = Buffer.from(message).toString('base64');
    
    const response = await fetch(`${FIREBASE_URL}/${uuid}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(base64Message)
    });
    
    if (!response.ok) {
      throw new Error(`Firebase update failed: ${response.status}`);
    }
    
    console.log(`Firebase updated: ${uuid} with message`);
  } catch (error) {
    console.error(`Firebase update error for ${uuid}:`, error.message);
  }
};

const waitForFirebaseNull = async (uuid) => {
  const checkInterval = 500; // Check every 500ms
  const maxAttempts = 600; // 5 minutes maximum
  let attempts = 0;
  
  return new Promise((resolve) => {
    const checkFirebase = async () => {
      try {
        attempts++;
        const response = await fetch(`${FIREBASE_URL}/${uuid}.json`);
        const data = await response.json();
        
        if (data === null || data === undefined) {
          console.log(`Firebase ${uuid} is null, processing next message`);
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

// WebSocket proxy handling - removed since not needed

// Store pending WebSocket connections
const pendingConnections = new Map();

// WebSocket endpoint - POST to create connection
app.post('/proxy/websocket', (req, res) => {
  try {
    const { url: targetUrl } = req.body;
    
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing "url" in request body' });
    }
    
    // Validate target URL
    new URL(targetUrl);
    if (!targetUrl.startsWith('ws://') && !targetUrl.startsWith('wss://')) {
      return res.status(400).json({ error: 'Invalid WebSocket URL scheme' });
    }
    
    const uuid = generateWebSocketUUID();
    
    // Connect to WebSocket immediately and start processing
    try {
      const targetWs = new WebSocket(targetUrl);
      handleWebSocketConnection(targetWs, uuid);
      
      console.log(`WebSocket connection started: ${uuid} -> ${targetUrl}`);
      res.json({ uuid });
      
    } catch (error) {
      console.error(`WebSocket connection failed: ${error.message}`);
      res.status(500).json({ error: 'Failed to connect to WebSocket' });
    }
    
  } catch (error) {
    console.error(`WebSocket setup error: ${error.message}`);
    res.status(400).json({ error: `Invalid target URL: ${error.message}` });
  }
});

// WebSocket message sending endpoint - PUT to send message
app.put('/proxy/websockets', (req, res) => {
  try {
    const { uuid, message } = req.body;
    
    if (!uuid) {
      return res.status(400).json({ error: 'Missing "uuid" in request body' });
    }
    
    if (!message) {
      return res.status(400).json({ error: 'Missing "message" in request body' });
    }
    
    // Check if WebSocket connection exists
    if (!activeWebSockets.has(uuid)) {
      return res.status(404).json({ error: 'WebSocket connection not found' });
    }
    
    const targetWs = activeWebSockets.get(uuid);
    
    // Check if WebSocket is still open
    if (targetWs.readyState !== WebSocket.OPEN) {
      activeWebSockets.delete(uuid);
      return res.status(400).json({ error: 'WebSocket connection is not open' });
    }
    
    try {
      // Decode base64 message
      const decodedMessage = Buffer.from(message, 'base64');
      
      // Send raw message to WebSocket
      targetWs.send(decodedMessage);
      
      console.log(`Message sent to WebSocket ${uuid}`);
      res.json({ success: true, message: 'Message sent successfully' });
      
    } catch (decodeError) {
      console.error(`Failed to decode message for ${uuid}:`, decodeError.message);
      res.status(400).json({ error: 'Invalid base64 message' });
    }
    
  } catch (error) {
    console.error(`WebSocket send error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// WebSocket connection closing endpoint - DELETE to close connection
app.delete('/proxy/websockets', (req, res) => {
  try {
    const { uuid } = req.body;
    
    if (!uuid) {
      return res.status(400).json({ error: 'Missing "uuid" in request body' });
    }
    
    // Check if WebSocket connection exists
    if (!activeWebSockets.has(uuid)) {
      return res.status(404).json({ error: 'WebSocket connection not found' });
    }
    
    const targetWs = activeWebSockets.get(uuid);
    
    // Close the WebSocket connection
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close();
      console.log(`WebSocket connection ${uuid} closed by client request`);
    }
    
    // Remove from active connections (cleanup will be handled by the close event)
    activeWebSockets.delete(uuid);
    
    res.json({ success: true, message: 'WebSocket connection closed successfully' });
    
  } catch (error) {
    console.error(`WebSocket close error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const handleWebSocketConnection = (targetWs, uuid) => {
  let messageQueue = [];
  let isProcessingQueue = false;
  
  // Store the WebSocket connection
  activeWebSockets.set(uuid, targetWs);
  
  const cleanup = async () => {
    console.log(`Cleaning up WebSocket ${uuid}`);
    
    // Remove from active connections
    activeWebSockets.delete(uuid);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.close();
    }
    
    // Set Firebase to null when closing
    try {
      await fetch(`${FIREBASE_URL}/${uuid}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(null)
      });
    } catch (error) {
      console.error(`Cleanup error for ${uuid}:`, error.message);
    }
  };
  
  const processMessageQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (messageQueue.length > 0) {
      const message = messageQueue.shift();
      
      // Update Firebase with the base64 message
      await updateFirebase(uuid, message);
      
      // Wait for Firebase to be set to null (client consumed it)
      await waitForFirebaseNull(uuid);
    }
    
    isProcessingQueue = false;
  };
  
  targetWs.on('open', () => {
    console.log(`Connected to target WebSocket for ${uuid}`);
  });
  
  targetWs.on('message', (data) => {
    // Queue messages from target WebSocket
    messageQueue.push(data);
    processMessageQueue();
  });
  
  targetWs.on('close', () => {
    console.log(`Target WebSocket closed for ${uuid}`);
    cleanup();
  });
  
  targetWs.on('error', (error) => {
    console.error(`Target WebSocket error for ${uuid}:`, error.message);
    cleanup();
  });
};

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
    
    // Get UserAgent from query parameters, default to 'Kernel' if not present or blank
    const userAgent = req.query.UserAgent || 'Kernel';
    
    console.log(`${method} ${url} (UserAgent: ${userAgent})`);
    
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
    
    const browserHeaders = getBrowserHeaders(userAgent);
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
  console.log(`WebSocket usage:`);
  console.log(`  - Create connection: POST /proxy/websocket with {"url": "ws://example.com"}`);
  console.log(`  - Send message: PUT /proxy/websockets with {"uuid": "UUID-WS-...", "message": "base64encodedmessage"}`);
  console.log(`Messages from server will be queued to Firebase at /websockets/{uuid} as base64`);
  console.log(`UserAgent parameter: Add ?UserAgent=YourUserAgent to /proxy (defaults to 'Kernel')`);
});
