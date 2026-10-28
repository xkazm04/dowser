// Product page: the "Save for later" button.

async function saveForLater() {
  const btn = document.getElementById('save-for-later');
  const status = document.getElementById('save-status');
  btn.disabled = true;
  status.textContent = 'Saving...';
  try {
    const res = await fetch('/wishlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: btn.dataset.sku }) });
    const body = await res.json();
    status.textContent = body.message;
  } catch {
    status.textContent = 'Could not save this product. Check your connection and try again.';
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('save-for-later')?.addEventListener('click', saveForLater);
