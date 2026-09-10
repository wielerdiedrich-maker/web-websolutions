const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, requireSameOriginHeader } = require('../auth');
const { calculatePrice, saveQuote } = require('../services/pricingEngine');
const { reply } = require('../services/assistantAI');

const router = express.Router();
const TENANT = 'dw-laser';
const quoteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter(req, file, cb) {
  const allowed = new Set(['image/png','image/jpeg','application/pdf','image/svg+xml']);
  cb(allowed.has(file.mimetype) ? null : new Error('Only PNG, JPG, PDF, and SVG artwork files are accepted.'), allowed.has(file.mimetype));
}});
const privateDir = path.join(__dirname, '..', '..', 'data', 'private-artwork');
fs.mkdir(privateDir, { recursive: true }).catch(() => {});
function products() { return db.prepare('SELECT * FROM assistant_products WHERE tenant_id = ? AND active = 1 ORDER BY product_name').all(TENANT); }
function productView(p) { return { id:p.id, productName:p.product_name, description:p.description, category:p.category, minimumQuantity:p.minimum_quantity, productionTime:p.production_time, materials: safeJson(p.available_materials), colors:safeJson(p.available_colors), engravingArea:p.engraving_area, configured:p.base_price != null && p.engraving_price != null }; }
function safeJson(v) { try { return JSON.parse(v || '[]'); } catch { return []; } }
function settings() { return db.prepare('SELECT * FROM tenant_settings WHERE tenant_id = ?').get(TENANT); }
function log(action, type, id, detail='') { db.prepare('INSERT INTO assistant_audit_logs (id, tenant_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)').run(uuidv4(), TENANT, action, type, id, String(detail).slice(0,1000)); }
function scoreLead({ quantity=0, deadline='', artwork=false, contact=false, accepted=false }) { let score = 0; if (quantity >= 10) score += 25; if (deadline) score += 20; if (artwork) score += 15; if (contact) score += 20; if (accepted) score += 20; return { score, status: score >= 80 ? 'ORDER_READY' : score >= 55 ? 'HOT' : score >= 30 ? 'WARM' : 'COLD' }; }

