/**
 * 日次チャット報告書
 * - 保存先: Supabase (chat_logs)
 * - Vercel Cron: 毎日 00:00 UTC = 日本時間 9:00
 * - 対象: 前日 0:00〜24:00（JST）= ymd_jst = 昨日
 * - 送信: Resend（HTML表 + CSV添付）
 *
 * 認証: Authorization: Bearer <CRON_SECRET>
 * 手動テスト例:
 *   curl -X POST "https://xxx.vercel.app/api/daily-report?date=2026-07-30" \
 *     -H "Authorization: Bearer $CRON_SECRET"
 */

import {
  getYesterdayJstYmd,
  getChatLogsForYmd,
  getJstYmd,
  hasSupabaseConfig,
} from "./_chatLog.js";

const REPORT_TO = (process.env.REPORT_EMAIL_TO || "ueno@st-spica.jp").trim();
const REPORT_FROM = (
  process.env.REPORT_FROM_EMAIL ||
  "AI相談レポート <onboarding@resend.dev>"
).trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvCell(s) {
  const t = String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function buildCsv(rows) {
  const header = ["時間", "メッセージ", "AI応答", "ユーザーID"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.timeJst || r.time || "", r.message || "", r.answer || "", r.clientId || ""]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

function buildHtml(ymd, rows) {
  const count = rows.length;
  const uniqueUsers = new Set(rows.map((r) => r.clientId).filter(Boolean)).size;
  const bodyRows =
    count === 0
      ? `<tr><td colspan="4" style="padding:10px;border:1px solid #ddd;">対象期間のログはありません。</td></tr>`
      : rows
          .map(
            (r) => `<tr>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;white-space:nowrap;">${escapeHtml(r.timeJst || r.time || "")}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;">${escapeHtml(r.message || "").replace(/\n/g, "<br>")}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;">${escapeHtml(r.answer || "").replace(/\n/g, "<br>")}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;font-family:monospace;font-size:12px;">${escapeHtml(r.clientId || "")}</td>
</tr>`
          )
          .join("\n");

  return `<!doctype html>
<html lang="ja">
<body style="font-family:sans-serif;color:#222;line-height:1.5;">
  <h2 style="margin:0 0 8px;">金井産婦人科 AIお悩み相談 日次レポート</h2>
  <p style="margin:0 0 16px;">
    対象期間: <strong>${escapeHtml(ymd)} 0:00〜24:00</strong><br>
    件数: <strong>${count}</strong>／ユーザー: <strong>${uniqueUsers}人</strong>
  </p>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th style="padding:8px;border:1px solid #ddd;text-align:left;width:15%;">時間</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;width:30%;">メッセージ</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;width:40%;">AI応答</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;width:15%;">ユーザーID</th>
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
  </table>
</body>
</html>`;
}

function isAuthorized(req) {
  if (!CRON_SECRET) return false;
  const auth = String(req.headers.authorization || "");
  if (auth === `Bearer ${CRON_SECRET}`) return true;
  const q = String(req.query?.secret || "").trim();
  return q !== "" && q === CRON_SECRET;
}

async function sendReportEmail({ ymd, rows }) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY is not configured" };
  }

  const csv = buildCsv(rows);
  const html = buildHtml(ymd, rows);
  const subject = `【AI相談】日次レポート ${ymd}（${rows.length}件）`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: REPORT_FROM,
      to: [REPORT_TO],
      subject,
      html,
      attachments: [
        {
          filename: `chat-report-${ymd}.csv`,
          content: Buffer.from(csv, "utf8").toString("base64"),
        },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data?.message || `Resend HTTP ${res.status}`,
      status: res.status,
    };
  }
  return { ok: true, id: data?.id || null };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ymd =
      String(req.query?.date || "").trim() || getYesterdayJstYmd(new Date());

    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      return res.status(400).json({ error: "Invalid date (YYYY-MM-DD)" });
    }

    if (!hasSupabaseConfig()) {
      return res.status(500).json({ error: "Supabase is not configured" });
    }

    const rows = await getChatLogsForYmd(ymd);
    const todayJst = getJstYmd();
    const mail = await sendReportEmail({ ymd, rows });

    if (!mail.ok) {
      console.error("daily-report mail failed:", mail.error);
      return res.status(502).json({
        ok: false,
        ymd,
        todayJst,
        count: rows.length,
        hint:
          rows.length === 0
            ? `0件です。今日のログを見る場合は ?date=${todayJst} を指定してください（date省略時は昨日分）。`
            : undefined,
        generatedAtJst: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
        error: mail.error,
      });
    }

    console.log(
      "daily-report sent",
      JSON.stringify({ ymd, todayJst, count: rows.length, to: REPORT_TO, id: mail.id })
    );

    return res.status(200).json({
      ok: true,
      ymd,
      todayJst,
      count: rows.length,
      to: REPORT_TO,
      emailId: mail.id,
      hint:
        rows.length === 0
          ? `0件です。今日のログを見る場合は ?date=${todayJst} を指定してください（date省略時は昨日分）。`
          : undefined,
      generatedAtJst: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
    });
  } catch (e) {
    console.error("daily-report error:", e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
