// Holt die tagesaktuellen Shopify-Daten für das Dashboard, verschlüsselt sie mit
// DASHBOARD_PASSWORD und baut die Seite nach _site/. Unverschlüsselt wird nichts veröffentlicht.
//
// Umgebungsvariablen (als GitHub-Secrets hinterlegen):
//   SHOPIFY_STORE          z. B. 7heavens.myshopify.com
//   SHOPIFY_TOKEN          Admin-API-Zugangstoken (shpat_…)  – oder stattdessen:
//   SHOPIFY_CLIENT_ID      Client-ID einer App aus dem Shopify Dev Dashboard
//   SHOPIFY_CLIENT_SECRET  Client-Secret dieser App
//   DASHBOARD_PASSWORD     Passwort, mit dem die Daten verschlüsselt werden (mind. 12 Zeichen)
//   LIEFERUNGEN_CSV        Inhalt der Packlisten-CSV (lieferschein,artikel,farbe,groesse,menge)
//   SENDUNGEN_CSV          Inhalt der Sendungs-CSV (lieferschein,awb,kartons,flughafen,eta,ankunft,status)
// Benötigte Berechtigungen: read_products, read_inventory, read_orders, read_reports
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';
const OUT = '_site';

const store = (process.env.SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
if (!store) fail('Secret SHOPIFY_STORE fehlt (z. B. 7heavens.myshopify.com).');
const password = process.env.DASHBOARD_PASSWORD || '';
if (password.length < 12) fail('Secret DASHBOARD_PASSWORD fehlt oder ist kürzer als 12 Zeichen.');

function fail(msg) {
  console.error('Fehler: ' + msg);
  process.exit(1);
}

async function accessToken() {
  if (process.env.SHOPIFY_TOKEN) return process.env.SHOPIFY_TOKEN;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) fail('Weder SHOPIFY_TOKEN noch SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET sind gesetzt.');
  const r = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) fail(`Shopify-Token konnte nicht geholt werden: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const token = await accessToken();

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    const throttled = r.status === 429 || (j && j.errors && JSON.stringify(j.errors).includes('THROTTLED'));
    if (throttled && attempt < 6) {
      await new Promise((res) => setTimeout(res, 2000 * attempt));
      continue;
    }
    if (!r.ok || !j) fail(`Shopify antwortet mit HTTP ${r.status}: ${text.slice(0, 500)}`);
    if (j.errors) fail('Shopify-Fehler: ' + JSON.stringify(j.errors).slice(0, 1000));
    return j.data;
  }
}

// ---------- Varianten & Bestand ----------
async function varianten() {
  const q = `query($after: String) { productVariants(first: 250, after: $after, query: "product_status:active") {
    pageInfo { hasNextPage endCursor }
    nodes { sku inventoryQuantity inventoryPolicy selectedOptions { name value } product { title } } } }`;
  const rows = [];
  let after = null;
  do {
    const pv = (await gql(q, { after })).productVariants;
    pv.nodes.forEach((n) => {
      const opt = (name) => (n.selectedOptions.find((o) => o.name === name) || {}).value;
      rows.push({
        sku: n.sku,
        artikel: n.product.title,
        farbe: opt('Farbe') ?? (n.selectedOptions[0] || {}).value ?? '',
        groesse: opt('Größe') ?? (n.selectedOptions[1] || {}).value ?? '',
        bestand: Number(n.inventoryQuantity),
        richtlinie: n.inventoryPolicy,
      });
    });
    after = pv.pageInfo.hasNextPage ? pv.pageInfo.endCursor : null;
  } while (after);
  return { columns: ['sku', 'artikel', 'farbe', 'groesse', 'bestand', 'richtlinie'], rows };
}

// ---------- Offene Bestellungen ----------
async function bestellungen() {
  const d = await gql(`{
    offen: ordersCount(query: "status:open AND (fulfillment_status:unshipped OR fulfillment_status:partial)", limit: null) { count precision }
    teilversendet: ordersCount(query: "status:open AND fulfillment_status:partial", limit: null) { count precision } }`);
  return { columns: ['offen', 'teilversendet'], rows: [{ offen: Number(d.offen.count), teilversendet: Number(d.teilversendet.count) }] };
}

// ---------- Verkäufe letzte 30 Tage ----------
async function verkauf() {
  const d = await gql(`{ shopifyqlQuery(query: "FROM sales SHOW net_items_sold GROUP BY product_variant_sku SINCE -30d UNTIL today ORDER BY net_items_sold DESC LIMIT 5000") {
    tableData { columns { name dataType } rows } parseErrors } }`);
  const q = d.shopifyqlQuery;
  if (q.parseErrors && q.parseErrors.length) fail('ShopifyQL: ' + JSON.stringify(q.parseErrors));
  const rows = q.tableData.rows.map((r) => ({ sku: r.product_variant_sku, verkauft_30t: Number(r.net_items_sold) }));
  return { columns: ['sku', 'verkauft_30t'], rows };
}

// ---------- Lieferdaten: aus Secrets, lokal notfalls aus data/*.csv ----------
async function csv(envName, file) {
  if (process.env[envName]) return process.env[envName];
  try { return await readFile(file, 'utf8'); } catch { fail(`Secret ${envName} fehlt.`); }
}

const [v, b, s, lieferungen, sendungen] = await Promise.all([
  varianten(), bestellungen(), verkauf(),
  csv('LIEFERUNGEN_CSV', 'data/lieferungen.csv'), csv('SENDUNGEN_CSV', 'data/sendungen.csv'),
]);

// ---------- Verschlüsseln: PBKDF2-SHA256 + AES-256-GCM, im Browser mit WebCrypto entschlüsselt ----------
const ITERATIONS = 600000;
const salt = randomBytes(16), iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const plain = JSON.stringify({
  updated_at: new Date().toISOString(),
  varianten: v, bestellungen: b, verkauf: s, lieferungen, sendungen,
});
const c = createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);

await mkdir(OUT, { recursive: true });
await cp('site', OUT, { recursive: true });
await writeFile(`${OUT}/data.enc.json`, JSON.stringify({
  v: 1, iter: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
}));
await writeFile(`${OUT}/robots.txt`, 'User-agent: *\nDisallow: /\n');
await writeFile(`${OUT}/.nojekyll`, '');

console.log(`Fertig: ${v.rows.length} Varianten, ${s.rows.length} SKUs mit Verkäufen, ${b.rows[0].offen} offene Bestellungen (verschlüsselt).`);
