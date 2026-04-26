/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { sendTransactionalEmail } from './email';
import { trackEvent } from './funnel';
import { markProspectEmailSent } from './db_sheets';

// ─────────────────────────────────────────────────────────────────────────────
// DemoBot prospect email sequence (master spec § "DemoBot Email Sequence").
//
//   E1  T+0                  inline send right after scan — links to Sheet/Drive/PDF
//   E2  next morning 8am     only if E1 opened or any link clicked
//   E3  show_end + 3d        only if not converted
//   E4  next_show − 28d      retarget if shows_catalog has an upcoming show in
//                            the prospect's industry; falls back to generic
//                            discount version after 30d if no upcoming show
//
// Engagement-gating (E2 only-if-engaged, E3 only-if-not-converted) happens at
// dispatch time inside processDemobotQueue — the row is enqueued unconditionally
// at scan time so we can revisit gating logic without touching the schema.
//
// Branding follows the **Digital Ledger** system (obsidian + violet signal for
// the SourceBot pitch). The spec's older Ink Navy / Cinzel directions are
// intentionally NOT used — see memory dagama_brand_digital_ledger.md.
//
// Languages: 10 are slotted (en, zh-CN, de, ar, he, tr, ko, es, fr, pt). Only
// English copy is currently populated; other locales fall back to English so
// the pipeline runs end-to-end while translations are added as content work.
// ─────────────────────────────────────────────────────────────────────────────

export type Language = 'en' | 'zh-CN' | 'de' | 'ar' | 'he' | 'tr' | 'ko' | 'es' | 'fr' | 'pt';
export const SUPPORTED_LANGUAGES: Language[] = ['en', 'zh-CN', 'de', 'ar', 'he', 'tr', 'ko', 'es', 'fr', 'pt'];

// Brand: Digital Ledger violet signal for the SourceBot pitch.
const BRAND_OBSIDIAN  = '#0D0D0D';
const BRAND_TITANIUM  = '#F2F2F2';
const BRAND_TITANIUM_MUTED = 'rgba(242, 242, 242, 0.6)';
const BRAND_VIOLET    = '#8B5CF6';
const BRAND_VIOLET_SOFT = 'rgba(139, 92, 246, 0.12)';
const BRAND_BORDER    = 'rgba(38, 38, 38, 0.5)';

