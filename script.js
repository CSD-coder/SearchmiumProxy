// Web Proxy Browser - Client Side
const urlInput = document.getElementById('urlInput');
const proxyFrame = document.getElementById('proxyFrame');
const proxyStatus = document.getElementById('proxyStatus');
const proxyLocation = document.getElementById('proxyLocation');
const countrySelect = document.getElementById('countrySelect');
const loadingOverlay = document.getElementById('loadingOverlay');
const errorOverlay = document.getElementById('errorOverlay');
const loadingText = document.getElementById('loadingText');
const loadingUrl = document.getElementById('loadingUrl');
const errorUrl = document.getElementById('errorUrl');
const errorMessage = document.getElementById('errorMessage');
const goButton = document.getElementById('goButton');
const stopBtn = document.getElementById('stopBtn');

let historyStack = [];
let currentIndex = -1;
let isLoading = false;
let currentAbortController = null;
let selectedCountry = 'auto';
let proxyList = [];
let workingProxies = [];

// CORS Proxy services - these will be used to fetch content
const CORS_PROXIES = [
  {
    name: 'allorigins',
    url: 'https://api.allorigins.win/raw?url=',
    type: 'direct'
  },
  {
    name: 'corsproxy',
    url: 'https://corsproxy.io/?',
    type: 'query'
  },
  {
    name: 'codetabs',
    url: 'https://api.codetabs.com/v1/proxy?quest=',
    type: 'query'
  }
];

// Initialize proxies from data files
async function initializeProxies() {
  try {
    const csvProxies = await loadFromCSV();
    const jsonProxies = await loadFromJSON();
    const txtProxies = await loadFromTXT();
    
    const uniqueProxies = new Set([...csvProxies, ...jsonProxies, ...txtProxies]);
    proxyList = [...uniqueProxies].filter(p => p.includes('://'));
    workingProxies = proxyList.filter(p => p.startsWith('socks5://'));
    
    updateProxyStatus();
    return proxyList.length > 0;
  } catch (error) {
    console.error('Failed to initialize proxies:', error);
    return false;
  }
}

async function loadFromCSV() {
  try {
    const response = await fetch('data.csv');
    if (!response.ok) return [];
    const text = await response.text();
    return text.split('\n')
      .filter(line => line.trim() && line.includes('://'))
      .map(line => line.split(',')[0].trim());
  } catch(e) {
    console.warn('CSV load failed:', e);
    return [];
  }
}

async function loadFromJSON() {
  try {
    const response = await fetch('data.json');
    if (!response.ok) return [];
    const data = await response.json();
    return data.filter(item => item.proxy).map(item => item.proxy.trim());
  } catch(e) {
    console.warn('JSON load failed:', e);
    return [];
  }
}

async function loadFromTXT() {
  try {
    const response = await fetch('data.txt');
    if (!response.ok) return [];
    const text = await response.text();
    return text.split('\n').map(line => line.trim()).filter(line => line.includes('://'));
  } catch(e) {
    console.warn('TXT load failed:', e);
    return [];
  }
}

function updateProxyStatus() {
  if (proxyList.length > 0) {
    proxyStatus.textContent = `🟢 ${proxyList.length} Proxies`;
    proxyStatus.style.color = '#4CAF50';
  } else {
    proxyStatus.textContent = '🔴 No Proxies';
    proxyStatus.style.color = '#f44336';
  }
  
  const countryText = countrySelect.options[countrySelect.selectedIndex].text;
  proxyLocation.textContent = countryText;
}

function updateCountry() {
  selectedCountry = countrySelect.value;
  proxyLocation.textContent = countrySelect.options[countrySelect.selectedIndex].text;
  
  if (historyStack.length > 0 && currentIndex >= 0) {
    refreshPage();
  }
}

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function getRandomProxy() {
  const country = selectedCountry;
  
  if (country !== 'auto' && proxyList.length > 0) {
    const countryProxies = proxyList.filter(p => {
      const proxyData = findProxyData(p);
      return proxyData && proxyData.country === country;
    });
    
    if (countryProxies.length > 0) {
      return countryProxies[Math.floor(Math.random() * countryProxies.length)];
    }
  }
  
  if (workingProxies.length > 0) {
    return workingProxies[Math.floor(Math.random() * workingProxies.length)];
  }
  
  if (proxyList.length > 0) {
    return proxyList[Math.floor(Math.random() * proxyList.length)];
  }
  
  return null;
}

