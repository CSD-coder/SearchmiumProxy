const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const TIMEOUT = 30000;

function contentTypeFromUrl(urlStr) {
  const ext = urlStr.split('.').pop().toLowerCase().split('?')[0];
  const map = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
    json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    pdf: 'application/pdf', xml: 'application/xml', txt: 'text/plain'
  };
  return map[ext] || null;
}

function isValidUrl(urlString) {
  try {
    const p = new URL(urlString);
    return ['http:', 'https:'].includes(p.protocol);
  } catch(e) { return false; }
}

function isHtmlContent(ct) {
  return ct && (ct.includes('text/html') || ct.includes('application/xhtml'));
}

function rewriteHtml(html, baseUrl) {
  // Remove existing base tags
  html = html.replace(/<base[^>]*\/?>/gi, '');
  
  // Add base tag pointing to proxy
  html = html.replace(/<head[^>]*>/i, 
    '<head><base href="/?url=' + encodeURIComponent(baseUrl) + '">');
  
  // Rewrite relative URLs to absolute through proxy
  // href, src, action, srcset
  html = html.replace(/(href|src|action|srcset)=["']([^"']+)["']/gi, (m, attr, val) => {
    val = val.trim();
    // Skip anchors, javascript, mailto, tel, data URIs
    if (val.startsWith('#') || val.startsWith('javascript:') || 
        val.startsWith('mailto:') || val.startsWith('tel:') || 
        val.startsWith('data:') || val.startsWith('blob:') ||
        val.startsWith('chrome-extension:')) {
      return m;
    }
    try {
      const abs = new URL(val, baseUrl).href;
      return attr + '="/?url=' + encodeURIComponent(abs) + '"';
    } catch(e) {
      return m;
    }
  });
  
  // Handle srcset
  html = html.replace(/srcset=["']([^"']+)["']/gi, (m, val) => {
    const parts = val.split(',').map(part => {
      const segs = part.trim().split(/\s+/);
      try {
        segs[0] = '/?url=' + encodeURIComponent(new URL(segs[0], baseUrl).href);
      } catch(e) {}
      return segs.join(' ');
    }).join(', ');
    return 'srcset="' + parts + '"';
  });
  
  // Add navigation handler script
  const navScript = `<script>
(function(){
  var baseOrig = '${baseUrl.replace(/'/g, "\\'")}';
  
  // Intercept clicks
  document.addEventListener('click', function(e){
    var a = e.target.closest('a');
    if (!a || !a.href) return;
    var h = a.getAttribute('href');
    if (!h || h.startsWith('#') || h.startsWith('javascript:') || 
        h.startsWith('mailto:') || h.startsWith('tel:')) return;
    
    e.preventDefault();
    try {
      var abs = new URL(h, baseOrig).href;
      var proxyUrl = '/?url=' + encodeURIComponent(abs);
      window.top.postMessage({type:'proxyNavigate', url:abs}, '*');
      window.location.href = proxyUrl;
    } catch(ex) {
      window.location.href = '/?url=' + encodeURIComponent(h);
    }
  }, true);
  
  // Intercept forms
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (!f || !f.action) return;
    e.preventDefault();
    try {
      var absAction = new URL(f.getAttribute('action') || '', baseOrig).href;
      f.setAttribute('action', '/?url=' + encodeURIComponent(absAction));
      window.top.postMessage({type:'proxyNavigate', url:absAction}, '*');
      f.submit();
    } catch(ex) {
      f.submit();
    }
  }, true);
  
  // Tell parent about current URL
  window.top.postMessage({type:'proxyNavigate', url:window.location.href}, '*');
})();
</script>`;

  if (html.includes('</body>')) {
    html = html.replace('</body>', navScript + '</body>');
  } else if (html.includes('</html>')) {
    html = html.replace('</html>', navScript + '</html>');
  } else {
    html += navScript;
  }
  
  return html;
}

function proxyRequest(targetUrl, req, res) {
  console.log('[PROXY] ' + targetUrl);
  
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity'
  };
  
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: headers,
    timeout: TIMEOUT,
    rejectUnauthorized: false
  };
  
  const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
      const loc = proxyRes.headers.location;
      if (loc) {
        try {
          const redirectUrl = new URL(loc, targetUrl).href;
          proxyRequest(redirectUrl, req, res);
          return;
        } catch(e) {}
      }
    }
    
    const ct = proxyRes.headers['content-type'] || '';
    const isHtml = isHtmlContent(ct);
    
    // Build response headers
    const respHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(k.toLowerCase())) {
        respHeaders[k] = v;
      }
    }
    respHeaders['access-control-allow-origin'] = '*';
    
    if (isHtml) {
      // Buffer HTML to rewrite
      let chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        html = rewriteHtml(html, targetUrl);
        respHeaders['content-length'] = Buffer.byteLength(html);
        res.writeHead(proxyRes.statusCode, respHeaders);
        res.end(html);
      });
    } else {
      // Pass through non-HTML content
      res.writeHead(proxyRes.statusCode, respHeaders);
      proxyRes.pipe(res);
    }
  });
  
  proxyReq.on('error', (err) => {
    console.error('[ERROR]', err.message);
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Proxy Error</h2><p>' + err.message + '</p></body></html>');
  });
  
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Timeout</h2><p>Request timed out</p></body></html>');
  });
  
  proxyReq.end();
}

function serveFile(res, filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const ext = filePath.split('.').pop().toLowerCase();
      const ctypes = { html: 'text/html', css: 'text/css', js: 'application/javascript' };
      res.writeHead(200, { 'Content-Type': ctypes[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
      return true;
    }
  } catch(e) {}
  return false;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  
  // Serve index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    if (serveFile(res, 'index.html')) return;
  }
  
  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.0' }));
    return;
  }
  
  // Get target URL
  let targetUrl = parsed.query.url;
  
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Usage</h2><p>/?url=https://example.com</p></body></html>');
    return;
  }
  
  if (!isValidUrl(targetUrl)) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Invalid URL</h2><p>' + targetUrl + '</p></body></html>');
    return;
  }
  
  proxyRequest(targetUrl, req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Proxy server on port ' + PORT);
});
