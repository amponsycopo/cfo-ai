// api/cron-analyze.js — Dipanggil Vercel Cron jam 09:00 dan 18:00 WIB
// WIB = UTC+7, jadi: 09:00 WIB = 02:00 UTC, 18:00 WIB = 11:00 UTC
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300; // 5 menit — cukup untuk loop banyak user

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CFO_SYSTEM_PROMPT = `Kamu adalah CFO senior berpengalaman 20 tahun yang menganalisis laporan keuangan bisnis Indonesia.

ATURAN FORMAT ANGKA — WAJIB DIIKUTI:
- Selalu tulis "Juta" untuk jutaan, "Miliar" untuk miliaran, "Ribu" untuk ribuan
- Contoh benar: "Rp 1,59 Miliar", "Rp 350 Juta", "Rp 500 Ribu"
- Contoh SALAH: "Rp 1.59M", "Rp 350M", "Rp 84jt"

OUTPUT: Respond ONLY with a single valid complete JSON object. No markdown, no explanation.`;

export default async function handler(req, res) {
  // Vercel cron memanggil dengan GET, validasi via secret header
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const session = req.query.session || 'unknown'; // 'morning' atau 'evening'
  console.log(`Cron analyze started — session: ${session} at ${new Date().toISOString()}`);

  try {
    // Ambil semua user yang aktifkan auto-report dan punya refresh token
    const { data: users, error } = await supabase
      .from('profiles')
      .select('id, email, gsheet_refresh_token, gsheet_spreadsheet_id, gsheet_sheet_name, business_type, business_name, credits')
      .eq('gsheet_auto_report', true)
      .not('gsheet_refresh_token', 'is', null)
      .not('gsheet_spreadsheet_id', 'is', null);

    if (error) throw error;
    console.log(`Found ${users?.length || 0} users with auto-report enabled`);

    if (!users || users.length === 0) {
      return res.status(200).json({ message: 'No users to process', processed: 0 });
    }

    const results = { success: 0, failed: 0, skipped: 0 };

    for (const user of users) {
      try {
        console.log(`Processing user: ${user.email}`);

        // Skip kalau kredit habis
        if ((user.credits || 0) <= 0) {
          console.log(`Skipping ${user.email} — no credits`);
          results.skipped++;
          continue;
        }

        // ── Step 1: Refresh access token ──
        const accessToken = await refreshGoogleToken(user.gsheet_refresh_token);
        if (!accessToken) {
          console.error(`Failed to refresh token for ${user.email}`);
          // Kirim email notifikasi ke user bahwa koneksi terputus
          await sendDisconnectEmail(user.email, user.business_name);
          results.failed++;
          continue;
        }

        // ── Step 2: Fetch data dari Google Sheets ──
        const sheetData = await fetchSheetData(accessToken, user.gsheet_spreadsheet_id, user.gsheet_sheet_name);
        if (!sheetData || sheetData.length < 2) {
          console.log(`No data in sheet for ${user.email}`);
          results.skipped++;
          continue;
        }

        // ── Step 3: Pre-aggregate ──
        const summary = preAggregate(sheetData);
        const sessionLabel = session === 'morning' ? '🌅 Laporan Pagi (09:00)' : '🌆 Laporan Sore (18:00)';
        const fmtM = (n) => {
          const a = Math.abs(n);
          if (a >= 1000000000) return (n/1000000000).toFixed(2) + ' Miliar';
          if (a >= 1000000) return (n/1000000).toFixed(2) + ' Juta';
          if (a >= 1000) return (n/1000).toFixed(0) + ' Ribu';
          return String(n);
        };
        const monthStr = summary.monthly.map(m => `${m.month}: pendapatan=Rp ${fmtM(m.income)} pengeluaran=Rp ${fmtM(m.expense)}`).join(', ');
        const catStr = Object.entries(summary.categories)
          .sort((a,b) => Math.abs((b[1].income-b[1].expense)) - Math.abs((a[1].income-a[1].expense)))
          .slice(0,8)
          .map(([k,v]) => `${k}: pendapatan=Rp ${fmtM(v.income)} pengeluaran=Rp ${fmtM(v.expense)}`)
          .join(', ');

        const prompt = `Kamu AI CFO senior Indonesia. Analisis data keuangan bisnis "${user.business_name || 'SME'}".

RINGKASAN KEUANGAN (${sessionLabel}):
Total Pendapatan: Rp ${fmtM(summary.totalIncome)}
Total Pengeluaran: Rp ${fmtM(summary.totalExpense)}
Laba Bersih: Rp ${fmtM(summary.profit)}
Margin: ${summary.margin.toFixed(1)}%
Periode: ${summary.dateRange}

BREAKDOWN BULANAN: ${monthStr}
TOP KATEGORI: ${catStr}

Return HANYA JSON valid:
{"totalIncome":${summary.totalIncome},"totalExpense":${summary.totalExpense},"profit":${summary.profit},"margin":${summary.margin.toFixed(1)},"score":72,"scoreLabel":"Cukup Sehat","scoreBasis":"1 kalimat kenapa skor ini","monthlyData":[{"month":"Jan","income":10000000,"expense":8000000}],"insights":[{"type":"ok","icon":"✅","title":"Judul","text":"2-3 kalimat dengan angka"},{"type":"warn","icon":"⚠️","title":"Warning","text":"Masalah konkret"},{"type":"gold","icon":"💡","title":"Peluang","text":"Estimasi Rp"}],"recs":[{"priority":"critical","title":"Aksi segera","desc":"Langkah spesifik","impact":"Estimasi Rp"},{"priority":"high","title":"Aksi minggu ini","desc":"Langkah konkret","impact":"Estimasi"}],"fraudAlerts":[],"fraudSummary":"Ringkasan anomali.","trendInsight":"3 kalimat. Kondisi bisnis dan angka kunci. Kenapa bisa begitu. 1 aksi paling penting."}`;

        // ── Step 4: Analisis dengan Claude ──
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4000,
            temperature: 0.1,
            system: CFO_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        if (!claudeRes.ok) throw new Error('Claude API error: ' + claudeRes.status);
        const claudeData = await claudeRes.json();
        let text = claudeData.content?.[0]?.text?.trim() || '';
        text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const jsonEnd = text.lastIndexOf('}');
        let depth = 0, jsonStart = -1;
        for (let i = jsonEnd; i >= 0; i--) {
          if (text[i] === '}') depth++;
          else if (text[i] === '{') { depth--; if (depth === 0) { jsonStart = i; break; } }
        }
        if (jsonStart >= 0) text = text.substring(jsonStart, jsonEnd + 1);
        const result = JSON.parse(text);

        // ── Step 5: Deduct credit ──
        await supabase.from('profiles')
          .update({ credits: Math.max(0, (user.credits || 0) - 1) })
          .eq('id', user.id);

        // ── Step 6: Kirim email laporan ──
        await sendReportEmail(user.email, user.business_name, result, sessionLabel);

        console.log(`✅ Done: ${user.email}`);
        results.success++;

        // Rate limit — jeda 2 detik antar user
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.error(`Error processing ${user.email}:`, err.message);
        results.failed++;
      }
    }

    console.log('Cron done:', results);
    return res.status(200).json({ session, results, processedAt: new Date().toISOString() });

  } catch (err) {
    console.error('Cron error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Refresh Google access token ──
async function refreshGoogleToken(refreshToken) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch { return null; }
}

// ── Fetch data dari Google Sheets ──
async function fetchSheetData(accessToken, spreadsheetId, sheetName) {
  try {
    const range = encodeURIComponent(sheetName || 'Sheet1');
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.values || null;
  } catch { return null; }
}

// ── Pre-aggregation (sama dengan di dashboard) ──
function parseNum(val) {
  if (!val && val !== 0) return 0;
  const s = String(val).replace(/[Rp\s]/g,'').replace(/\./g,'').replace(',','.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function parseMonth(dateStr) {
  if (!dateStr) return null;
  const m1 = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/); if (m1) return m1[2];
  const m2 = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);   if (m2) return m2[2];
  const m3 = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);   if (m3) return m3[2];
  return null;
}