function findProxyData(proxyUrl) {
  // Simple function to extract data from proxy URL
  // In production, you'd parse the JSON data
  return null;
}

async function fetchViaCorsProxy(targetUrl) {
  // Try each CORS proxy service
  for (const service of CORS_PROXIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      const proxyUrl = service.url + encodeURIComponent(targetUrl);
      
      const response = await fetch(proxyUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const html = await response.text();
        if (html.length > 500 && html.includes('<')) {
          return { success: true, html, serviceUsed: service.name };
        }
      }
    } catch (e) {
      console.log(`CORS proxy ${service.name} failed:`, e.message);
      continue;
    }
  }
  
  return { success: false, html: null, serviceUsed: null };
}

function showLoading() {
  loadingOverlay.style.display = 'flex';
  errorOverlay.style.display = 'none';
  goButton.style.display = 'none';
  stopBtn.style.display = 'inline-block';
}

function hideLoading() {
  loadingOverlay.style.display = 'none';
  goButton.style.display = 'inline-block';
  stopBtn.style.display = 'none';
}

function showError(url, message) {
  errorOverlay.style.display = 'flex';
  loadingOverlay.style.display = 'none';
  errorUrl.textContent = url;
  errorMessage.textContent = message || 'Failed to load the page. Please try again.';
  goButton.style.display = 'inline-block';
  stopBtn.style.display = 'none';
}

function hideError() {
  errorOverlay.style.display = 'none';
}

async function loadSite(url) {
  if (isLoading) {
    // Stop current load
    stopLoading();
    return;
  }
  
  const targetUrl = url || urlInput.value;
  if (!targetUrl) return;
  
  const normalizedUrl = normalizeUrl(targetUrl);
  urlInput.value = normalizedUrl;
  
  // Update history
  if (currentIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, currentIndex + 1);
  }
  historyStack.push(normalizedUrl);
  currentIndex = historyStack.length - 1;
  
  await loadViaProxy(normalizedUrl);
}

async function loadViaProxy(targetUrl) {
  isLoading = true;
  hideError();
  showLoading();
  
  loadingText.textContent = 'Loading page...';
  loadingUrl.textContent = targetUrl;
  
  // Abort any existing requests
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  
  try {
    // Try to fetch via CORS proxy first
    const result = await fetchViaCorsProxy(targetUrl);
    
    if (result.success && result.html) {
      const processedHtml = processHtml(result.html, targetUrl);
      
      // Use srcdoc for iframe (better compatibility than webview)
      if (proxyFrame.tagName === 'WEBVIEW') {
        proxyFrame.loadURL(targetUrl);
      } else {
        // Create an iframe if webview is not available
        if (proxyFrame.tagName !== 'IFRAME') {
          const iframe = document.createElement('iframe');
          iframe.id = 'proxyFrame';
          iframe.style.cssText = 'width:100%; height:100%; border:none; background:white;';
          proxyFrame.parentNode.replaceChild(iframe, proxyFrame);
          window.proxyFrame = iframe;
        }
        
        proxyFrame.srcdoc = processedHtml;
      }
      
      hideLoading();
      proxyStatus.textContent = `🟢 Via ${result.serviceUsed}`;
      proxyStatus.style.color = '#4CAF50';
      
      // Update URL input with actual URL (in case of redirects)
      urlInput.value = targetUrl;
    } else {
      // Fallback: try loading directly in iframe
      tryLoadingDirectly(targetUrl);
    }
  } catch (error) {
    console.error('Loading failed:', error);
    tryLoadingDirectly(targetUrl);
  }
}

function tryLoadingDirectly(targetUrl) {
  // Try loading the URL directly in the iframe as a last resort
  if (proxyFrame.tagName !== 'IFRAME') {
    const iframe = document.createElement('iframe');
    iframe.id = 'proxyFrame';
    iframe.style.cssText = 'width:100%; height:100%; border:none; background:white;';
    proxyFrame.parentNode.replaceChild(iframe, proxyFrame);
    window.proxyFrame = iframe;
  }
  
  proxyFrame.src = targetUrl;
  
  // Set timeout for direct loading
  const timeoutId = setTimeout(() => {
    if (isLoading) {
      showError(targetUrl, 'Page took too long to load. The website may be blocking iframe access.');
      isLoading = false;
      hideLoading();
    }
  }, 20000);
  
  proxyFrame.onload = () => {
    clearTimeout(timeoutId);
    if (isLoading) {
      hideLoading();
      isLoading = false;
      proxyStatus.textContent = '🟢 Direct';
      proxyStatus.style.color = '#4CAF50';
    }
  };
  
  proxyFrame.onerror = () => {
    clearTimeout(timeoutId);
    hideLoading();
    showError(targetUrl, 'Failed to load page. The website may be blocking iframe access.');
    isLoading = false;
  };
}

