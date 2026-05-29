const form = document.getElementById('form');
const input = document.getElementById('key');
const submitBtn = document.getElementById('submit');
const errorEl = document.getElementById('error');
const conflict = document.getElementById('conflict');
const conflictDevice = document.getElementById('conflict-device');
const cancelMove = document.getElementById('cancelMove');
const confirmMove = document.getElementById('confirmMove');
const buyLink = document.getElementById('buy');
const quitLink = document.getElementById('quit');

let pendingKey = '';

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  conflict.classList.add('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Activate';
}

function showConflict(deviceName, key) {
  pendingKey = key;
  conflictDevice.textContent = deviceName || 'an unknown device';
  conflict.classList.remove('hidden');
  errorEl.classList.add('hidden');
  submitBtn.style.display = 'none';
}

function clearConflict() {
  conflict.classList.add('hidden');
  submitBtn.style.display = 'block';
  pendingKey = '';
}

async function attempt(key, force) {
  submitBtn.disabled = true;
  submitBtn.textContent = 'Activating…';
  errorEl.classList.add('hidden');

  const res = await window.flow.activate(key, force);
  if (res.ok) {
    return;
  }
  if (res.error === 'already_active') {
    showConflict(res.boundDeviceName, key);
    return;
  }
  if (res.error === 'invalid_key') {
    showError('That license key was not found. Double-check the email we sent you.');
    return;
  }
  if (res.error === 'license_refunded') {
    showError('This license has been refunded and is no longer valid.');
    return;
  }
  if (res.error === 'license_revoked') {
    showError('This license has been revoked. Reply to your purchase email if this is unexpected.');
    return;
  }
  if (res.error?.startsWith('http_5') || res.error === 'fetch_failed') {
    showError('Could not reach the license server. Check your internet and try again.');
    return;
  }
  showError(res.message || res.error || 'Activation failed.');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = input.value.trim();
  if (!key) return;
  attempt(key, false).catch((err) => showError(err.message || String(err)));
});

cancelMove.addEventListener('click', () => clearConflict());
confirmMove.addEventListener('click', () => {
  if (!pendingKey) return;
  attempt(pendingKey, true).catch((err) => showError(err.message || String(err)));
});

buyLink.addEventListener('click', async (e) => {
  e.preventDefault();
  const url = await window.flow.buyUrl();
  window.flow.openLink(url);
});

quitLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.flow.quit();
});

input.addEventListener('input', () => {
  const stripped = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.startsWith('WT')) {
    // WT-XXXX-XXXX-XXXX-XXXX — auto-format with dashes
    const body = stripped.slice(2);
    let formatted = 'WT';
    for (let i = 0; i < Math.min(body.length, 16); i++) {
      if (i % 4 === 0) formatted += '-';
      formatted += body[i];
    }
    input.value = formatted;
  } else {
    // Whop / other format — preserve dashes, uppercase only, no truncation
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  }
});
