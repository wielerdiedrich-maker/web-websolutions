const db = require('../db');
const { v4: uuidv4 } = require('uuid');

function json(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function money(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }

function calculatePrice({ tenantId = 'dw-laser', productId, quantity, customization = '', rushOrder = false }) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new Error('Quantity must be a whole number between 1 and 10,000.');
  const product = db.prepare('SELECT * FROM assistant_products WHERE id = ? AND tenant_id = ? AND active = 1').get(productId, tenantId);
  if (!product) throw new Error('Product is unavailable or has not been configured.');
  if (qty < product.minimum_quantity) throw new Error(`This product requires a minimum quantity of ${product.minimum_quantity}.`);
  if (product.base_price == null || product.engraving_price == null) throw new Error('This product does not have pricing configured yet. Please ask Diedrich for an estimate.');
  const settings = db.prepare('SELECT tax_rate FROM tenant_settings WHERE tenant_id = ?').get(tenantId) || { tax_rate: 0 };
  const discounts = json(product.bulk_discount, []);
  const discount = discounts.filter(d => qty >= Number(d.minimum || 0)).sort((a,b) => Number(b.minimum || 0) - Number(a.minimum || 0))[0];
  const base = money(Number(product.base_price) * qty);
  const engraving = money(Number(product.engraving_price) * qty);
  const discountAmount = discount ? money((base + engraving) * (Number(discount.percent || 0) / 100)) : 0;
  const setupFee = customization.trim() ? 0 : 0;
  const rushFee = rushOrder ? money(Number(product.rush_fee || 0) * qty) : 0;
  const subtotal = money(base + engraving - discountAmount + setupFee + rushFee);
  const tax = money(subtotal * (Number(settings.tax_rate || 0) / 100));
  const estimatedTotal = money(subtotal + tax);
  return { productId, productName: product.product_name, quantity: qty, lineItems: [
    { label: 'Base product', amount: base }, { label: 'Engraving', amount: engraving },
    ...(discountAmount ? [{ label: `Quantity discount${discount?.percent ? ` (${discount.percent}%)` : ''}`, amount: -discountAmount }] : []),
    ...(setupFee ? [{ label: 'Setup/design fee', amount: setupFee }] : []), ...(rushFee ? [{ label: 'Rush fee', amount: rushFee }] : []),
  ], basePrice: base, engravingPrice: engraving, quantityDiscount: discountAmount, setupDesignFee: setupFee, rushFee, subtotal, taxRate: Number(settings.tax_rate || 0), tax, estimatedTotal, pricingVersion: product.updated_at };
}

function saveQuote({ tenantId = 'dw-laser', leadId, input, result, disclaimer }) {
  const id = uuidv4();
  db.prepare(`INSERT INTO assistant_quotes (id, tenant_id, lead_id, input_snapshot, line_items, subtotal, tax, estimated_total, disclaimer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tenantId, leadId, JSON.stringify(input), JSON.stringify(result.lineItems), result.subtotal, result.tax, result.estimatedTotal, disclaimer);
  return id;
}
module.exports = { calculatePrice, saveQuote };
