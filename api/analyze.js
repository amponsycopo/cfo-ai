// api/analyze.js — Vercel Serverless Function
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

// Init Supabase at module level (not inside handler) — avoids cold start penalty
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CFO System Prompt ────────────────────────────────────────────────────────
const CFO_SYSTEM_PROMPT = `Kamu adalah CFO senior berpengalaman 20 tahun yang menganalisis laporan keuangan bisnis Indonesia.

ATURAN FORMAT ANGKA — WAJIB DIIKUTI:
- Selalu tulis "Juta" untuk jutaan (JANGAN pakai M, jt, juta tanpa kapital)
- Selalu tulis "Miliar" untuk miliaran (JANGAN pakai M, B, bn, miliar tanpa kapital)  
- Selalu tulis "Ribu" untuk ribuan (JANGAN pakai K, rb)
- Contoh benar: "Rp 1,59 Miliar", "Rp 350 Juta", "Rp 84,5 Juta", "Rp 500 Ribu"
- Contoh SALAH: "Rp 1.59M", "Rp 350M", "Rp 84jt", "Rp 500rb"
- Aturan ini berlaku di SEMUA field JSON: insights, recommendations, trendInsight, scoreBasis, fraudSummary, dan lainnya.

BENCHMARK SMB INDONESIA (gunakan ini sebagai referensi):
- Gross margin: F&B 50-70%, Retail 20-40%, Agency/Jasa 50-75%, Klinik 40-60%, Kontraktor 15-30%, Trading 10-25%
- Payroll ratio: 20-35% dari revenue
- Marketing ratio: 5-15% dari revenue
- Runway kas: ideal 6-12 bulan
- AR aging: <20% dari revenue outstanding >30 hari
- Net margin: F&B 8-15%, Retail 3-8%, Agency 15-30%, Klinik 10-20%

FRAMEWORK ANALISIS CFO — ikuti urutan ini saat menganalisis:

Step 1 — Ekstrak Metrik Utama
Identifikasi: revenue total, COGS, beban operasional, laba bersih, saldo kas, piutang, hutang dagang.

Step 2 — Hitung Rasio Kunci
Hitung menggunakan formula berikut (JANGAN tebak, hitung dari data yang diberikan):
- Gross Margin = (Revenue - COGS) / Revenue × 100
- Net Margin = Laba Bersih / Revenue × 100
- Burn Rate = Total Beban per Bulan - Revenue per Bulan (jika negatif = burning cash)
- Runway = Saldo Kas / Burn Rate Bulanan (dalam bulan)
- Payroll Ratio = Beban Gaji / Revenue × 100
- COGS Ratio = COGS / Revenue × 100

Step 3 — Deteksi Anomali
Bandingkan rasio dengan benchmark industri. Flag anomali dengan format:
- 🚨 CRITICAL → mengancam kelangsungan bisnis
- ⚠ WARNING → perlu dimonitor dan ditindaklanjuti
- 📈 PELUANG → potensi pertumbuhan yang bisa dioptimalkan

Aturan flag otomatis:
- Runway kas < 3 bulan → 🚨 CRITICAL
- Runway kas 3-6 bulan → ⚠ WARNING
- Payroll > 40% revenue → ⚠ WARNING
- COGS ratio > benchmark industri + 15% → ⚠ WARNING
- Gross margin < benchmark industri - 10% → ⚠ WARNING
- Revenue growth MoM < -20% → 🚨 CRITICAL
- Anomali transaksi duplikat/spike → ⚠ WARNING

Step 4 — Root Cause Analysis
Untuk setiap anomali yang ditemukan, berikan:
1. Apa masalahnya (dengan angka spesifik vs benchmark)
2. 2-3 kemungkinan penyebab
3. Rekomendasi operasional yang spesifik
4. Estimasi dampak finansial jika diperbaiki

Step 5 — Rekomendasi CFO
Berikan rekomendasi yang actionable, spesifik, dan terukur — bukan saran generik.
Contoh BURUK: "Kurangi biaya operasional"
Contoh BAIK: "Renegosiasi kontrak supplier utama untuk COGS — target penghematan 5-8% atau sekitar Rp X Juta per bulan"

OUTPUT: Respond ONLY with a single valid complete JSON object. No markdown, no code blocks, no explanation before or after. The JSON must be completely closed with all brackets and braces properly terminated.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('analyze.js invoked —', new Date().toISOString());

  try {
    const { summaryText, userId } = req.body;
    if (!summaryText) return res.status(400).json({ error: 'summaryText required' });
    if (!userId)      return res.status(400).json({ error: 'userId required' });

    console.log('userId:', userId, '| prompt chars:', summaryText.length);

    // ── Credit check ───────────────────────────────────────
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('credits, business_name')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      console.error('Profile error:', profileError?.message);
      return res.status(401).json({ error: 'User tidak ditemukan.' });
    }

    console.log('Credits:', profile.credits, '| business:', profile.business_name);

    if (profile.credits <= 0) return res.status(403).json({
      error: 'Kredit habis', code: 'NO_CREDITS',
      message: 'Kredit demo Anda sudah habis.'
    });

    // ── Step 1: Reasoning Pass (internal, not sent to JSON step) ───────────
    console.log('Step 1: Reasoning pass...');
    const reasoningPrompt = `${summaryText}