// ─────────────────────────────────────────────────────────────────────────────
// Inline send for Email 1 — called synchronously from the scan handler so the
// prospect gets the email within ~30s of the card photo arriving.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendDemobotEmail1(prospectId: string, env: Env): Promise<boolean> {
  const p = await loadProspect(prospectId, env);
  if (!p) return false;
  if (!p.prospect_email) {
    console.log('[demobot/e1] no email on prospect', prospectId);
    return false;
  }

  const tpl = renderE1(p);
  const ok = await sendTransactionalEmail({
    to:      p.prospect_email,
    toName:  p.prospect_name ?? 'there',
    subject: tpl.subject,
    html:    tpl.html,
    text:    tpl.text,
  }, env);

  const now = Math.floor(Date.now() / 1000);
  if (ok) {
    await env.DB.prepare(
      `UPDATE demobot_prospects SET email1_sent_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(now, prospectId).run();

    if (p.sheet_id) {
      await markProspectEmailSent(p.sheet_id, { subject: tpl.subject, sentAt: new Date().toISOString() }, env)
        .catch(e => console.error('[demobot/e1] sheet update failed:', e));
    }

    await trackEvent(env, {
      buyerId: null,
      eventName: 'demobot_email_sent',
      properties: { prospect_id: prospectId, kind: 'demobot_e1', language: p.detected_language },
    });
  }
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule E2/E3/E4 in email_queue. Idempotent — won't double-insert.
//
//   E2: 8am next morning in prospect's local time (we don't know it; UTC fallback)
//   E3: show_end + 3 days  (uses shows_catalog if linked, else scan + 3d)
//   E4: next_show − 28d    (set to scan + 30d as a fallback; cron picks the
//                           best matching show at dispatch time)
// ─────────────────────────────────────────────────────────────────────────────
export async function scheduleDemobotFollowups(prospectId: string, env: Env): Promise<void> {
  const p = await loadProspect(prospectId, env);
  if (!p) return;

  const scannedAt = p.scanned_at;
  const day1 = startOfUtcDay(scannedAt);
  const e2At = day1 + 24 * 3600 + 8 * 3600;          // 08:00 UTC next morning

  // E3: 3 days after show_end, or 3 days after scan if no show row.
  let showEndUnix = scannedAt;
  if (p.show_id) {
    const sh = await env.DB.prepare(`SELECT end_date FROM shows_catalog WHERE id = ?`)
      .bind(p.show_id).first<{ end_date: string }>();
    if (sh?.end_date) {
      const ts = Date.parse(sh.end_date + 'T18:00:00Z');
      if (!Number.isNaN(ts)) showEndUnix = Math.floor(ts / 1000);
    }
  }
  const e3At = showEndUnix + 3 * 24 * 3600;

  // E4: scan + 30d as the placeholder. processDemobotQueue() re-evaluates against
  // shows_catalog at dispatch time, so this is just a "wake up no later than" anchor.
  const e4At = scannedAt + 30 * 24 * 3600;

  for (const item of [
    { kind: 'demobot_e2', at: e2At },
    { kind: 'demobot_e3', at: e3At },
    { kind: 'demobot_e4', at: e4At },
  ]) {
    if (item.at < Math.floor(Date.now() / 1000)) continue;   // never enqueue past
    await env.DB.prepare(
      `INSERT INTO email_queue (buyer_id, show_id, kind, prospect_id, scheduled_at, status)
       SELECT NULL, ?, ?, ?, ?, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM email_queue WHERE prospect_id = ? AND kind = ?
        )`
    ).bind(p.show_id, item.kind, prospectId, item.at, prospectId, item.kind).run();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron-driven dispatcher for demobot_e* kinds. Called from scheduled() in
// addition to processFunnelQueue. Engagement-gating happens here.
// ─────────────────────────────────────────────────────────────────────────────
export async function processDemobotQueue(env: Env): Promise<{ sent: number; skipped: number; failed: number }> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    `SELECT id, kind, prospect_id, scheduled_at
       FROM email_queue
      WHERE status = 'pending' AND scheduled_at <= ?
        AND kind IN ('demobot_e2','demobot_e3','demobot_e4')
      ORDER BY scheduled_at
      LIMIT 50`
  ).bind(now).all<{ id: string; kind: string; prospect_id: string; scheduled_at: number }>();

  let sent = 0, skipped = 0, failed = 0;
  for (const row of due.results) {
    try {
      const p = await loadProspect(row.prospect_id, env);
      if (!p || !p.prospect_email) {
        await env.DB.prepare(`UPDATE email_queue SET status = 'skipped', error = 'no prospect/email', sent_at = ? WHERE id = ?`)
          .bind(now, row.id).run();
        skipped++;
        continue;
      }

      // Engagement gating
      if (row.kind === 'demobot_e2' && !p.email1_opened_at && !p.email1_clicked_at) {
        await env.DB.prepare(`UPDATE email_queue SET status = 'skipped', error = 'e1 not engaged', sent_at = ? WHERE id = ?`)
          .bind(now, row.id).run();
        skipped++;
        continue;
      }
      if ((row.kind === 'demobot_e3' || row.kind === 'demobot_e4') && p.converted_at) {
        await env.DB.prepare(`UPDATE email_queue SET status = 'skipped', error = 'already converted', sent_at = ? WHERE id = ?`)
          .bind(now, row.id).run();
        skipped++;
        continue;
      }

      // E4 picks the best upcoming show in this industry (within 28d window).
      let nextShow: { name: string; starts: string } | null = null;
      if (row.kind === 'demobot_e4' && p.industry) {
        const lookahead = await env.DB.prepare(
          `SELECT show_name, start_date FROM shows_catalog
            WHERE industry_focus = ?
              AND start_date >= date('now')
              AND start_date <= date('now', '+45 days')
            ORDER BY start_date LIMIT 1`
        ).bind(p.industry).first<{ show_name: string; start_date: string }>();
        if (lookahead) nextShow = { name: lookahead.show_name, starts: lookahead.start_date };
      }

      const tpl = row.kind === 'demobot_e2' ? renderE2(p)
                : row.kind === 'demobot_e3' ? renderE3(p)
                : renderE4(p, nextShow);

      const ok = await sendTransactionalEmail({
        to:      p.prospect_email,
        toName:  p.prospect_name ?? 'there',
        subject: tpl.subject,
        html:    tpl.html,
        text:    tpl.text,
      }, env);

      if (ok) {
        await env.DB.prepare(`UPDATE email_queue SET status = 'sent', sent_at = ? WHERE id = ?`)
          .bind(now, row.id).run();
        await trackEvent(env, {
          buyerId: null,
          eventName: 'demobot_email_sent',
          properties: { prospect_id: p.id, kind: row.kind, language: p.detected_language },
        });
        sent++;
      } else {
        await env.DB.prepare(`UPDATE email_queue SET status = 'skipped', error = 'transactional account not configured', sent_at = ? WHERE id = ?`)
          .bind(now, row.id).run();
        skipped++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await env.DB.prepare(`UPDATE email_queue SET status = 'failed', error = ?, sent_at = ? WHERE id = ?`)
        .bind(msg.slice(0, 500), now, row.id).run();
      failed++;
    }
  }
  return { sent, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

interface ProspectRow {
  id: string;
  prospect_email:    string | null;
  prospect_name:     string | null;
  company:           string | null;
  show_name_raw:     string | null;
  show_id:           string | null;
  detected_language: string;
  industry:          string | null;
  sheet_id:          string | null;
  sheet_url:         string | null;
  drive_folder_url:  string | null;
  pdf_drive_url:     string | null;
  scanned_at:        number;
  email1_opened_at:  number | null;
  email1_clicked_at: number | null;
  converted_at:      number | null;
}
async function loadProspect(id: string, env: Env): Promise<ProspectRow | null> {
  return env.DB.prepare(
    `SELECT id, prospect_email, prospect_name, company, show_name_raw, show_id,
            detected_language, industry, sheet_id, sheet_url, drive_folder_url, pdf_drive_url,
            scanned_at, email1_opened_at, email1_clicked_at, converted_at
       FROM demobot_prospects WHERE id = ?`
  ).bind(id).first<ProspectRow>();
}

interface RenderedEmail { subject: string; html: string; text: string }

function renderE1(p: ProspectRow): RenderedEmail {
  const showLabel = p.show_name_raw ?? 'the show';
  const subject = `Your ${showLabel} contact info — live Google Sheet inside`;

  const text =
    `Hi ${p.prospect_name ?? 'there'},\n\n` +
    `Great meeting you at ${showLabel}. Everything from your card is already in a live Google Sheet, ready to use.\n\n` +
    `📊 Live sheet:    ${p.sheet_url ?? '—'}\n` +
    `📁 Drive folder:  ${p.drive_folder_url ?? '—'}\n` +
    (p.pdf_drive_url ? `📄 Profile PDF:   ${p.pdf_drive_url}\n` : '') +
    `\nThe sheet is yours — open it in your own Google account, no signup needed. ` +
    `Add notes, share with your team, edit anything.\n\n` +
    `If you'd like to capture every supplier/buyer at your next show the same way, just reply.\n\n` +
    `— Sent via DaGama SourceBot · heydagama.com`;

  const html = ledgerEmail({
    eyebrow: 'DaGama · SourceBot',
    title: `Your ${escapeHtml(showLabel)} contact, captured.`,
    intro: `Hi ${escapeHtml(p.prospect_name ?? 'there')} — great meeting you${p.company ? ` at ${escapeHtml(p.company)}` : ''}. Everything from your card is sitting in a live Google Sheet.`,
    cards: [
      p.sheet_url ? { icon: '📊', label: 'Open the live sheet', href: p.sheet_url } : null,
      p.drive_folder_url ? { icon: '📁', label: 'Open the Drive folder', href: p.drive_folder_url } : null,
      p.pdf_drive_url ? { icon: '📄', label: 'Download the profile PDF', href: p.pdf_drive_url } : null,
    ].filter(Boolean) as Array<{ icon: string; label: string; href: string }>,
    body: `It's already in your Google account. Add notes, share with your team, edit anything — there's no signup, no app to install. If you'd like to capture every supplier or buyer at your next show the same way, just reply.`,
    footer: 'Sent via DaGama SourceBot · heydagama.com',
  });

  return { subject, html, text };
}

