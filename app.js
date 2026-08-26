const $ = (id) => document.getElementById(id);

const camera = $('camera');
const canvas = $('captureCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const cameraPlaceholder = $('cameraPlaceholder');
const cameraStatus = $('cameraStatus');
const detectedSku = $('detectedSku');
const resultPanel = $('resultPanel');
const resultMessage = $('resultMessage');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const manualForm = $('manualForm');
const manualSku = $('manualSku');
const manualError = $('manualError');
const historyList = $('historyList');
const historyEmpty = $('historyEmpty');
const clearHistoryBtn = $('clearHistoryBtn');
const installBtn = $('installBtn');
const toast = $('toast');

const HISTORY_KEY = 'kaySkuScanner.history.v1';
const SETTINGS = {
  scanIntervalMs: 1400,
  confirmationHits: 2,
  confirmWindowMs: 7000,
  autoOpenDelayMs: 650,
  // Kay's standard site-search URL. Kept in one place in case Kay changes it later.
  kaySearchUrl: (sku) => `https://www.kay.com/search?text=${encodeURIComponent(sku)}`,
};

let mediaStream = null;
let scanning = false;
let ocrBusy = false;
let scanTimer = null;
let candidate = null;
let candidateHits = 0;
let candidateAt = 0;
let deferredInstallPrompt = null;
let ocrWorker = null;

function setStatus(text) { cameraStatus.textContent = text; }
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}

function resetResult() {
  resultPanel.className = 'result-panel idle';
  detectedSku.textContent = '---------';
  resultMessage.textContent = 'Align one 9-digit number inside the box.';
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    failState('Camera access is not supported in this browser. Try Chrome or Safari over HTTPS.');
    return;
  }
  if (!window.isSecureContext) {
    failState('Camera access requires HTTPS. Deploy this app to a secure web address first.');
    return;
  }
  if (!window.Tesseract) {
    failState('OCR engine did not load. Check the internet connection and reload.');
    return;
  }

  startBtn.disabled = true;
  setStatus('Requesting camera…');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    camera.srcObject = mediaStream;
    await camera.play();
    cameraPlaceholder.classList.add('hidden');
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    scanning = true;
    candidate = null;
    candidateHits = 0;
    resetResult();
    setStatus('Scanning…');
    scheduleScan(250);
  } catch (err) {
    console.error(err);
    const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
    failState(denied ? 'Camera permission was denied. Allow camera access in your browser settings.' : 'Could not start the camera.');
  } finally {
    startBtn.disabled = false;
  }
}

function stopCamera() {
  scanning = false;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  camera.srcObject = null;
  cameraPlaceholder.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  startBtn.classList.remove('hidden');
  setStatus('Ready');
}

function scheduleScan(delay = SETTINGS.scanIntervalMs) {
  if (!scanning) return;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(scanFrame, delay);
}

function captureRoi() {
  const vw = camera.videoWidth;
  const vh = camera.videoHeight;
  if (!vw || !vh) return null;

  // Crop an intentionally wide middle band corresponding to the on-screen target box.
  const sx = Math.round(vw * 0.08);
  const sy = Math.round(vh * 0.36);
  const sw = Math.round(vw * 0.84);
  const sh = Math.round(vh * 0.28);

  // Downscale very large camera frames to keep OCR responsive.
  const maxWidth = 1300;
  const scale = Math.min(1, maxWidth / sw);
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  ctx.drawImage(camera, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  // High-contrast grayscale preprocessing helps printed ticket numbers.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const contrast = gray > 150 ? 255 : gray < 75 ? 0 : Math.min(255, Math.max(0, (gray - 110) * 1.7 + 128));
    d[i] = d[i + 1] = d[i + 2] = contrast;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  setStatus('Loading OCR…');
  ocrWorker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (!scanning) return;
      if (m.status === 'recognizing text') {
        setStatus(`Reading ${Math.round((m.progress || 0) * 100)}%`);
      } else if (m.status && m.status !== 'initialized api') {
        setStatus('Preparing OCR…');
      }
    },
  });
  await ocrWorker.setParameters({
    tessedit_char_whitelist: '0123456789 -._',
    preserve_interword_spaces: '1',
  });
  return ocrWorker;
}

async function scanFrame() {
  if (!scanning || ocrBusy) return scheduleScan();
  const source = captureRoi();
  if (!source) return scheduleScan(500);

  ocrBusy = true;
  setStatus('Reading…');
  try {
    const worker = await getOcrWorker();
    if (!scanning) return;
    const { data } = await worker.recognize(source);
    const unique = extractSkuCandidates(data?.text || '');

    if (unique.length === 1) {
      registerCandidate(unique[0]);
    } else if (unique.length > 1) {
      candidate = null;
      candidateHits = 0;
      resultPanel.className = 'result-panel idle';
      detectedSku.textContent = 'MULTIPLE';
      resultMessage.textContent = 'Move closer so only one SKU is inside the box.';
    } else {
      expireCandidateIfNeeded();
    }
  } catch (err) {
    console.error('OCR error', err);
    setStatus('OCR retrying…');
  } finally {
    ocrBusy = false;
    if (scanning) {
      setStatus(candidate ? `Confirming ${candidate}…` : 'Scanning…');
      scheduleScan();
    }
  }
}

