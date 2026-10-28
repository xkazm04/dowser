'use strict';
// Development only: fills a local database with demo products.
//   npm run seed -- --products 20
const minimist = require('minimist');
const { run } = require('../src/db');

const args = minimist(process.argv.slice(2), { default: { products: 12 } });
const glazes = ['speckled', 'ash', 'cobalt', 'moss'];

for (let i = 1; i <= Number(args.products); i++) {
  const sku = `DEMO-${String(i).padStart(2, '0')}`;
  const glaze = glazes[i % glazes.length];
  run('INSERT OR REPLACE INTO products (sku, name, price, category, image, image_alt) VALUES (?, ?, ?, ?, ?, ?)',
    [sku, `Demo mug ${i}`, 12 + i, 'mugs', `/img/${sku}.jpg`, `A ${glaze} stoneware mug`]);
}
console.log(`${args.products} demo products written`);