function processHtml(html, baseUrl) {
  // Add base tag if not present
  if (!html.includes('<base ')) {
    html = html.replace('<head>', `<head><base href="${baseUrl}">`);
  }
  
  // Convert relative URLs to absolute
  html = html.replace(/(href|src|action)=["'](?!https?:\/\/|\/\/|data:|#|javascript:|mailto:|tel:)([^"']+)["']/gi,
    (match, attr, url) => {
      try {
        const absoluteUrl = new URL(url, baseUrl).href;
        return `${attr}="${absoluteUrl}"`;
      } catch (e) {
        return match;
      }
    }
  );
  
  return html;
}

function stopLoading() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  
  if (proxyFrame) {
    proxyFrame.src = 'about:blank';
  }
  
  isLoading = false;
  hideLoading();
  hideError();
}

function goBack() {
  if (isLoading) return;
  if (currentIndex > 0) {
    currentIndex--;
    urlInput.value = historyStack[currentIndex];
    loadViaProxy(historyStack[currentIndex]);
  }
}

function goForward() {
  if (isLoading) return;
  if (currentIndex < historyStack.length - 1) {
    currentIndex++;
    urlInput.value = historyStack[currentIndex];
    loadViaProxy(historyStack[currentIndex]);
  }
}

function refreshPage() {
  if (isLoading) {
    stopLoading();
    setTimeout(() => refreshPage(), 500);
    return;
  }
  if (historyStack.length > 0 && currentIndex >= 0) {
    loadViaProxy(historyStack[currentIndex]);
  }
}

function goHome() {
  urlInput.value = 'https://www.google.com';
  loadSite();
}

function retryLoad() {
  hideError();
  if (historyStack.length > 0 && currentIndex >= 0) {
    loadViaProxy(historyStack[currentIndex]);
  } else {
    loadSite();
  }
}

async function testCurrentProxy() {
  const testUrl = 'https://www.google.com';
  proxyStatus.textContent = '🟡 Testing...';
  proxyStatus.style.color = '#FFC107';
  
  try {
    const result = await fetchViaCorsProxy(testUrl);
    if (result.success) {
      proxyStatus.textContent = '🟢 Working';
      proxyStatus.style.color = '#4CAF50';
    } else {
      proxyStatus.textContent = '🔴 Failed';
      proxyStatus.style.color = '#f44336';
    }
  } catch (e) {
    proxyStatus.textContent = '🔴 Error';
    proxyStatus.style.color = '#f44336';
  }
}

// Keyboard shortcuts
urlInput.addEventListener('keypress', function(e) {
  if (e.key === 'Enter') loadSite();
});

document.addEventListener('keydown', function(e) {
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    goBack();
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    goForward();
  }
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
    e.preventDefault();
    refreshPage();
  }
  if (e.key === 'Escape') {
    stopLoading();
  }
});

// Handle browser back/forward buttons
window.addEventListener('popstate', function(e) {
  if (e.state && e.state.index !== undefined) {
    currentIndex = e.state.index;
    urlInput.value = historyStack[currentIndex];
    loadViaProxy(historyStack[currentIndex]);
  }
});

// Update history state when navigating
const originalPushState = history.pushState;
history.pushState = function() {
  originalPushState.apply(this, arguments);
};

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
  console.log('🌐 Web Proxy Browser Initializing...');
  
  await initializeProxies();
  updateProxyStatus();
  
  // Create initial iframe if webview is not supported
  if (proxyFrame.tagName === 'WEBVIEW') {
    const iframe = document.createElement('iframe');
    iframe.id = 'proxyFrame';
    iframe.style.cssText = 'width:100%; height:100%; border:none; background:white;';
    proxyFrame.parentNode.replaceChild(iframe, proxyFrame);
    window.proxyFrame = iframe;
  }
  
  // Load default page
  urlInput.value = 'https://www.google.com';
  await loadSite();
  
  console.log('✅ Proxy browser ready');
});

// Handle window resize
window.addEventListener('resize', () => {
  if (proxyFrame) {
    proxyFrame.style.width = '100%';
    proxyFrame.style.height = '100%';
  }
});
