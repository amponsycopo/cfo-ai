// api/analyze.js — Vercel Serverless Function
// Handles Groq AI analysis — API key never exposed to client

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

    // Get user profile and check credits
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

    // Call Groq API using server-side key
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.1,
        messages: [{ role: 'user', content: summaryText }]
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      throw new Error(err.error?.message || 'Groq API error');
    }

    const groqData = await groqRes.json();
    let text = groqData.choices[0].message.content.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const result = JSON.parse(text);

    // Deduct 1 credit AFTER successful analysis
    await supabase
      .from('profiles')
      .update({ credits: profile.credits - 1 })
      .eq('id', userId);

    // Return result + remaining credits
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
