const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const VALID_STATUSES = new Set(['HOT', 'WARM', 'COLD', 'NEEDS_INFO']);

const SYSTEM_PROMPT = `You are a lead-qualification assistant for a small local business. You will be given a business's service list and a customer's raw form submission.

Analyze the lead and return ONLY a JSON object with these exact keys:
- "status": one of "HOT", "WARM", "COLD", "NEEDS_INFO"
- "category": short string describing the type of job
- "urgency": "Low", "Medium", or "High"
- "potential_value": "Low", "Medium", or "High"
- "enough_information": boolean
- "missing_information": array of short strings (empty array if none)
- "recommended_action": one short, concrete sentence for the business owner
- "summary": one or two sentence summary of what the customer wants, under 280 characters

STRICT RULES:
- Never invent, estimate, or imply specific pricing, discounts, guarantees, availability, or delivery/completion dates. If the customer asks about these, note it in "missing_information" instead of answering it.
- Base your analysis ONLY on the information the customer actually provided. Do not assume facts not present in the submission.
- If key details are missing (e.g. quantity, timeline, budget, what exactly they need), set "enough_information" to false, list what's missing, and lean toward "NEEDS_INFO" unless urgency/value signals are otherwise very strong.
- Respond with raw JSON only, no markdown fences, no commentary.`;

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function buildUserPrompt(lead, services) {
  return [
    `Business services offered: ${services.join(', ') || '(not configured)'}`,
    '',
    'Customer submission:',
    `Service requested: ${lead.service}`,
    `Project description: ${lead.description}`,
    `Budget: ${lead.budget || '(not provided)'}`,
    `Timeframe: ${lead.timeframe || '(not provided)'}`,
    `Preferred contact method: ${lead.preferred_contact || '(not provided)'}`,
    `Preferred appointment time: ${lead.preferred_appointment_time || '(not provided)'}`,
    `Files attached: ${lead.fileCount || 0}`,
  ].join('\n');
}

async function qualifyWithOpenAI(lead, services) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(lead, services) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response had no content.');

  const parsed = JSON.parse(content);
  const status = VALID_STATUSES.has(parsed.status) ? parsed.status : 'NEEDS_INFO';
  return {
    status,
    summary: String(parsed.summary || '').slice(0, 500),
    recommended_action: String(parsed.recommended_action || '').slice(0, 300),
    missing_info: Array.isArray(parsed.missing_information) ? parsed.missing_information.map(String) : [],
    engine: `openai:${model}`,
  };
}

// Transparent, non-AI fallback used when OPENAI_API_KEY isn't set, so the
// pipeline is never "fake" or broken — it's just a plainer classifier. The
// dashboard clearly labels which engine produced a given lead's summary.
function qualifyWithRules(lead) {
  const missing = [];
  if (!lead.budget) missing.push('Budget');
  if (!lead.timeframe) missing.push('Timeframe');
  if (!lead.description || lead.description.trim().length < 20) missing.push('Project details');

  const urgentWords = /\b(asap|urgent|emergency|today|this week|right away)\b/i;
  const isUrgent = urgentWords.test(lead.timeframe || '') || urgentWords.test(lead.description || '');

  let status = 'WARM';
  if (missing.length >= 2) status = 'NEEDS_INFO';
  else if (isUrgent) status = 'HOT';
  else if (missing.length === 0) status = 'WARM';

  return {
    status,
    summary: (lead.description || '').slice(0, 280),
    recommended_action: missing.length
      ? `Follow up to collect: ${missing.join(', ')}.`
      : 'Review the request and contact the customer.',
    missing_info: missing,
    engine: 'rule-based (OpenAI not configured)',
  };
}

async function qualifyLead(lead, services = []) {
  if (!isConfigured()) {
    return qualifyWithRules(lead);
  }
  try {
    return await qualifyWithOpenAI(lead, services);
  } catch (err) {
    console.error('[aiQualify] OpenAI qualification failed, falling back to rules:', err.message);
    return { ...qualifyWithRules(lead), engine: 'rule-based (OpenAI error — see server logs)' };
  }
}

module.exports = { qualifyLead, isConfigured };
