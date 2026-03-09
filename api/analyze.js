// api/analyze.js — Vercel Serverless Function
// Claude Sonnet 4.5

export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { summaryText, userId } = req.body;
    if (!summaryText) return res.status(400).json({ error: 'summaryText required' });

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('credits, business_name')
      .eq('id', userId)
      .single();

    if (profileError || !profile) return res.status(401).json({ error: 'User tidak ditemukan.' });
    if (profile.credits <= 0) return res.status(403).json({
      error: 'Kredit habis', code: 'NO_CREDITS',
      message: 'Kredit demo Anda sudah habis.'
    });

    // ── Call Claude ─────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8096,
        temperature: 0.1,
        system: 'You are a senior CFO AI analyst. Respond ONLY with a single valid complete JSON object. No markdown, no code blocks, no explanation. The JSON must be completely closed with all brackets and braces properly terminated.',
        messages: [{ role: 'user', content: summaryText }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      console.error('Claude HTTP error:', claudeRes.status, JSON.stringify(err));
      throw new Error(err.error?.message || `Claude API error ${claudeRes.status}`);
    }

    const rawBody = await claudeRes.text();
    let claudeData;
    try {
      claudeData = JSON.parse(rawBody);
    } catch(e) {
      console.error('Claude non-JSON response:', rawBody.substring(0, 300));
      throw new Error('Claude API returned non-JSON: ' + rawBody.substring(0, 100));
    }
    const stopReason = claudeData.stop_reason;
    const inputTokens = claudeData.usage?.input_tokens;
    const outputTokens = claudeData.usage?.output_tokens;
    console.log(`Claude OK — stop_reason: ${stopReason}, tokens: ${inputTokens}in/${outputTokens}out`);

    let text = claudeData.content?.[0]?.text?.trim();
    if (!text) throw new Error('Claude returned empty content: ' + JSON.stringify(claudeData));
    // Strip markdown fences if any
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Log last 200 chars to see if it's truncated
    console.log('Response tail:', text.slice(-200));

    // Parse with repair fallback
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      console.error(`Parse failed (len=${text.length}), stop_reason=${stopReason}. Attempting repair...`);
      // Walk string to count unclosed brackets/braces
      let braces = 0, brackets = 0, inString = false, escape = false;
      for (const ch of text) {
        if (escape)          { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"')      { inString = !inString; continue; }
        if (inString)        continue;
        if (ch === '{')      braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
      // If we're mid-string, close it first
      if (inString) text += '"';
      for (let i = 0; i < brackets; i++) text += ']';
      for (let i = 0; i < braces; i++)   text += '}';
      console.log(`Repair: closed ${brackets} brackets, ${braces} braces`);
      result = JSON.parse(text);
    }

    // Deduct credit
    await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', userId);

    return res.status(200).json({
      result,
      creditsRemaining: profile.credits - 1,
      businessName: profile.business_name
    });

  } catch (err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