function renderE2(p: ProspectRow): RenderedEmail {
  const subject = `Quick follow-up — your sheet is still there`;
  const text =
    `Morning ${p.prospect_name ?? 'there'},\n\n` +
    `Just a quick reminder — the sheet from ${p.show_name_raw ?? 'the show'} is still in your Google Drive: ${p.sheet_url ?? ''}\n\n` +
    `It's free, yours forever, and you can add notes whenever.\n\n` +
    `If you've got another show coming up and want to scan every supplier you meet, hit reply and we'll set you up.\n\n` +
    `— DaGama`;
  const html = ledgerEmail({
    eyebrow: 'DaGama · SourceBot',
    title: `Morning — your sheet is still there.`,
    intro: `From <b>${escapeHtml(p.show_name_raw ?? 'the show')}</b>, in your own Google account, free forever.`,
    cards: p.sheet_url ? [{ icon: '📊', label: 'Open the sheet', href: p.sheet_url }] : [],
    body: `Got another show coming up? Reply to this email and we'll set you up to capture every supplier or buyer the same way you got this one.`,
    footer: 'Sent via DaGama SourceBot · heydagama.com',
  });
  return { subject, html, text };
}

function renderE3(p: ProspectRow): RenderedEmail {
  const subject = `${p.show_name_raw ?? 'The show'} is over — what's next?`;
  const text =
    `Hi ${p.prospect_name ?? 'there'},\n\n` +
    `${p.show_name_raw ?? 'The show'} is wrapped. The sheet, the Drive folder — it's all still yours, sitting in your Google account.\n\n` +
    `Most buyers we work with capture 50–200 suppliers per show. We did this one for you in 30 seconds. ` +
    `Want that for your team at the next show? $49 per show, no subscription. Use code DEMO2026 for 20% off.\n\n` +
    `${p.sheet_url ?? ''}\n\n— DaGama`;
  const html = ledgerEmail({
    eyebrow: 'DaGama · SourceBot',
    title: `${escapeHtml(p.show_name_raw ?? 'The show')} is wrapped.`,
    intro: `Your sheet, your Drive folder — still yours, in your own Google account.`,
    cards: p.sheet_url ? [{ icon: '📊', label: 'Open the sheet', href: p.sheet_url }] : [],
    body: `Most buyers we work with capture 50–200 suppliers per show. We did this one for you in 30 seconds. Want that at your next show? <b>$49 per show</b>, no subscription. Code <b>DEMO2026</b> for 20% off.`,
    cta: { label: 'See pricing', href: 'https://heydagama.com#pricing' },
    footer: 'Sent via DaGama SourceBot · heydagama.com',
  });
  return { subject, html, text };
}

