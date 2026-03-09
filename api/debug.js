// api/debug.js — TEMPORARY, hapus setelah selesai debug
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const key = process.env.ANTHROPIC_API_KEY;
  
  // Test ping ke Claude API
  let claudeStatus = 'not tested';
  try {
    const testRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'say hi' }]
      })
    });
    const data = await testRes.json();
    claudeStatus = testRes.ok ? '✅ OK' : `❌ ${data.error?.message}`;
  } catch(e) {
    claudeStatus = `❌ ${e.message}`;
  }

  return res.status(200).json({
    key_exists: !!key,
    key_prefix: key ? key.substring(0, 14) + '...' : 'NOT SET',
    key_length: key ? key.length : 0,
    claude_api: claudeStatus
  });
}
