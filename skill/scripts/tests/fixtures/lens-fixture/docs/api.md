# Storefront API

All endpoints take and return JSON. A session cookie (`sid`) is set on the first request.

## `GET /products`

The catalogue, sorted by name. `?category=<slug>` narrows it to one category. An empty
category answers with `results: []` and an `empty` object holding links back to the shop.

## `GET /search?q=<text>`

Products whose name contains the text. Add `&suggest=1` for up to 5 name suggestions.

## `POST /cart`

Adds a product to the cart.

```sh
curl -X POST http://localhost:8080/cart \
  -H 'content-type: application/json' \
  -d '{"sku": "MUG-01", "qty": 2}'
```

Answers `201 {"ok": true, "count": <items in cart>}`, or `409` when the cart is full.

## `POST /checkout/payment`

Charges the card and places the order. Answers `{"ok": true, "orderId": <id>}`.
