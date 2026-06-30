const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { URL } = url;

const PORT = process.env.PORT || 3000;
const TIMEOUT = 30000;
const MAX_REDIRECTS = 10;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.xml': 'application/xml',
  '.txt': 'text/plain'
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isValidUrl(urlString) {
  try {
    const parsedUrl = new URL(urlString);
    return ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch (e) {
    return false;
  }
}

function makeRequest(targetUrl, method, headers, body, callback, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    callback(new Error('Too many redirects'));
    return;
  }

  const parsedUrl = new URL(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: method || 'GET',
    headers: headers || {},
    timeout: TIMEOUT,
    rejectUnauthorized: false
  };

  const req = httpModule.request(options, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const location = res.headers.location;
      try {
        const redirectUrl = new URL(location, targetUrl).href;
        makeRequest(redirectUrl, method, headers, body, callback, redirectCount + 1);
        return;
      } catch (e) {
        callback(new Error('Invalid redirect URL'));
        return;
      }
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

  if (body && body.length > 0) {
    req.write(body);
  }
  req.end();
}

function proxyRequest(targetUrl, req, res) {
  console.log(`[PROXY] ${req.method} ${targetUrl}`);

  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    body = Buffer.concat(body);

    const headers = {};
    // Forward relevant headers
    const forwardHeaders = ['user-agent', 'accept', 'accept-language', 'accept-encoding', 
                           'cache-control', 'cookie', 'referer', 'x-requested-with'];
    for (const [key, value] of Object.entries(req.headers)) {
      if (forwardHeaders.includes(key.toLowerCase())) {
        headers[key] = value;
      }
    }

    if (!headers['user-agent']) {
      headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    makeRequest(targetUrl, req.method, headers, body, (err, proxyRes) => {
      if (err) {
        console.error(`[ERROR] ${targetUrl}:`, err.message);
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Proxy Error</h1><p>${err.message}</p></body></html>`);
        return;
      }

      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      
      // Set CORS headers
      const responseHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        // Skip hop-by-hop headers
        if (!['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 
             'proxy-authorization', 'te', 'trailers', 'upgrade'].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      }
      
      responseHeaders['access-control-allow-origin'] = '*';
      responseHeaders['x-proxied-by'] = 'proxy-server';

      if (isHtml) {
        // For HTML, we need to modify it to proxy all resources and links
        let chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          html = rewriteHtml(html, targetUrl);
          
          res.writeHead(proxyRes.statusCode, responseHeaders);
          res.end(html);
        });
      } else {
        // For non-HTML content, pipe directly
        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
      }
    });
  });
}

function rewriteHtml(html, baseUrl) {
  // Remove existing base tags
  html = html.replace(/<base[^>]*>/gi, '');
  
  // Add our base tag that points to our proxy
  html = html.replace(/<head[^>]*>/i, 
    `$&<base href="/?url=${encodeURIComponent(baseUrl)}">`);
  
  // Rewrite all relative URLs to go through proxy
  html = html.replace(
    /(href|src|action|srcset)=["']((?!https?:\/\/|\/\/|data:|blob:|#|javascript:|mailto:|tel:|web\+|chrome-extension:).*?)["']/gi,
    (match, attr, value) => {
      try {
        const absoluteUrl = new URL(value, baseUrl).href;
        return `${attr}="/?url=${encodeURIComponent(absoluteUrl)}"`;
      } catch (e) {
        return match;
      }
    }
  );

  // Also rewrite protocol-relative URLs
  html = html.replace(
    /(href|src|action|srcset)=["']\/\/([^"']+)["']/gi,
    (match, attr, url) => {
      return `${attr}="/?url=${encodeURIComponent('https://' + url)}"`;
    }
  );

  // Rewrite absolute URLs to go through proxy (optional, for full proxying)
  html = html.replace(
    /(href|src|action|srcset)=["'](https?:\/\/[^"']+)["']/gi,
    (match, attr, url) => {
      if (url.includes(window?.location?.hostname)) return match;
      return `${attr}="/?url=${encodeURIComponent(url)}"`;
    }
  );

  // Rewrite srcset attributes
  html = html.replace(
    /srcset=["']([^"']+)["']/gi,
    (match, srcsetValue) => {
      const newSrcset = srcsetValue.split(',').map(part => {
        const [url, size] = part.trim().split(/\s+/);
        try {
          const absoluteUrl = new URL(url, baseUrl).href;
          return `/?url=${encodeURIComponent(absoluteUrl)} ${size || ''}`;
        } catch (e) {
          return part;
        }
      }).join(', ');
      return `srcset="${newSrcset}"`;
    }
  );

  // Add a script to intercept link clicks and form submissions
  const interceptScript = `
<script>
(function() {
  // Intercept all link clicks
  document.addEventListener('click', function(e) {
    var target = e.target;
    while (target && target.tagName !== 'A') {
      target = target.parentNode;
    }
    if (target && target.href) {
      var href = target.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
        // Let the base tag handle relative URLs, but catch absolute ones
        if (href.startsWith('http://') || href.startsWith('https://')) {
          e.preventDefault();
          var proxyUrl = '/?url=' + encodeURIComponent(href);
          window.location.href = proxyUrl;
        }
      }
    }
  }, true);

  // Intercept form submissions
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = form.getAttribute('action');
    if (action && !action.startsWith('javascript:')) {
      e.preventDefault();
      var baseUrl = document.querySelector('base').getAttribute('href');
      var urlParams = new URLSearchParams(baseUrl.split('?')[1]);
      var originalBase = decodeURIComponent(urlParams.get('url'));
      
      var resolvedAction;
      try {
        resolvedAction = new URL(action, originalBase).href;
      } catch(ex) {
        resolvedAction = action;
      }
      
      var proxyAction = '/?url=' + encodeURIComponent(resolvedAction);
      form.setAttribute('action', proxyAction);
      
      if (form.method.toLowerCase() === 'get') {
        var formData = new FormData(form);
        var params = new URLSearchParams(formData).toString();
        window.location.href = proxyAction + (params ? '&' + params : '');
      } else {
        form.submit();
      }
    }
  }, true);
})();
</script>`;

  // Insert our script before </body> or at the end
  if (html.includes('</body>')) {
    html = html.replace('</body>', interceptScript + '</body>');
  } else if (html.includes('</html>')) {
    html = html.replace('</html>', interceptScript + '</html>');
  } else {
    html += interceptScript;
  }

  return html;
}

// Handle requests
function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Serve static files
  if (req.method === 'GET') {
    const staticFiles = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/styles.css': 'styles.css',
      '/script.js': 'script.js'
    };

    if (staticFiles[pathname]) {
      const filePath = staticFiles[pathname];
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          const mimeType = getMimeType(filePath);
          res.writeHead(200, { 
            'Content-Type': mimeType,
            'Cache-Control': 'no-cache'
          });
          res.end(content);
          return;
        }
      } catch(e) {
        console.error('Error serving static file:', e);
      }
    }
  }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Web Proxy Server', version: '2.0.0' }));
    return;
  }

  // API - countries
  if (pathname === '/api/countries') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ countries: ['GB', 'US', 'DE', 'FR', 'NL', 'CA'] }));
    return;
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  // Proxy request - check for url parameter
  let targetUrl = parsedUrl.query.url || parsedUrl.query.target || parsedUrl.query.quest;

  // Also handle path-based proxy: /proxy/url
  if (!targetUrl && pathname.startsWith('/proxy/')) {
    targetUrl = decodeURIComponent(pathname.substring(7));
  }

  // Handle direct URL in path (for when base tag resolves)
  if (!targetUrl && req.headers.referer) {
    try {
      const refererParsed = url.parse(req.headers.referer, true);
      const refererBase = refererParsed.query.url;
      if (refererBase && pathname !== '/') {
        targetUrl = new URL(pathname.substring(1), refererBase).href;
      }
    } catch(e) {}
  }

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h1>Missing URL</h1><p>Usage: /?url=https://example.com</p></body></html>`);
    return;
  }

  if (!isValidUrl(targetUrl)) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h1>Invalid URL</h1><p>${targetUrl}</p></body></html>`);
    return;
  }

  proxyRequest(targetUrl, req, res);
}

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Proxy Server running on port ${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
