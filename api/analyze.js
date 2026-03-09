// api/analyze.js — Vercel Serverless Function
// Claude Sonnet 4.5 — API key never exposed to client

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { summaryText, userId, userToken } = req.body;
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

    if (profileError || !profile) {
      return res.status(401).json({ error: 'User tidak ditemukan.' });
    }
    if (profile.credits <= 0) {
      return res.status(403).json({
        error: 'Kredit habis',
        code: 'NO_CREDITS',
        message: 'Kredit demo Anda sudah habis. Hubungi kami untuk akses penuh.'
      });
    }

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
        system: 'You are a senior CFO AI. Always respond with valid, complete JSON only. No markdown, no explanation, no truncation. The JSON must be fully closed with all brackets and braces.',
        messages: [{ role: 'user', content: summaryText }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      console.error('Claude API response:', JSON.stringify(err));
      throw new Error(err.error?.message || 'Claude API error');
    }

    const claudeData = await claudeRes.json();

    // Check if response was truncated
    const stopReason = claudeData.stop_reason;
    if (stopReason === 'max_tokens') {
      console.error('Response truncated at max_tokens');
    }

    let text = claudeData.content[0].text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Try parse — if fails, attempt JSON repair (close unclosed structures)
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      console.error('JSON parse failed, attempting repair. Length:', text.length);
      // Try to find last valid closing brace
      let repaired = text;
      // Count unclosed brackets/braces
      let braces = 0, brackets = 0;
      let inString = false, escape = false;
      for (const ch of repaired) {
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
      // Close any unclosed arrays then objects
      for (let i = 0; i < brackets; i++) repaired += ']';
      for (let i = 0; i < braces; i++) repaired += '}';
      result = JSON.parse(repaired);
      console.log('JSON repaired successfully');
    }

    await supabase
      .from('profiles')
      .update({ credits: profile.credits - 1 })
      .eq('id', userId);

    return res.status(200).json({
      result,
      creditsRemaining: profile.credits - 1,
      businessName: profile.business_name
    });

  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
