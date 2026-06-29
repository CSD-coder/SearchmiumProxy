const http = require('http');
const https = require('https');
const url = require('url');
const { URL } = url;

// Configuration - Use Render's PORT environment variable
const PORT = process.env.PORT || 3000;
const TIMEOUT = 15000;
const MAX_REDIRECTS = 5;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin, User-Agent',
  'Access-Control-Max-Age': '86400'
};

// Blocklist for dangerous/malicious patterns
const BLOCKLIST_PATTERNS = [
  /javascript:/i,
  /data:text\/html/i,
  /file:\/\/\//i,
  /<script/i,
  /onerror=/i,
  /onload=/i
];

// Rate limiting (simple in-memory implementation)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 100;

function isRateLimited(clientIp) {
  const now = Date.now();
  if (!rateLimitMap.has(clientIp)) {
    rateLimitMap.set(clientIp, { count: 1, startTime: now });
    return false;
  }
  
  const record = rateLimitMap.get(clientIp);
  if (now - record.startTime > RATE_LIMIT_WINDOW) {
    record.count = 1;
    record.startTime = now;
    return false;
  }
  
  record.count++;
  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  return false;
}

// Clean up rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.startTime > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

function isValidUrl(urlString) {
  try {
    const parsedUrl = new URL(urlString);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }
    
    for (const pattern of BLOCKLIST_PATTERNS) {
      if (pattern.test(parsedUrl.href)) {
        return false;
      }
    }
    
    return true;
  } catch (e) {
    return false;
  }
}

function sanitizeHeaders(headers) {
  const sanitized = {};
  const allowedHeaders = [
    'accept', 'accept-language', 'content-type', 'user-agent',
    'authorization', 'cookie', 'referer', 'x-requested-with',
    'cache-control', 'pragma', 'dnt', 'range'
  ];
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (allowedHeaders.includes(lowerKey)) {
      if (!['host', 'connection', 'transfer-encoding', 'upgrade'].includes(lowerKey)) {
        sanitized[key] = value;
      }
    }
  }
  
  return sanitized;
}

function createProxyRequest(targetUrl, method, headers, body, callback, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    callback(new Error('Too many redirects'));
    return;
  }
  
  const parsedUrl = new URL(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  
  const requestHeaders = sanitizeHeaders(headers);
  requestHeaders.host = parsedUrl.hostname;
  
  const requestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: method,
    headers: requestHeaders,
    timeout: TIMEOUT,
    rejectUnauthorized: true // Secure in production
  };
  
  const proxyReq = httpModule.request(requestOptions, (proxyRes) => {
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
      const location = proxyRes.headers.location;
      if (location) {
        try {
          const redirectUrl = new URL(location, targetUrl).href;
          createProxyRequest(redirectUrl, method, headers, body, callback, redirectCount + 1);
          return;
        } catch (e) {
          callback(new Error('Invalid redirect URL'));
          return;
        }
      }
    }
    
    callback(null, proxyRes);
  });
  
  proxyReq.on('error', (err) => {
    callback(err);
  });
  
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    callback(new Error('Request timeout'));
  });
  
  if (body && body.length > 0) {
    proxyReq.write(body);
  }
  
  proxyReq.end();
}

// Single request handler for both proxy and health check
function handleRequest(req, res) {
  // Parse the URL
  const parsedUrl = url.parse(req.url, true);
  
  // Health check endpoint
  if ((parsedUrl.pathname === '/health' || parsedUrl.pathname === '/') && 
      req.method === 'GET' && !parsedUrl.query.url) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Web Proxy Server',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      endpoints: {
        proxy: '/?url=https://example.com',
        proxyPath: '/proxy/https://example.com',
        health: '/health'
      }
    }));
    return;
  }
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }
  
  // Apply CORS headers to all responses
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  
  // Rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter: 60
    }));
    return;
  }
  
  // Check method
  if (!ALLOWED_METHODS.includes(req.method)) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  
  // Extract target URL from query parameters
  let targetUrl = parsedUrl.query.url || parsedUrl.query.target || parsedUrl.query.quest;
  
  // Handle path-based proxy requests (e.g., /proxy/http://example.com)
  if (!targetUrl && parsedUrl.pathname.startsWith('/proxy/')) {
    targetUrl = decodeURIComponent(parsedUrl.pathname.substring(7));
  }
  
  // Handle requests where the full URL is in the path
  if (!targetUrl) {
    targetUrl = decodeURIComponent(req.url.substring(1));
    if (targetUrl && !targetUrl.startsWith('http')) {
      targetUrl = null;
    }
  }
  
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Bad Request',
      message: 'Please provide a target URL. Example: /?url=https://example.com'
    }));
    return;
  }
  
  if (!isValidUrl(targetUrl)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Invalid URL',
      message: 'The provided URL is invalid or blocked'
    }));
    return;
  }
  
  console.log(`[PROXY] ${req.method} ${targetUrl} (from ${clientIp})`);
  
  // Collect request body
  let body = [];
  req.on('data', (chunk) => {
    body.push(chunk);
  });
  
  req.on('end', () => {
    body = Buffer.concat(body);
    
    createProxyRequest(targetUrl, req.method, req.headers, body, (err, proxyRes) => {
      if (err) {
        console.error(`[PROXY ERROR] ${targetUrl}: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Proxy Error',
          message: err.message
        }));
        return;
      }
      
      // Set CORS headers before copying response headers
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        proxyRes.headers[key] = value;
      }
      
      // Copy status and headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      
      // Stream the response
      proxyRes.pipe(res);
      
      // Log completion
      proxyRes.on('end', () => {
        console.log(`[PROXY COMPLETE] ${targetUrl} - ${proxyRes.statusCode}`);
      });
      
      // Handle errors during streaming
      proxyRes.on('error', (streamErr) => {
        console.error(`[STREAM ERROR] ${targetUrl}: ${streamErr.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Stream Error',
            message: 'Error while streaming response'
          }));
        }
      });
    });
  });
}

// Create the server with single request handler
const server = http.createServer(handleRequest);

// Start listening
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Proxy Server running on port ${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`Allowed methods: ${ALLOWED_METHODS.join(', ')}`);
  console.log(`Timeout: ${TIMEOUT}ms`);
  console.log(`Rate limit: ${MAX_REQUESTS_PER_WINDOW} requests/min`);
});

// Graceful shutdown
function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = server;
