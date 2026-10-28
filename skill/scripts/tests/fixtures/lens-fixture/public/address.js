// Checkout step 1: the delivery address form.

function saveAddress() {
  const form = document.getElementById('address-form');
  const data = Object.fromEntries(new FormData(form));
  fetch('/checkout/address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

document.getElementById('save-address')?.addEventListener('click', saveAddress);
