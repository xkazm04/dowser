# Updating prices from a supplier sheet

Suppliers send their price list as a spreadsheet. Turn it into the file `pebble prices import`
reads:

1. Keep two columns: the product's SKU and its new price in euros.
2. Export the sheet as JSON (one object per row).
3. Run the import from the shop folder.

```json
[
  { "sku": "MUG-01", "amount": 18.5 },
  { "sku": "BOWL-03", "amount": 24 }
]
```

```sh
npx pebble prices import supplier-prices.json
```

It prints how many prices changed, for example `2 prices updated`. A price of zero or less stops
the import with an error naming the SKU.