function extractSkuCandidates(rawText) {
  // Keep line boundaries so unrelated numbers on different parts of the ticket are never concatenated.
  const lines = String(rawText)
    .replace(/[|]/g, '1')
    .replace(/[Oo]/g, '0')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const found = new Set();
  for (const line of lines) {
    // First: true contiguous 9-digit numbers.
    const exact = line.matchAll(/(?:^|\D)(\d{9})(?!\d)/g);
    for (const hit of exact) found.add(hit[1]);

    // Second: OCR may insert spaces, dots or hyphens between printed digits.
    // Match exactly nine digits connected only by those lightweight separators,
    // while refusing to take the first nine digits out of a longer number.
    const spaced = line.matchAll(/(?:^|[^0-9])(\d(?:[ \t._-]*\d){8})(?![ \t._-]*\d)/g);
    for (const hit of spaced) {
      const digits = hit[1].replace(/\D/g, '');
      if (digits.length === 9) found.add(digits);
    }
  }
  return [...found];
}

function registerCandidate(sku) {
  const now = Date.now();
  if (candidate === sku && now - candidateAt <= SETTINGS.confirmWindowMs) {
    candidateHits += 1;
  } else {
    candidate = sku;
    candidateHits = 1;
  }
  candidateAt = now;

  detectedSku.textContent = sku;
  resultPanel.className = 'result-panel found';
  resultMessage.textContent = candidateHits >= SETTINGS.confirmationHits
    ? 'Confirmed. Opening Kay…'
    : 'Detected once — hold steady to confirm.';

  if (candidateHits >= SETTINGS.confirmationHits) {
    confirmedSku(sku, 'camera');
  }
}

function expireCandidateIfNeeded() {
  if (candidate && Date.now() - candidateAt > SETTINGS.confirmWindowMs) {
    candidate = null;
    candidateHits = 0;
    resetResult();
  }
}

function confirmedSku(sku, source) {
  if (!/^\d{9}$/.test(sku)) return;
  scanning = false;
  if (scanTimer) clearTimeout(scanTimer);
  addHistory(sku, source);
  detectedSku.textContent = sku;
  resultPanel.className = 'result-panel found';
  resultMessage.textContent = 'Confirmed. Opening Kay…';
  setStatus('SKU confirmed');

  if (navigator.vibrate) navigator.vibrate([70, 45, 70]);

  setTimeout(() => {
    // Location navigation is more reliable on mobile than window.open after async OCR.
    window.location.href = SETTINGS.kaySearchUrl(sku);
  }, SETTINGS.autoOpenDelayMs);
}

function failState(message) {
  resultPanel.className = 'result-panel error-state';
  detectedSku.textContent = 'ERROR';
  resultMessage.textContent = message;
  setStatus('Camera unavailable');
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function addHistory(sku, source = 'manual') {
  const current = getHistory().filter((item) => item.sku !== sku);
  current.unshift({ sku, source, at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(current.slice(0, 20)));
  renderHistory();
}

function renderHistory() {
  const items = getHistory();
  historyList.innerHTML = '';
  historyEmpty.classList.toggle('hidden', items.length > 0);
  clearHistoryBtn.classList.toggle('hidden', items.length === 0);

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const main = document.createElement('div');
    main.className = 'history-main';
    const sku = document.createElement('strong');
    sku.textContent = item.sku;
    const meta = document.createElement('span');
    meta.textContent = `${item.source === 'camera' ? 'Camera' : 'Manual'} · ${formatDate(item.at)}`;
    main.append(sku, meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Open';
    btn.addEventListener('click', () => { window.location.href = SETTINGS.kaySearchUrl(item.sku); });
    li.append(main, btn);
    historyList.append(li);
  }
}

function formatDate(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
  } catch { return ''; }
}

manualSku.addEventListener('input', () => {
  manualSku.value = manualSku.value.replace(/\D/g, '').slice(0, 9);
  manualError.textContent = '';
});
manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const sku = manualSku.value.trim();
  if (!/^\d{9}$/.test(sku)) {
    manualError.textContent = 'Enter exactly 9 digits.';
    return;
  }
  addHistory(sku, 'manual');
  window.location.href = SETTINGS.kaySearchUrl(sku);
});

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  showToast('Scan history cleared');
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add('hidden');
});
window.addEventListener('appinstalled', () => {
  installBtn.classList.add('hidden');
  showToast('App installed');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}

renderHistory();
