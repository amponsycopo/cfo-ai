// api/analyze.js — Vercel Serverless Function
// Claude Sonnet 4.5 — API key never exposed to client

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { summaryText, userId, userToken } = req.body;

    if (!summaryText) return res.status(400).json({ error: 'summaryText required' });

    // Verify user via Supabase (check credits)
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

    // Call Claude Sonnet API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        temperature: 0.1,
        messages: [{ role: 'user', content: summaryText }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      throw new Error(err.error?.message || 'Claude API error');
    }

    const claudeData = await claudeRes.json();
    let text = claudeData.content[0].text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const result = JSON.parse(text);

    // Deduct 1 credit AFTER successful analysis
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
