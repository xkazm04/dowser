// Storefront script: product list, payment form, subscribe button.

const NO_PRODUCTS = '<li class="empty">No products to show yet. <a href="/search">Search the shop</a></li>';

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, body: await res.json() };
}

function renderProducts(list) {
  const ul = document.getElementById('products');
  if (!ul) return;
  if (list.length === 0) { ul.innerHTML = NO_PRODUCTS; return; }
  ul.replaceChildren(...list.map((p) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = p.image;
    img.alt = p.image_alt;
    li.append(img, document.createTextNode(`${p.name} - ${p.price}`));
    return li;
  }));
}

async function pay() {
  const form = document.getElementById('payment-form');
  const msg = document.getElementById('payment-message');
  msg.textContent = 'Paying...';
  const { body } = await post('/checkout/payment', Object.fromEntries(new FormData(form)));
  msg.textContent = body.message;
  if (body.error) form.reset();
}

async function subscribeBox() {
  const btn = document.getElementById('subscribe');
  btn.disabled = true;
  btn.textContent = 'Subscribing...';
  const { ok, body } = await post('/box/subscribe', { plan: 'monthly' });
  btn.textContent = ok ? 'Subscribed' : 'Subscribe';
  btn.disabled = ok;
  alert(body.message);
}

document.getElementById('subscribe')?.addEventListener('click', subscribeBox);
fetch('/products').then((r) => r.json()).then((b) => renderProducts(b.results));
