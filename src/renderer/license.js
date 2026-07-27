const form = document.getElementById('form');
const input = document.getElementById('key');
const submitBtn = document.getElementById('submit');
const errorEl = document.getElementById('error');
const buyLink = document.getElementById('buy');
const quitLink = document.getElementById('quit');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Unlock WisperTalk';
}

async function attempt(email) {
  submitBtn.disabled = true;
  submitBtn.textContent = 'Checking…';
  errorEl.classList.add('hidden');

  const res = await window.flow.activate(email);
  if (res.ok) {
    return;
  }
  if (res.error === 'not_found') {
    showError('No WisperTalk purchase found for that email. Use the exact email from your Whop receipt.');
    return;
  }
  if (res.error === 'license_refunded') {
    showError('This purchase was refunded and is no longer valid.');
    return;
  }
  if (res.error === 'bad_request') {
    showError('That doesn’t look like a valid email address.');
    return;
  }
  if (res.error?.startsWith('http_5') || res.error === 'fetch_failed') {
    showError('Could not reach the server. Check your internet and try again.');
    return;
  }
  showError(res.message || res.error || 'Verification failed.');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = input.value.trim();
  if (!email || !email.includes('@')) {
    showError('Enter the email you purchased with.');
    return;
  }
  attempt(email).catch((err) => showError(err.message || String(err)));
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
