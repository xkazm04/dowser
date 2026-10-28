# Receipts

Every paid order gets a receipt e-mail with the order number, total and delivery address.

When a customer writes in that the receipt never arrived, send it again from the admin CLI:

```sh
npx pebble receipts resend 1042
```

It prints `{"resent":true,"orderId":1042}`.