---
Analisis data keuangan di atas secara singkat dan terstruktur:
1. Metrik utama yang ditemukan
2. Rasio kunci (gross margin, net margin, payroll ratio, burn rate)
3. Anomali yang ditemukan beserta severity
4. Root cause paling mungkin per anomali

Tulis dalam 200-300 kata, singkat dan padat.`;

    const reasoningRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        temperature: 0.1,
        system: 'Kamu CFO senior Indonesia. Analisis data keuangan secara singkat dan terstruktur dalam Bahasa Indonesia.',
        messages: [{ role: 'user', content: reasoningPrompt }]
      })
    });

    let reasoningText = '';
    if (reasoningRes.ok) {
      const reasoningData = await reasoningRes.json();
      reasoningText = reasoningData.content?.[0]?.text?.trim() || '';
      console.log('Reasoning done, chars:', reasoningText.length);
    } else {
      console.warn('Reasoning pass failed, continuing without it');
    }

    // ── Step 2: Final JSON Analysis ─────────────────────────
    console.log('Step 2: Final JSON analysis...');
    const finalPrompt = reasoningText
      ? `${summaryText}\n\n---\nHasil analisis awal:\n${reasoningText}\n\n---\nBerdasarkan analisis di atas, generate JSON final sesuai format yang diminta. Return HANYA JSON valid, tanpa teks lain.`
      : summaryText;

    console.log('Calling Claude API...');
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        temperature: 0.1,
        system: CFO_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: finalPrompt }]
      })
    });

    console.log('Claude response status:', claudeRes.status);

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
    if (!text) throw new Error('Claude returned empty content');

    // Strip markdown fences if any
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Extract the outermost JSON object robustly
    // Walk from the last } backwards to find matching { — handles reasoning preamble
    const jsonEnd = text.lastIndexOf('}');
    if (jsonEnd < 0) throw new Error('No closing } in Claude response');
    let depth = 0, jsonStart = -1;
    for (let i = jsonEnd; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') { depth--; if (depth === 0) { jsonStart = i; break; } }
    }
    if (jsonStart >= 0) {
      if (jsonStart > 0) console.log(`Stripping ${jsonStart} chars preamble before JSON`);
      text = text.substring(jsonStart, jsonEnd + 1);
    }

    console.log('JSON length:', text.length, '| tail:', text.slice(-80));

    // Parse with repair fallback
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      console.error(`Parse failed at len=${text.length}, stop_reason=${stopReason}`);
      console.error(`Parse error position: ${parseErr.message}`);
      console.error(`Text tail (last 300): ${text.slice(-300)}`);

      // Attempt structural repair
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
      // If we were mid-string, close it safely
      if (inString) text += '"';
      // Close any open arrays/objects
      for (let i = 0; i < brackets; i++) text += ']';
      for (let i = 0; i < braces; i++)   text += '}';
      console.log(`Repair: added ${brackets} ']' and ${braces} '}'`);

      try {
        result = JSON.parse(text);
        console.log('Repair succeeded');
      } catch (repairErr) {
        console.error('Repair also failed:', repairErr.message);
        // Last resort: truncate to last valid closing brace
        const lastBrace = text.lastIndexOf('}');
        if (lastBrace > 0) {
          try {
            result = JSON.parse(text.substring(0, lastBrace + 1));
            console.log('Truncation repair succeeded at pos', lastBrace);
          } catch {
            throw new Error(`JSON parse failed after all repairs: ${parseErr.message}`);
          }
        } else {
          throw new Error(`JSON parse failed: ${parseErr.message}`);
        }
      }
    }

    // Deduct credit
    await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', userId);
    console.log('Credit deducted. Remaining:', profile.credits - 1);

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
