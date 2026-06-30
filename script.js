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

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function getProxyUrl(targetUrl) {
  // Build proxy URL with optional country parameter
  let proxyUrl = '/?url=' + encodeURIComponent(targetUrl);
  const country = countrySelect.value;
  if (country !== 'auto') {
    proxyUrl += '&country=' + country;
  }
  return proxyUrl;
}

function showLoading(url) {
  loadingOverlay.style.display = 'flex';
  errorOverlay.style.display = 'none';
  loadingText.textContent = 'Loading...';
  loadingUrl.textContent = url;
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
  errorMessage.textContent = message || 'Failed to load the page.';
  goButton.style.display = 'inline-block';
  stopBtn.style.display = 'none';
}

function hideError() {
  errorOverlay.style.display = 'none';
}

function updateProxyStatus() {
  const country = countrySelect.options[countrySelect.selectedIndex].text;
  proxyLocation.textContent = country;
  proxyStatus.textContent = '🟢 Active';
  proxyStatus.style.color = '#4CAF50';
}

async function loadSite(url) {
  if (isLoading) {
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

  loadViaProxy(normalizedUrl);
}

function loadViaProxy(targetUrl) {
  isLoading = true;
  hideError();
  showLoading(targetUrl);

  const proxyUrl = getProxyUrl(targetUrl);
  
  // Replace iframe if needed
  if (proxyFrame.tagName !== 'IFRAME') {
    const iframe = document.createElement('iframe');
    iframe.id = 'proxyFrame';
    iframe.style.cssText = 'width:100%; height:100%; border:none; background:white;';
    proxyFrame.parentNode.replaceChild(iframe, proxyFrame);
    window.proxyFrame = iframe;
  }

  // Set up load handler
  proxyFrame.onload = function() {
    if (isLoading) {
      isLoading = false;
      hideLoading();
      updateProxyStatus();
      
      // Update URL from iframe
      try {
        const iframeUrl = proxyFrame.contentWindow.location.href;
        const urlParams = new URL(iframeUrl).searchParams;
        const actualUrl = urlParams.get('url');
        if (actualUrl && actualUrl !== urlInput.value) {
          urlInput.value = actualUrl;
        }
      } catch(e) {
        // Cross-origin - ignore
      }
    }
  };

  proxyFrame.onerror = function() {
    hideLoading();
    showError(targetUrl, 'Failed to load page. Try a different URL.');
    isLoading = false;
  };

  // Load the proxy URL
  proxyFrame.src = proxyUrl;

  // Timeout
  setTimeout(() => {
    if (isLoading) {
      isLoading = false;
      hideLoading();
      showError(targetUrl, 'Page took too long to load.');
    }
  }, 30000);
}

function stopLoading() {
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
    setTimeout(refreshPage, 500);
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
  proxyStatus.textContent = '🟡 Testing...';
  proxyStatus.style.color = '#FFC107';
  
  try {
    const response = await fetch('/?url=https://www.google.com');
    if (response.ok) {
      proxyStatus.textContent = '🟢 Working';
      proxyStatus.style.color = '#4CAF50';
    } else {
      proxyStatus.textContent = '🔴 Failed';
      proxyStatus.style.color = '#f44336';
    }
  } catch(e) {
    proxyStatus.textContent = '🔴 Error';
    proxyStatus.style.color = '#f44336';
  }
}

function updateCountry() {
  updateProxyStatus();
  if (historyStack.length > 0 && currentIndex >= 0) {
    refreshPage();
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

// Listen for messages from iframe (for navigation updates)
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'navigate') {
    urlInput.value = e.data.url;
    loadViaProxy(e.data.url);
  }
});

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  console.log('🌐 Web Proxy Browser Ready');
  updateProxyStatus();
  
  // Create iframe
  if (proxyFrame.tagName !== 'IFRAME') {
    const iframe = document.createElement('iframe');
    iframe.id = 'proxyFrame';
    iframe.style.cssText = 'width:100%; height:100%; border:none; background:white;';
    proxyFrame.parentNode.replaceChild(iframe, proxyFrame);
    window.proxyFrame = iframe;
  }
  
  // Load default page
  urlInput.value = 'https://www.google.com';
  loadSite();
});

window.addEventListener('resize', () => {
  if (proxyFrame) {
    proxyFrame.style.width = '100%';
    proxyFrame.style.height = '100%';
  }
});