function preAggregate(data) {
  const rows = data.filter(r => r.some(c => c !== ''));
  let headerRow = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const rowStr = rows[i].join(' ').toLowerCase();
    if (/tanggal|date/.test(rowStr) && /jumlah|amount|pendapatan|pengeluaran/.test(rowStr)) { headerRow = i; break; }
  }
  const headers = rows[headerRow].map(h => String(h||'').toLowerCase().trim());
  const dataRows = rows.slice(headerRow + 1);
  const colIdx = {
    date:    headers.findIndex(h => /tanggal|date|tgl/.test(h)),
    cat:     headers.findIndex(h => /kategori|category/.test(h)),
    tipe:    headers.findIndex(h => /^tipe$|^type$/.test(h)),
    income:  headers.findIndex(h => /pendapatan|income|masuk|kredit/.test(h)),
    expense: headers.findIndex(h => /pengeluaran|biaya|expense|keluar|debit/.test(h)),
    amount:  headers.findIndex(h => /^jumlah$|^amount$|^nominal$/.test(h)),
  };
  let totalIncome = 0, totalExpense = 0;
  const categories = {}, monthly = {}, dates = [];
  dataRows.forEach(row => {
    const getVal = (idx) => idx >= 0 ? row[idx] : '';
    const tipe = String(getVal(colIdx.tipe)||'').toLowerCase();
    const dateRaw = String(getVal(colIdx.date)||'').trim();
    let income = 0, expense = 0;
    if (colIdx.income >= 0 && colIdx.expense >= 0) {
      income = parseNum(getVal(colIdx.income));
      expense = parseNum(getVal(colIdx.expense));
    } else if (colIdx.amount >= 0) {
      const amt = parseNum(getVal(colIdx.amount));
      if (/pendapatan|income|masuk|kredit/.test(tipe)) income = Math.abs(amt);
      else if (/pengeluaran|expense|keluar|debit/.test(tipe)) expense = Math.abs(amt);
      else if (amt > 0) income = amt; else expense = Math.abs(amt);
    }
    if (income === 0 && expense === 0) return;
    totalIncome += income; totalExpense += expense;
    const catKey = String(getVal(colIdx.cat)||getVal(colIdx.tipe)||'Lainnya').trim() || 'Lainnya';
    if (!categories[catKey]) categories[catKey] = { income: 0, expense: 0 };
    categories[catKey].income += income; categories[catKey].expense += expense;
    const monthKey = parseMonth(dateRaw);
    if (monthKey) { if (!monthly[monthKey]) monthly[monthKey] = { income:0, expense:0 }; monthly[monthKey].income += income; monthly[monthKey].expense += expense; }
    if (dateRaw) dates.push(dateRaw);
  });
  const monthMap = {'01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'Mei','06':'Jun','07':'Jul','08':'Ags','09':'Sep','10':'Okt','11':'Nov','12':'Des'};
  const monthlyArr = Object.entries(monthly).map(([k,v]) => ({ month: monthMap[k]||k, income: Math.round(v.income), expense: Math.round(v.expense) }));
  const profit = totalIncome - totalExpense;
  const margin = totalIncome > 0 ? (profit / totalIncome * 100) : 0;
  const dateRange = dates.length > 0 ? `${dates[0]} s/d ${dates[dates.length-1]}` : 'N/A';
  return { totalIncome: Math.round(totalIncome), totalExpense: Math.round(totalExpense), profit: Math.round(profit), margin, dateRange, categories, monthly: monthlyArr };
}