function renderE4(p: ProspectRow, nextShow: { name: string; starts: string } | null): RenderedEmail {
  const showHook = nextShow ? `Heading to ${nextShow.name}?` : `Heading to another show?`;
  const subject = `${showHook} Bring DaGama`;
  const text =
    `Hi ${p.prospect_name ?? 'there'},\n\n` +
    (nextShow
      ? `${nextShow.name} starts ${nextShow.starts}. Pre-paid show pass = $49 (20% off with DEMO2026 = $39.20).\n\n`
      : `If you've got another show coming up, the same scan-and-go workflow that gave you this sheet costs $49 per show.\n\n`) +
    `Open your existing sheet anytime: ${p.sheet_url ?? ''}\n\n— DaGama`;
  const html = ledgerEmail({
    eyebrow: 'DaGama · SourceBot',
    title: showHook,
    intro: nextShow
      ? `${escapeHtml(nextShow.name)} starts <b>${escapeHtml(nextShow.starts)}</b>. Same workflow — scan, capture, sheet appears.`
      : `If you've got another show coming up, the same scan-and-go workflow that gave you this sheet costs <b>$49 per show</b>.`,
    cards: p.sheet_url ? [{ icon: '📊', label: 'Open your existing sheet', href: p.sheet_url }] : [],
    body: `Use code <b>DEMO2026</b> at checkout for 20% off your first show ($39.20).`,
    cta: { label: 'Get a show pass', href: 'https://heydagama.com#pricing' },
    footer: 'Sent via DaGama SourceBot · heydagama.com',
  });
  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Digital Ledger email shell. Inline CSS only — most clients strip <style>.
// ─────────────────────────────────────────────────────────────────────────────
interface LedgerArgs {
  eyebrow: string;
  title:   string;
  intro:   string;
  cards:   Array<{ icon: string; label: string; href: string }>;
  body:    string;
  cta?:    { label: string; href: string };
  footer:  string;
}
function ledgerEmail(a: LedgerArgs): string {
  const cardRows = a.cards.map(c =>
    `<a href="${escapeAttr(c.href)}" style="display:block;background:${BRAND_VIOLET_SOFT};border:1px solid ${BRAND_BORDER};color:${BRAND_TITANIUM};text-decoration:none;padding:14px 18px;border-radius:8px;margin-bottom:8px;font-weight:500;">
       <span style="margin-right:10px;">${c.icon}</span>${escapeHtml(c.label)} →
     </a>`
  ).join('');

  const ctaBtn = a.cta
    ? `<p style="margin:24px 0;"><a href="${escapeAttr(a.cta.href)}" style="display:inline-block;background:${BRAND_VIOLET};color:${BRAND_OBSIDIAN};font-weight:600;padding:12px 22px;border-radius:6px;text-decoration:none;">${escapeHtml(a.cta.label)}</a></p>`
    : '';

  return `<!DOCTYPE html>
<html><body style="margin:0;background:${BRAND_OBSIDIAN};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${BRAND_TITANIUM};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_OBSIDIAN};">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND_OBSIDIAN};border:1px solid ${BRAND_BORDER};border-radius:12px;">
        <tr><td style="padding:32px;">
          <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND_VIOLET};margin-bottom:16px;">${escapeHtml(a.eyebrow)}</div>
          <h1 style="font-size:24px;font-weight:600;line-height:1.3;margin:0 0 16px 0;color:${BRAND_TITANIUM};">${a.title}</h1>
          <p style="font-size:15px;line-height:1.6;color:${BRAND_TITANIUM};margin:0 0 20px 0;">${a.intro}</p>
          ${cardRows}
          <p style="font-size:14px;line-height:1.6;color:${BRAND_TITANIUM_MUTED};margin:20px 0 0 0;">${a.body}</p>
          ${ctaBtn}
          <hr style="border:none;border-top:1px solid ${BRAND_BORDER};margin:28px 0 16px 0;">
          <p style="font-size:11px;color:${BRAND_TITANIUM_MUTED};margin:0;">${escapeHtml(a.footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function startOfUtcDay(unixSec: number): number {
  return unixSec - (unixSec % (24 * 3600));
}
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s: string): string { return escapeHtml(s).replace(/"/g, '&quot;'); }
