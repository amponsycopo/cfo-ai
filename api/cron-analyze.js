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
      .in('plan', ['pro', 'business'])
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

        const prompt = `Kamu AI CFO senior Indonesia. Analisis data keuangan bisnis "${user.business_name || 'SME'}" untuk ${sessionLabel}.

RINGKASAN KEUANGAN:
Total Pendapatan: Rp ${fmtM(summary.totalIncome)}
Total Pengeluaran: Rp ${fmtM(summary.totalExpense)}
Laba Bersih: Rp ${fmtM(summary.profit)}
Margin: ${summary.margin.toFixed(1)}%
Periode: ${summary.dateRange}

BREAKDOWN BULANAN: ${monthStr}
TOP KATEGORI: ${catStr}

Return HANYA JSON valid dengan struktur ini:
{
  "totalIncome": ${summary.totalIncome},
  "totalExpense": ${summary.totalExpense},
  "profit": ${summary.profit},
  "margin": ${summary.margin.toFixed(1)},
  "score": 72,
  "scoreLabel": "Cukup Sehat",
  "scoreStatus": "ok",
  "scoreNarrative": "2 kalimat: apakah bisnis aman atau ada masalah yang perlu diperhatiin hari ini, dengan angka konkret dan konteks tren.",
  "profitNarrative": "3 kalimat INSIGHTFUL: kalimat 1 — profit/rugi berapa dan dibanding periode sebelumnya naik/turun berapa persen. Kalimat 2 — KENAPA bisa profit atau rugi, kategori apa yang paling berkontribusi dengan angka. Kalimat 3 — 1 aksi konkret yang bisa dilakukan hari ini berdasarkan kondisi profit ini.",
  "fraudAlerts": [
    {
      "severity": "critical",
      "type": "Nama tipe anomali",
      "desc": "Deskripsi detail: vendor/kategori apa, tanggal, nilai Rp berapa, kenapa mencurigakan",
      "amount": 5000000,
      "date": "2024-01-15",
      "action": "Langkah konkret yang harus dilakukan hari ini"
    }
  ],
  "fraudSummary": "1 kalimat ringkasan kondisi fraud hari ini — aman atau ada yang perlu dicek.",
  "dailyInsight": {
    "type": "ok",
    "icon": "💡",
    "title": "Judul insight paling penting hari ini dengan angka",
    "text": "3 kalimat insightful: temuan apa, kenapa ini penting, apa yang harus dilakukan. Gunakan angka nyata dari data."
  }
}`;

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

  const profit = result.profit || 0;
  const isProfitable = profit >= 0;
  const scoreStatus = result.scoreStatus || (result.score >= 75 ? 'ok' : result.score >= 55 ? 'warn' : 'bad');
  const scoreColor = scoreStatus === 'ok' ? '#16A362' : scoreStatus === 'warn' ? '#D97706' : '#DC2626';
  const scoreBg    = scoreStatus === 'ok' ? '#ECFDF5' : scoreStatus === 'warn' ? '#FFFBEB' : '#FEF2F2';
  const scoreBorder= scoreStatus === 'ok' ? '#A7F3D0' : scoreStatus === 'warn' ? '#FDE68A' : '#FECACA';
  const scoreEmoji = scoreStatus === 'ok' ? '✅' : scoreStatus === 'warn' ? '⚠️' : '🚨';

  // Fraud section
  const fraudAlerts = result.fraudAlerts || [];
  const hasFraud = fraudAlerts.length > 0;
  const fraudSection = hasFraud
    ? `<div style="margin-bottom:24px;">
        <div style="font-size:13px;font-weight:700;color:#DC2626;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
          🚨 Transaksi yang Perlu Dicek Hari Ini
        </div>
        ${fraudAlerts.slice(0,3).map(f => `
        <div style="padding:12px 14px;background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <span style="font-size:11px;font-weight:700;color:#DC2626;background:#FEE2E2;padding:2px 8px;border-radius:4px;">${f.severity === 'critical' ? '🔴 KRITIS' : '⚠️ PERHATIAN'}</span>
            ${f.amount ? `<span style="font-size:12px;font-weight:700;color:#DC2626;">${formatRp(f.amount)}</span>` : ''}
          </div>
          <div style="font-size:12px;font-weight:700;color:#111827;margin-bottom:4px;">${f.type}</div>
          <div style="font-size:12px;color:#374151;margin-bottom:6px;">${f.desc}</div>
          <div style="font-size:11px;color:#6B7280;background:white;border:1px solid #FECACA;border-radius:6px;padding:6px 10px;">
            💡 <strong>Tindakan:</strong> ${f.action}
          </div>
        </div>`).join('')}
      </div>`
    : `<div style="margin-bottom:24px;padding:12px 14px;background:#ECFDF5;border:1px solid #A7F3D0;border-radius:10px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">✅</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:#16A362;">Tidak Ada Anomali Hari Ini</div>
          <div style="font-size:12px;color:#065F46;margin-top:2px;">${result.fraudSummary || 'Data keuangan bersih — tidak ditemukan pola mencurigakan.'}</div>
        </div>
      </div>`;

  // Daily insight
  const insight = result.dailyInsight || {};
  const insightBorderColor = insight.type === 'ok' ? '#16A362' : insight.type === 'warn' ? '#D97706' : '#1B3FE4';
  const insightBg = insight.type === 'ok' ? '#F0FDF4' : insight.type === 'warn' ? '#FFFBEB' : '#EEF1FD';

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#F4F6FB;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">

  <!-- HEADER -->
  <div style="background:linear-gradient(135deg,#1B3FE4,#1230B0);padding:24px 32px;">
    <div style="font-size:20px;font-weight:800;color:white;margin-bottom:2px;">Findible</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.75);">${sessionLabel} · ${businessName || toEmail.split('@')[0]}</div>
  </div>

  <div style="padding:24px 32px;">

    <!-- 1. BUSINESS SCORE -->
    <div style="margin-bottom:24px;padding:16px 18px;background:${scoreBg};border:1.5px solid ${scoreBorder};border-radius:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:13px;font-weight:700;color:${scoreColor};">${scoreEmoji} Score Kesehatan Bisnis</div>
        <div style="font-size:24px;font-weight:800;color:${scoreColor};">${result.score}/100 <span style="font-size:13px;font-weight:600;">${result.scoreLabel || ''}</span></div>
      </div>
      <div style="font-size:12px;color:#374151;line-height:1.65;">${result.scoreNarrative || result.scoreBasis || ''}</div>
    </div>

    <!-- 2. PROFIT HARI INI -->
    <div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:10px;">💰 Profit Hari Ini</div>
      <div style="display:flex;gap:10px;margin-bottom:12px;">
        <div style="flex:1;background:#F0FDF4;border:1px solid #A7F3D0;border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:10px;color:#6B7280;margin-bottom:3px;">Pendapatan</div>
          <div style="font-size:15px;font-weight:800;color:#16A362;">${formatRp(result.totalIncome)}</div>
        </div>
        <div style="flex:1;background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:10px;color:#6B7280;margin-bottom:3px;">Pengeluaran</div>
          <div style="font-size:15px;font-weight:800;color:#DC2626;">${formatRp(result.totalExpense)}</div>
        </div>
        <div style="flex:1;background:${isProfitable ? '#EEF1FD' : '#FEF2F2'};border:1px solid ${isProfitable ? '#C7D2F8' : '#FECACA'};border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:10px;color:#6B7280;margin-bottom:3px;">Laba Bersih</div>
          <div style="font-size:15px;font-weight:800;color:${isProfitable ? '#1B3FE4' : '#DC2626'};">${isProfitable ? '+' : ''}${formatRp(profit)}</div>
        </div>
      </div>
      <div style="font-size:12px;color:#374151;line-height:1.65;padding:12px 14px;background:#F9FAFB;border-radius:8px;border-left:3px solid ${isProfitable ? '#1B3FE4' : '#DC2626'};">
        ${result.profitNarrative || ''}
      </div>
    </div>

    <!-- 3. FRAUD ALERTS -->
    ${fraudSection}

    <!-- 4. DAILY INSIGHT -->
    <div style="margin-bottom:24px;padding:14px 16px;background:${insightBg};border-left:3px solid ${insightBorderColor};border-radius:0 10px 10px 0;">
      <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:6px;">${insight.icon || '💡'} ${insight.title || 'Insight Hari Ini'}</div>
      <div style="font-size:12px;color:#374151;line-height:1.65;">${insight.text || ''}</div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;padding-top:4px;">
      <a href="https://findible.pro" style="display:inline-block;padding:12px 28px;background:#1B3FE4;color:white;border-radius:10px;font-weight:600;font-size:13px;text-decoration:none;">Buka Dashboard Lengkap →</a>
    </div>

  </div>

  <!-- FOOTER -->
  <div style="padding:14px 32px;background:#F4F6FB;font-size:11px;color:#9CA3AF;text-align:center;border-top:1px solid #E5E7EB;">
    Laporan otomatis Findible · <a href="https://findible.pro" style="color:#9CA3AF;text-decoration:none;">findible.pro</a> · <a href="https://findible.pro" style="color:#9CA3AF;text-decoration:none;">Kelola notifikasi</a>
  </div>
</div>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Findible <laporan@findible.pro>',
      to: toEmail,
      subject: `${scoreEmoji} ${sessionLabel} — ${businessName || 'Bisnis Anda'} · Skor ${result.score}/100${hasFraud ? ` · 🚨 ${fraudAlerts.length} Anomali` : ''}`,
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
      from: 'Findible <laporan@findible.pro>',
      to: toEmail,
      subject: '⚠️ Koneksi Google Sheets Findible Terputus',
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1B3FE4;">Findible</h2>
        <p>Halo ${businessName || ''},</p>
        <p>Koneksi Google Sheets lo ke Findible terputus — mungkin karena password Google berubah atau akses dicabut.</p>
        <p>Klik tombol di bawah untuk reconnect dan aktifkan kembali laporan otomatis:</p>
        <a href="https://findible.pro" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1B3FE4;color:white;border-radius:8px;text-decoration:none;font-weight:600;">Reconnect Google Sheets</a>
      </div>`
    })
  });
}
