const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function configured() { return Boolean(process.env.GEMINI_API_KEY); }
function clean(text) { return String(text || '').trim().slice(0, 4000); }
function fallback(message, products) {
  const lower = message.toLowerCase();
  if (/price|cost|quote|estimate/.test(lower)) return 'I can prepare an estimated price using DW Laser\'s approved pricing. Please choose a product, quantity, customization, deadline, and your contact details so I can calculate it accurately.';
  const match = products.find(p => lower.includes(p.product_name.toLowerCase()));
  if (match) return `We can help with ${match.product_name}. How many would you like, and what would you like engraved?`;
  return 'Absolutely — I can help with a custom engraving request. What product are you interested in, how many do you need, and when do you need them?';
}
async function reply({ message, history = [], products, settings }) {
  if (!configured()) return { text: fallback(message, products), engine: 'rule-based (Gemini not configured)' };
  const productText = products.map(p => `${p.product_name}: ${p.description || ''}`).join('\n');
  const prompt = `You are the DW Laser sales assistant for Diedrich in Ontario, Canada. Be friendly, professional, concise, and never pushy. Never invent prices, discounts, production capacity, or deadlines. Prices come only from the server pricing function. Ask only the next necessary question. If uncertain say: Let me have Diedrich confirm that for you.\n\nBusiness rules: ${settings.ai_instructions || 'Use approved products and escalate unusual requests.'}\nProducts:\n${productText}\n\nConversation:\n${history.slice(-12).map(m => `${m.sender}: ${m.text}`).join('\n')}\nCustomer: ${clean(message)}`;
  const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 500 } }) });
  if (!res.ok) throw new Error(`Gemini request failed (${res.status})`);
  const data = await res.json();
  return { text: clean(data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(' ') || fallback(message, products)), engine: 'gemini:gemini-2.5-flash' };
}
module.exports = { reply, configured };