router.get('/products', quoteLimiter, (req,res) => res.json({ products: products().map(productView) }));
router.post('/conversation', quoteLimiter, (req,res) => {
  const id = uuidv4(); db.prepare('INSERT INTO assistant_conversations (id, tenant_id, channel) VALUES (?, ?, ?)').run(id, TENANT, 'website');
  res.status(201).json({ conversationId:id, products:products().map(productView) });
});
router.post('/message', quoteLimiter, async (req,res) => {
  const { conversationId, message } = req.body || {};
  if (!conversationId || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error:'Conversation and message are required.' });
  const conversation = db.prepare('SELECT * FROM assistant_conversations WHERE id = ? AND tenant_id = ?').get(conversationId,TENANT);
  if (!conversation) return res.status(404).json({ error:'Conversation not found.' });
  db.prepare('INSERT INTO assistant_messages (id, conversation_id, sender, customer_message) VALUES (?, ?, ?, ?)').run(uuidv4(), conversationId, 'customer', message.trim().slice(0,4000));
  const history = db.prepare(`SELECT sender, COALESCE(customer_message, ai_response, '') text FROM assistant_messages WHERE conversation_id = ? ORDER BY timestamp ASC`).all(conversationId);
  try {
    const result = await reply({ message, history, products:products(), settings:settings() });
    db.prepare('INSERT INTO assistant_messages (id, conversation_id, sender, ai_response) VALUES (?, ?, ?, ?)').run(uuidv4(), conversationId, 'assistant', result.text);
    res.json({ text:result.text, engine:result.engine });
  } catch (err) { console.error('[assistant]',err.message); const text='I can help with that. Please choose a product and share the quantity, customization, deadline, and best contact information. Diedrich will confirm final details.'; res.json({ text, engine:'safe fallback' }); }
});
router.post('/quote/calculate', quoteLimiter, (req,res) => {
  try { const result=calculatePrice({ tenantId:TENANT, ...req.body }); res.json(result); } catch (err) { res.status(400).json({ error:err.message }); }
});
router.post('/quote/submit', quoteLimiter, (req,res) => {
  const b=req.body||{}; if (!b.name || (!b.email && !b.phone) || !b.productId || !b.quantity) return res.status(400).json({ error:'Name, email or phone, product, and quantity are required.' });
  const email=String(b.email||'').trim().slice(0,254); if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:'Enter a valid email address.'});
  const product=db.prepare('SELECT * FROM assistant_products WHERE id=? AND tenant_id=?').get(b.productId,TENANT); if(!product) return res.status(400).json({error:'Choose a valid product.'});
  const customerId=uuidv4(); db.prepare('INSERT INTO assistant_customers (id,tenant_id,name,company_name,email,phone) VALUES (?,?,?,?,?,?)').run(customerId,TENANT,String(b.name).slice(0,200),String(b.companyName||'').slice(0,200),email,String(b.phone||'').slice(0,50));
  const leadId=uuidv4(); let quote=null; try { quote=calculatePrice({tenantId:TENANT,productId:b.productId,quantity:b.quantity,customization:b.customization||'',rushOrder:Boolean(b.rushOrder)}); } catch(err) { return res.status(400).json({error:err.message}); }
  const qualification=scoreLead({quantity:Number(b.quantity),deadline:b.deadline,artwork:Boolean(b.artworkId),contact:Boolean(email||b.phone),accepted:Boolean(b.accepted)});
  const disclaimer=settings().quote_disclaimer; db.prepare(`INSERT INTO assistant_leads (id,tenant_id,customer_id,source,product_id,product,quantity,customization,deadline,estimated_value,lead_score,lead_status,conversation_summary,price_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(leadId,TENANT,customerId,'website',product.id,product.product_name,Number(b.quantity),String(b.customization||'').slice(0,2000),String(b.deadline||'').slice(0,200),quote.estimatedTotal,qualification.score,qualification.status,`Request for ${b.quantity} ${product.product_name}.`,JSON.stringify(quote));
  const quoteId=saveQuote({tenantId:TENANT,leadId,input:{productId:b.productId,quantity:b.quantity,customization:b.customization||'',rushOrder:Boolean(b.rushOrder)},result:quote,disclaimer});
  const followupSettings=settings();
  if (followupSettings.followups_enabled) {
    const delays=safeJson(followupSettings.followup_delays).map(Number).filter(Number.isFinite);
    const templates=safeJson(followupSettings.followup_templates);
    const insert=db.prepare('INSERT INTO assistant_followups (id,tenant_id,lead_id,scheduled_for,template) VALUES (?,?,?,?,?)');
    delays.slice(0,3).forEach((days,index)=>insert.run(uuidv4(),TENANT,leadId,new Date(Date.now()+days*86400000).toISOString().replace('T',' ').slice(0,19),String(templates[index+1]||templates[0]||'Just checking in on your DW Laser request.')));
  }
  if (b.conversationId) db.prepare('UPDATE assistant_conversations SET lead_id=?, customer_id=? WHERE id=? AND tenant_id=?').run(leadId,customerId,b.conversationId,TENANT);
  log('lead_created','lead',leadId,qualification.status); if (qualification.status==='HOT'||qualification.status==='ORDER_READY') log('hot_lead_requires_notification','lead',leadId,'Configure SMTP to send email notification.');
  res.status(201).json({ leadId, quoteId, status:qualification.status, score:qualification.score, quote:{...quote, disclaimer} });
});
router.post('/artwork', quoteLimiter, upload.single('artwork'), async (req,res) => {
  if (!req.file) return res.status(400).json({error:'Artwork file is required.'});
  const id=uuidv4(); const ext=path.extname(req.file.originalname).toLowerCase(); const target=path.join(privateDir,`${id}${ext}`);
  await fs.rename(req.file.path,target); db.prepare('INSERT INTO assistant_artwork (id,tenant_id,original_name,content_type,storage_path,size_bytes) VALUES (?,?,?,?,?,?)').run(id,TENANT,req.file.originalname.slice(0,255),req.file.mimetype,target,req.file.size); res.status(201).json({artworkId:id,message:'Artwork received'});
});
router.get('/artwork/:id', requireAuth, (req,res) => { const row=db.prepare('SELECT * FROM assistant_artwork WHERE id=? AND tenant_id=?').get(req.params.id,TENANT); if(!row) return res.status(404).end(); res.type(row.content_type).sendFile(row.storage_path); });

router.use(requireAuth);
router.get('/admin/summary', (req,res) => { const today=new Date().toISOString().slice(0,10); const q=(s,params)=>db.prepare(s).get(params).c; res.json({newLeads:q("SELECT COUNT(*) c FROM assistant_leads WHERE tenant_id=@tenant AND date(created_at)=date(@today)",{tenant:TENANT,today}),hotLeads:q("SELECT COUNT(*) c FROM assistant_leads WHERE tenant_id=@tenant AND lead_status IN ('HOT','ORDER_READY')",{tenant:TENANT}),quotes:q('SELECT COUNT(*) c FROM assistant_quotes WHERE tenant_id=@tenant AND date(created_at)=date(@today)',{tenant:TENANT,today}),orders:q('SELECT COUNT(*) c FROM assistant_orders WHERE tenant_id=@tenant',{tenant:TENANT}),estimatedRevenue:q('SELECT COALESCE(SUM(estimated_value),0) c FROM assistant_leads WHERE tenant_id=@tenant',{tenant:TENANT}),followupsDue:q("SELECT COUNT(*) c FROM assistant_followups WHERE tenant_id=@tenant AND status='PENDING' AND scheduled_for<=datetime('now')",{tenant:TENANT})}); });
router.get('/admin/leads', (req,res) => { const rows=db.prepare(`SELECT l.*, c.name customer_name,c.email,c.phone FROM assistant_leads l LEFT JOIN assistant_customers c ON c.id=l.customer_id WHERE l.tenant_id=? ORDER BY l.created_at DESC`).all(TENANT); res.json({leads:rows}); });
router.get('/admin/leads/:id', (req,res) => { const lead=db.prepare(`SELECT l.*,c.name customer_name,c.company_name,c.email,c.phone FROM assistant_leads l LEFT JOIN assistant_customers c ON c.id=l.customer_id WHERE l.id=? AND l.tenant_id=?`).get(req.params.id,TENANT); if(!lead)return res.status(404).json({error:'Lead not found'}); const conversations=db.prepare('SELECT * FROM assistant_messages WHERE conversation_id IN (SELECT id FROM assistant_conversations WHERE lead_id=?) ORDER BY timestamp').all(lead.id); const quotes=db.prepare('SELECT * FROM assistant_quotes WHERE lead_id=? ORDER BY created_at DESC').all(lead.id); res.json({lead,conversations,quotes}); });
router.patch('/admin/leads/:id', requireSameOriginHeader, (req,res) => { const allowed=new Set(['COLD','WARM','HOT','ORDER_READY']); const {status,notes,nextFollowup}=req.body||{}; if(status&&!allowed.has(status))return res.status(400).json({error:'Invalid lead status'}); const row=db.prepare('SELECT id FROM assistant_leads WHERE id=? AND tenant_id=?').get(req.params.id,TENANT); if(!row)return res.status(404).json({error:'Lead not found'}); db.prepare('UPDATE assistant_leads SET lead_status=COALESCE(?,lead_status),notes=COALESCE(?,notes),next_followup=COALESCE(?,next_followup),updated_at=datetime(\'now\') WHERE id=? AND tenant_id=?').run(status||null,notes==null?null:String(notes).slice(0,5000),nextFollowup||null,req.params.id,TENANT); log('lead_updated','lead',req.params.id); res.json({ok:true}); });
router.get('/admin/products', (req,res)=>res.json({products:db.prepare('SELECT * FROM assistant_products WHERE tenant_id=? ORDER BY product_name').all(TENANT)}));
router.patch('/admin/products/:id', requireSameOriginHeader, (req,res)=>{ const b=req.body||{}; const fields=['description','category','base_price','engraving_price','minimum_quantity','rush_fee','production_time','engraving_area','active']; const updates=[];const vals=[]; for(const f of fields)if(b[f]!==undefined){updates.push(`${f}=?`);vals.push(f==='active'?(b[f]?1:0):b[f]);} if(b.bulk_discount!==undefined){updates.push('bulk_discount=?');vals.push(JSON.stringify(b.bulk_discount));} if(!updates.length)return res.status(400).json({error:'No changes'}); vals.push(new Date().toISOString(),req.params.id,TENANT); db.prepare(`UPDATE assistant_products SET ${updates.join(',')},updated_at=? WHERE id=? AND tenant_id=?`).run(...vals); res.json({ok:true}); });
router.post('/admin/leads/:id/order', requireSameOriginHeader, (req,res)=>{ const lead=db.prepare('SELECT * FROM assistant_leads WHERE id=? AND tenant_id=?').get(req.params.id,TENANT); if(!lead)return res.status(404).json({error:'Lead not found'}); const existing=db.prepare('SELECT * FROM assistant_orders WHERE lead_id=?').get(lead.id); if(existing)return res.json(existing); const id=uuidv4(); const number=`DWL-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; db.prepare('INSERT INTO assistant_orders (id,tenant_id,lead_id,customer_id,order_number,total) VALUES (?,?,?,?,?,?)').run(id,TENANT,lead.id,lead.customer_id,number,lead.estimated_value); db.prepare("UPDATE assistant_leads SET order_status='NEW',lead_status='ORDER_READY',updated_at=datetime('now') WHERE id=?").run(lead.id); log('order_created','order',id,number); res.status(201).json({id,orderNumber:number,status:'NEW',total:lead.estimated_value}); });
router.get('/admin/settings',(req,res)=>res.json({settings:settings(),integrations:{gemini:Boolean(process.env.GEMINI_API_KEY),smtp:Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS)}}));
router.patch('/admin/settings',requireSameOriginHeader,(req,res)=>{const b=req.body||{}; const allowed=['ai_instructions','notification_email','tax_rate','quote_disclaimer','followups_enabled','followup_delays','followup_templates']; const sets=[];const vals=[];for(const f of allowed)if(b[f]!==undefined){sets.push(`${f}=?`);vals.push(typeof b[f]==='object'?JSON.stringify(b[f]):b[f]);}if(!sets.length)return res.status(400).json({error:'No changes'});vals.push(new Date().toISOString(),TENANT);db.prepare(`UPDATE tenant_settings SET ${sets.join(',')},updated_at=? WHERE tenant_id=?`).run(...vals);res.json({ok:true});});
// Future channel contracts: intentionally disabled until credentials/webhook verification are configured.
router.post('/webhooks/:channel', (req,res)=>{ if(!['whatsapp','facebook-messenger','instagram'].includes(req.params.channel))return res.status(404).json({error:'Unsupported channel'}); if(!process.env[`${req.params.channel.toUpperCase().replace(/-/g,'_')}_VERIFY_TOKEN`])return res.status(501).json({error:'Integration not configured'}); return res.status(202).json({accepted:false,message:'Webhook contract reserved for verified integration setup.'}); });
module.exports = router;
