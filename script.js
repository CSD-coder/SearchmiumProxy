const urlInput = document.getElementById('urlInput');
const proxyFrame = document.getElementById('proxyFrame');
const proxyCountSpan = document.getElementById('proxyCount');
const currentProxySpan = document.getElementById('currentProxy');
const countrySelect = document.getElementById('countrySelect');
let historyStack = [];
let currentIndex = -1;
let isLoading = false;
let selectedCountry = 'auto';

// Proxy service URL - will be set based on deployment
const PROXY_SERVICE = window.location.origin; // Same origin when deployed

function updateCountry() {
  selectedCountry = countrySelect.value;
  updateCurrentProxyDisplay(`Country: ${countrySelect.options[countrySelect.selectedIndex].text}`);
  
  // Reload current page with new country if there's an active session
  if (historyStack.length > 0 && currentIndex >= 0) {
    refresh();
  }
}

function updateCurrentProxyDisplay(text) {
  if (currentProxySpan) {
    currentProxySpan.textContent = text;
  }
}

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function getProxiedUrl(targetUrl) {
  const proxyUrl = new URL(PROXY_SERVICE);
  proxyUrl.searchParams.set('url', targetUrl);
  if (selectedCountry !== 'auto') {
    proxyUrl.searchParams.set('country', selectedCountry);
  }
  return proxyUrl.href;
}

function loadSite(url) {
  if (isLoading) return;
  
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
  
  loadViaProxy(normalizedUrl);
}

function loadViaProxy(targetUrl) {
  isLoading = true;
  updateCurrentProxyDisplay(`Loading via ${selectedCountry === 'auto' ? 'auto' : selectedCountry}...`);
  
  const proxiedUrl = getProxiedUrl(targetUrl);
  
  // Load directly into iframe
  proxyFrame.src = proxiedUrl;
  
  // Show loading state
  showLoadingState(targetUrl);
}

function showLoadingState(url) {
  // Will be replaced when iframe loads
  proxyFrame.style.opacity = '0.5';
  
  // Reset opacity when loaded
  const onLoad = () => {
    proxyFrame.style.opacity = '1';
    proxyFrame.removeEventListener('load', onLoad);
    isLoading = false;
    updateCurrentProxyDisplay(`Country: ${countrySelect.options[countrySelect.selectedIndex].text}`);
  };
  proxyFrame.addEventListener('load', onLoad);
}

function goBack() {
  if (isLoading) return;
  if (currentIndex > 0) {
    currentIndex--;
    const url = historyStack[currentIndex];
    urlInput.value = url;
    loadViaProxy(url);
  }
}

function goForward() {
  if (isLoading) return;
  if (currentIndex < historyStack.length - 1) {
    currentIndex++;
    const url = historyStack[currentIndex];
    urlInput.value = url;
    loadViaProxy(url);
  }
}

function refresh() {
  if (isLoading) return;
  if (historyStack.length > 0 && currentIndex >= 0) {
    loadViaProxy(historyStack[currentIndex]);
  }
}

// Intercept clicks in iframe to proxy links
proxyFrame.addEventListener('load', function() {
  try {
    const iframeDoc = proxyFrame.contentDocument || proxyFrame.contentWindow.document;
    if (!iframeDoc) return;
    
    // Rewrite all links to go through proxy
    const links = iframeDoc.querySelectorAll('a[href]');
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
        try {
          const absoluteUrl = new URL(href, iframeDoc.baseURI || window.location.href).href;
          link.href = getProxiedUrl(absoluteUrl);
          link.target = '_self';
        } catch(e) {
          // Invalid URL, leave as is
        }
      }
    });
    
    // Rewrite forms to submit through proxy
    const forms = iframeDoc.querySelectorAll('form');
    forms.forEach(form => {
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        const action = form.getAttribute('action') || iframeDoc.baseURI;
        const method = form.getAttribute('method') || 'GET';
        
        if (method.toUpperCase() === 'GET') {
          const formData = new FormData(form);
          const params = new URLSearchParams(formData);
          const targetUrl = new URL(action, iframeDoc.baseURI);
          targetUrl.search = params.toString();
          loadViaProxy(targetUrl.href);
        }
      });
    });
    
    // Update URL input to reflect current iframe URL
    try {
      const currentUrl = iframeDoc.URL || proxyFrame.contentWindow.location.href;
      // Extract original URL from proxy URL
      const urlParams = new URL(currentUrl).searchParams;
      const originalUrl = urlParams.get('url');
      if (originalUrl) {
        urlInput.value = originalUrl;
        // Add to history if navigating within iframe
        if (historyStack[currentIndex] !== originalUrl) {
          if (currentIndex < historyStack.length - 1) {
            historyStack = historyStack.slice(0, currentIndex + 1);
          }
          historyStack.push(originalUrl);
          currentIndex = historyStack.length - 1;
        }
      }
    } catch(e) {
      // Cross-origin restriction, ignore
    }
  } catch(e) {
    // Cross-origin restriction, ignore
  }
});

// Keyboard shortcuts
urlInput.addEventListener('keypress', function(e) {
  if (e.key === 'Enter') loadSite();
});

document.addEventListener('keydown', function(e) {
  // Alt+Left = Back
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    goBack();
  }
  // Alt+Right = Forward
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    goForward();
  }
  // F5 or Ctrl+R = Refresh
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
    e.preventDefault();
    refresh();
  }
});

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  console.log('Web Proxy Browser initialized');
  console.log('Proxy service:', PROXY_SERVICE);
  updateCurrentProxyDisplay('Ready - Select location and enter URL');
  
  // Fetch available countries
  fetch(PROXY_SERVICE + '/api/countries')
    .then(res => res.json())
    .then(data => {
      console.log('Available countries:', data.countries);
    })
    .catch(err => {
      console.log('Could not fetch countries, using defaults');
    });
  
  // Load default page
  const defaultUrl = 'https://www.google.com';
  urlInput.value = defaultUrl;
  loadViaProxy(defaultUrl);
});
