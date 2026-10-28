// Search results page: reads ?q= from the address bar and lists the matching products.

function showResults(q, results) {
  const list = document.getElementById('results');
  const heading = document.getElementById('results-heading');
  heading.innerHTML = `Results for <strong>${q}</strong>`;
  if (results.length === 0) {
    list.innerHTML = '<li class="empty">No products match your search. <a href="/products">Show all products</a></li>';
    return;
  }
  list.replaceChildren(...results.map((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name} - ${p.price}`;
    return li;
  }));
}

const q = new URLSearchParams(location.search).get('q') || '';
fetch('/search?q=' + encodeURIComponent(q)).then((r) => r.json()).then((b) => showResults(q, b.results));
