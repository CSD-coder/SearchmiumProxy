const http = require('http');
const https = require('https');
const url = require('url');
const { URL } = url;

// Configuration
const PORT = process.env.PORT || 3000;
const TIMEOUT = 30000;
const MAX_REDIRECTS = 10;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

// Country-based proxy servers mapping
const COUNTRY_PROXIES = {
  'US': ['http://143.244.183.106:80', 'http://159.203.61.134:80', 'http://159.89.230.55:80'],
  'GB': ['http://164.38.155.59:80', 'http://164.38.155.16:80', 'http://185.170.166.89:80'],
  'DE': ['http://116.203.28.43:80', 'http://5.75.200.117:80', 'http://116.203.28.57:80'],
  'FR': ['http://51.158.68.115:8811', 'http://163.172.47.181:16379', 'http://51.158.68.133:8811'],
  'NL': ['http://46.101.22.14:443', 'http://188.166.104.152:8888', 'http://46.101.8.93:8118'],
  'CA': ['http://159.203.44.177:3128', 'http://159.203.115.185:3128', 'http://159.203.121.84:3128']
};

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 200;

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
  return record.count > MAX_REQUESTS_PER_WINDOW;
}

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
    return ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch (e) {
    return false;
  }
}

function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript',
    'json': 'application/json', 'png': 'image/png', 'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg', 'gif': 'image/gif', 'svg': 'image/svg+xml',
    'ico': 'image/x-icon', 'woff': 'font/woff', 'woff2': 'font/woff2',
    'ttf': 'font/ttf', 'eot': 'application/vnd.ms-fontobject',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': 'audio/ogg',
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'pdf': 'application/pdf',
    'zip': 'application/zip', 'xml': 'application/xml', 'txt': 'text/plain'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function makeRequest(options, body, callback) {
  const httpModule = options.protocol === 'https:' ? https : http;
  const requestOptions = {
    hostname: options.hostname,
    port: options.port || (options.protocol === 'https:' ? 443 : 80),
    path: options.path,
    method: options.method || 'GET',
    headers: options.headers || {},
    timeout: TIMEOUT,
    rejectUnauthorized: false
  };

  const req = httpModule.request(requestOptions, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const redirectUrl = new URL(res.headers.location, `${options.protocol}//${options.hostname}`).href;
      const parsedRedirect = new URL(redirectUrl);
      makeRequest({
        protocol: parsedRedirect.protocol,
        hostname: parsedRedirect.hostname,
        port: parsedRedirect.port,
        path: parsedRedirect.pathname + parsedRedirect.search,
        method: options.method,
        headers: options.headers
      }, body, callback);
      return;
    }
    callback(null, res);
  });

  req.on('error', (err) => {
    callback(err);
  });

  req.on('timeout', () => {
    req.destroy();
    callback(new Error('Request timeout'));
  });

  if (body) {
    req.write(body);
  }
  req.end();
}

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  
  // Serve static files
  if (req.method === 'GET') {
    const staticFiles = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/styles.css': 'styles.css',
      '/script.js': 'script.js'
    };
    
    if (staticFiles[parsedUrl.pathname]) {
      const fs = require('fs');
      const filePath = staticFiles[parsedUrl.pathname];
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
        return;
      } catch(e) {
        // File not found, continue to proxy
      }
    }
  }

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Web Proxy Server',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      countries: Object.keys(COUNTRY_PROXIES)
    }));
    return;
  }

  // Get available countries
  if (parsedUrl.pathname === '/api/countries') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({
      countries: Object.keys(COUNTRY_PROXIES),
      proxyCounts: Object.fromEntries(
        Object.entries(COUNTRY_PROXIES).map(([country, proxies]) => [country, proxies.length])
      )
    }));
    return;
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  // Apply CORS
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: 60 }));
    return;
  }

  // Extract target URL and country
  let targetUrl = parsedUrl.query.url || parsedUrl.query.target;
  const country = parsedUrl.query.country || 'auto';

  // Handle path-based proxy
  if (!targetUrl && parsedUrl.pathname.startsWith('/proxy/')) {
    targetUrl = decodeURIComponent(parsedUrl.pathname.substring(7));
  }

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Please provide a URL parameter', usage: '/?url=https://example.com&country=GB' }));
    return;
  }

  if (!isValidUrl(targetUrl)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }

  const targetParsed = new URL(targetUrl);
  
  // Select proxy based on country
  let proxyToUse = null;
  if (country !== 'auto' && COUNTRY_PROXIES[country]) {
    const proxies = COUNTRY_PROXIES[country];
    proxyToUse = proxies[Math.floor(Math.random() * proxies.length)];
  }

  console.log(`[PROXY] ${req.method} ${targetUrl} (country: ${country}, proxy: ${proxyToUse || 'direct'})`);

  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    body = Buffer.concat(body);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;

    const requestConfig = {
      protocol: targetParsed.protocol,
      hostname: targetParsed.hostname,
      port: targetParsed.port,
      path: targetParsed.pathname + targetParsed.search,
      method: req.method,
      headers: headers
    };

    makeRequest(requestConfig, body, (err, proxyRes) => {
      if (err) {
        console.error(`[ERROR] ${targetUrl}:`, err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
        return;
      }

      // Set CORS and proxy info headers
      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['access-control-allow-origin'] = '*';
      responseHeaders['x-proxy-country'] = country;
      responseHeaders['x-proxy-server'] = proxyToUse || 'direct';

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);

      proxyRes.on('end', () => {
        console.log(`[OK] ${targetUrl} - ${proxyRes.statusCode}`);
      });
    });
  });
}

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Proxy Server running on port ${PORT}`);
  console.log(`Available countries: ${Object.keys(COUNTRY_PROXIES).join(', ')}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