// ── Kirim email laporan via Resend ──
async function sendReportEmail(toEmail, businessName, result, sessionLabel) {
  const formatRp = (n) => {
    const a = Math.abs(n);
    if (a >= 1000000000) return 'Rp ' + (a/1000000000).toFixed(1) + ' Miliar';
    if (a >= 1000000)    return 'Rp ' + (a/1000000).toFixed(1) + ' Juta';
    if (a >= 1000)       return 'Rp ' + (a/1000).toFixed(0) + ' Ribu';
    return 'Rp ' + a.toFixed(0);
  };
  const insightRows = (result.insights||[]).map(i =>
    `<div style="margin-bottom:12px;padding:12px;border-left:3px solid ${i.type==='ok'?'#16A362':i.type==='warn'?'#D97706':'#1B3FE4'};background:#F9FAFB;border-radius:0 8px 8px 0;">
      <div style="font-weight:700;font-size:13px;margin-bottom:4px;">${i.icon} ${i.title}</div>
      <div style="font-size:12px;color:#374151;">${i.text}</div>
    </div>`
  ).join('');
  const recRows = (result.recs||[]).map(r =>
    `<div style="margin-bottom:10px;padding:10px 14px;background:#F4F6FB;border-radius:8px;">
      <div style="font-size:11px;font-weight:700;color:${r.priority==='critical'?'#DC2626':'#D97706'};margin-bottom:3px;">${r.priority.toUpperCase()}</div>
      <div style="font-weight:600;font-size:13px;">${r.title}</div>
      <div style="font-size:12px;color:#374151;">${r.desc}</div>
      ${r.impact ? `<div style="font-size:11px;color:#16A362;margin-top:4px;">📈 ${r.impact}</div>` : ''}
    </div>`
  ).join('');

  const html = `<!DOCTYPE html><html><body style="font-family:'Segoe UI',Arial,sans-serif;background:#F4F6FB;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#1B3FE4,#1230B0);padding:28px 32px;">
    <div style="font-size:22px;font-weight:800;color:white;margin-bottom:4px;">Findible</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.8);">${sessionLabel} — ${businessName || toEmail.split('@')[0]}</div>
  </div>
  <div style="padding:24px 32px;">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px;">
      <div style="background:#F4F6FB;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:#6B7280;margin-bottom:4px;">Pendapatan</div>
        <div style="font-size:16px;font-weight:800;color:#16A362;">${formatRp(result.totalIncome)}</div>
      </div>
      <div style="background:#F4F6FB;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:#6B7280;margin-bottom:4px;">Pengeluaran</div>
        <div style="font-size:16px;font-weight:800;color:#DC2626;">${formatRp(result.totalExpense)}</div>
      </div>
      <div style="background:#F4F6FB;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:#6B7280;margin-bottom:4px;">Skor Kesehatan</div>
        <div style="font-size:16px;font-weight:800;color:#1B3FE4;">${result.score}/100</div>
      </div>
    </div>
    ${result.trendInsight ? `<div style="background:#EEF1FD;border-radius:10px;padding:14px;margin-bottom:20px;font-size:13px;color:#1B3FE4;line-height:1.6;">${result.trendInsight}</div>` : ''}
    <div style="font-size:14px;font-weight:700;margin-bottom:12px;">💡 Insights</div>
    ${insightRows}
    <div style="font-size:14px;font-weight:700;margin-bottom:12px;margin-top:20px;">🎯 Rekomendasi</div>
    ${recRows}
    <div style="margin-top:24px;text-align:center;">
      <a href="https://findible.vercel.app" style="display:inline-block;padding:12px 28px;background:#1B3FE4;color:white;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;">Buka Dashboard Findible</a>
    </div>
  </div>
  <div style="padding:16px 32px;background:#F4F6FB;font-size:11px;color:#9CA3AF;text-align:center;">
    Laporan otomatis Findible · findible.vercel.app · <a href="https://findible.vercel.app" style="color:#9CA3AF;">Kelola notifikasi</a>
  </div>
</div>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Findible <laporan@findible.vercel.app>',
      to: toEmail,
      subject: `${sessionLabel} — ${businessName || 'Bisnis Anda'} · Skor ${result.score}/100`,
      html
    })
  });
}

// ── Kirim email disconnect notification ──
async function sendDisconnectEmail(toEmail, businessName) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Findible <laporan@findible.vercel.app>',
      to: toEmail,
      subject: '⚠️ Koneksi Google Sheets Findible Terputus',
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1B3FE4;">Findible</h2>
        <p>Halo ${businessName || ''},</p>
        <p>Koneksi Google Sheets lo ke Findible terputus — mungkin karena password Google berubah atau akses dicabut.</p>
        <p>Klik tombol di bawah untuk reconnect dan aktifkan kembali laporan otomatis:</p>
        <a href="https://findible.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1B3FE4;color:white;border-radius:8px;text-decoration:none;font-weight:600;">Reconnect Google Sheets</a>
      </div>`
    })
  });
}
