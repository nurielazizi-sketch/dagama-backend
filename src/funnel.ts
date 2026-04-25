/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { sendTransactionalEmail } from './email';

// ─────────────────────────────────────────────────────────────────────────────
// SourceBot funnel emails — the conversion engine.
//
// Spec defines six touchpoints (all relative to a buyer's first scan at a show):
//   welcome      — T+0           (already sent at signup; scheduler is a no-op)
//   digest_6pm   — Day 1 18:00   end-of-day digest with the captured suppliers
//   morning_8am  — Day 2 08:00   "morning proof" — what your sheet looks like now
//   midday_2pm   — Day 2 14:00   only for 2-day shows; nudge if scans remain
//   post_3d      — show_end + 3d thank-you + sheet recap
//   retarget_4w  — show_end + 28d retargeting before the next show
// ─────────────────────────────────────────────────────────────────────────────

export type FunnelKind = 'welcome' | 'digest_6pm' | 'morning_8am' | 'midday_2pm' | 'post_3d' | 'retarget_4w' | 'custom';

interface ScheduleArgs {
  buyerId:       string;
  showId:        string;
  firstScanAt:   number;        // unix seconds
  durationDays:  number;
  showEndDate?:  string | null; // YYYY-MM-DD, optional
  timezoneOffsetMins?: number;  // 0 = UTC. Best-effort; defaulted from buyers.timezone if available.
}

// Schedule the full funnel relative to a buyer's first scan. Idempotent —
// won't double-insert a row if (buyer_id, show_id, kind) already exists.
export async function scheduleFunnelOnFirstScan(args: ScheduleArgs, env: Env): Promise<void> {
  const tzMins = args.timezoneOffsetMins ?? 0;

  // Day 1 = the day of first scan (in buyer's local time). 18:00 local = the 6pm digest.
  const day1Local = startOfLocalDay(args.firstScanAt, tzMins);
  const day2Local = day1Local + 24 * 3600;

  const items: Array<{ kind: FunnelKind; at: number }> = [
    { kind: 'digest_6pm',  at: day1Local + 18 * 3600 },
    { kind: 'morning_8am', at: day2Local +  8 * 3600 },
  ];

  if (args.durationDays === 2) {
    items.push({ kind: 'midday_2pm', at: day2Local + 14 * 3600 });
  }

  // post_3d / retarget_4w anchor on show_end_date if known, else first_scan + duration_days.
  let showEnd = args.firstScanAt + args.durationDays * 24 * 3600;
  if (args.showEndDate) {
    const parsed = Date.parse(args.showEndDate);
    if (!Number.isNaN(parsed)) showEnd = Math.floor(parsed / 1000);
  }
  items.push({ kind: 'post_3d',     at: showEnd + 3  * 24 * 3600 });
  items.push({ kind: 'retarget_4w', at: showEnd + 28 * 24 * 3600 });

  for (const item of items) {
    // Skip if the time has already passed (e.g. backfilling a buyer mid-show)
    if (item.at < Math.floor(Date.now() / 1000)) continue;

    // Idempotent: only insert if none for this (buyer, show, kind) exists.
    await env.DB.prepare(
      `INSERT INTO email_queue (buyer_id, show_id, kind, scheduled_at, status)
       SELECT ?, ?, ?, ?, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM email_queue WHERE buyer_id = ? AND show_id = ? AND kind = ?
        )`
    ).bind(args.buyerId, args.showId, item.kind, item.at, args.buyerId, args.showId, item.kind).run();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron-driven processor. Picks every ready row, renders, sends, marks status.
// ─────────────────────────────────────────────────────────────────────────────
export async function processFunnelQueue(env: Env): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    `SELECT q.id, q.buyer_id, q.show_id, q.kind, q.payload_json,
            b.email AS buyer_email, b.name AS buyer_name, b.timezone,
            s.show_name, s.duration_days, s.first_scan_at, s.sheet_url, s.paid_plan
       FROM email_queue q
       JOIN sb_buyers       b ON b.id = q.buyer_id
       LEFT JOIN sb_buyer_shows s ON s.id = q.show_id
      WHERE q.status = 'pending' AND q.scheduled_at <= ?
      ORDER BY q.scheduled_at
      LIMIT 50`
  ).bind(now).all<{
    id: string; buyer_id: string; show_id: string | null; kind: FunnelKind;
    payload_json: string | null;
    buyer_email: string; buyer_name: string; timezone: string | null;
    show_name: string | null; duration_days: number | null; first_scan_at: number | null;
    sheet_url: string | null; paid_plan: string | null;
  }>();

  let sent = 0, failed = 0, skipped = 0;
  for (const row of due.results) {
    try {
      // Snapshot data for the email
      const counts = row.show_id ? await getShowSnapshot(row.buyer_id, row.show_id, env) : { suppliers: 0, products: 0, voiceNotes: 0 };
      const tpl = renderFunnelEmail(row.kind, {
        buyerName:   row.buyer_name,
        buyerEmail:  row.buyer_email,
        showName:    row.show_name ?? 'your show',
        sheetUrl:    row.sheet_url ?? `${env.ORIGIN}/dashboard`,
        suppliers:   counts.suppliers,
        products:    counts.products,
        voiceNotes:  counts.voiceNotes,
        paidPlan:    row.paid_plan,
        origin:      env.ORIGIN,
      });

      // Skip if nothing meaningful happened (e.g. digest with 0 captures)
      if (tpl.skipIfEmpty && counts.suppliers === 0) {
        await env.DB.prepare(`UPDATE email_queue SET status = 'skipped', sent_at = ? WHERE id = ?`).bind(now, row.id).run();
        skipped++;
        continue;
      }

      const ok = await sendTransactionalEmail({
        to: row.buyer_email, toName: row.buyer_name,
        subject: tpl.subject, html: tpl.html, text: tpl.text,
      }, env);

      if (ok) {
        await env.DB.prepare(`UPDATE email_queue SET status = 'sent', sent_at = ? WHERE id = ?`).bind(now, row.id).run();
        await trackEvent(env, {
          buyerId: row.buyer_id, showId: row.show_id, eventName: `email_${row.kind}_sent`,
          properties: { suppliers: counts.suppliers, products: counts.products },
        });
        sent++;
      } else {
        // Central email account not configured — leave as pending and log
        console.log(`[funnel] would send ${row.kind} to ${row.buyer_email} (DAGAMA_NOREPLY not configured)`);
        // Mark as skipped so we don't re-try forever; can re-queue manually
        await env.DB.prepare(`UPDATE email_queue SET status = 'skipped', error = 'transactional account not configured' WHERE id = ?`).bind(row.id).run();
        skipped++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await env.DB.prepare(`UPDATE email_queue SET status = 'failed', error = ?, sent_at = ? WHERE id = ?`).bind(msg.slice(0, 500), now, row.id).run();
      failed++;
    }
  }
  return { sent, failed, skipped };
}

async function getShowSnapshot(buyerId: string, showId: string, env: Env): Promise<{ suppliers: number; products: number; voiceNotes: number }> {
  const r = await env.DB.prepare(
    `SELECT
        (SELECT COUNT(*) FROM sb_companies   c WHERE c.buyer_id = ? AND c.show_name = (SELECT show_name FROM sb_buyer_shows WHERE id = ?)) AS suppliers,
        (SELECT COUNT(*) FROM sb_products    p WHERE p.buyer_id = ? AND p.show_name = (SELECT show_name FROM sb_buyer_shows WHERE id = ?)) AS products,
        (SELECT COUNT(*) FROM sb_voice_notes v WHERE v.buyer_id = ? AND v.show_name = (SELECT show_name FROM sb_buyer_shows WHERE id = ?)) AS voiceNotes`
  ).bind(buyerId, showId, buyerId, showId, buyerId, showId).first<{ suppliers: number; products: number; voiceNotes: number }>();
  return { suppliers: r?.suppliers ?? 0, products: r?.products ?? 0, voiceNotes: r?.voiceNotes ?? 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates (subject + html + text per kind). Keep them lean — they can be
// iterated on without touching scheduler logic.
// ─────────────────────────────────────────────────────────────────────────────
interface RenderInput {
  buyerName:  string;
  buyerEmail: string;
  showName:   string;
  sheetUrl:   string;
  suppliers:  number;
  products:   number;
  voiceNotes: number;
  paidPlan:   string | null;
  origin:     string;
}
interface RenderedEmail { subject: string; html: string; text: string; skipIfEmpty?: boolean }

function renderFunnelEmail(kind: FunnelKind, d: RenderInput): RenderedEmail {
  switch (kind) {
    case 'digest_6pm': {
      const subject = `📋 ${d.suppliers} supplier${d.suppliers === 1 ? '' : 's'} captured at ${d.showName} today`;
      const text =
        `Hi ${d.buyerName},\n\n` +
        `Quick recap of your day at ${d.showName}:\n\n` +
        `• ${d.suppliers} suppliers\n• ${d.products} products\n• ${d.voiceNotes} voice notes\n\n` +
        `Open your sheet — every photo, contact, and note is already in there:\n${d.sheetUrl}\n\n` +
        `Tomorrow morning we'll send a recap with photos. Capture more tomorrow on Telegram.\n\n— DaGama`;
      const html = `<p>Hi ${escapeHtml(d.buyerName)},</p>
<p>Quick recap of your day at <b>${escapeHtml(d.showName)}</b>:</p>
<ul><li>${d.suppliers} suppliers</li><li>${d.products} products</li><li>${d.voiceNotes} voice notes</li></ul>
<p><a href="${escapeAttr(d.sheetUrl)}">Open your live sheet →</a></p>
<p style="color:#64748B;font-size:12px;">Tomorrow morning we'll send a recap with photos. Reply STOP to unsubscribe.</p>`;
      return { subject, html, text, skipIfEmpty: true };
    }
    case 'morning_8am': {
      const subject = `Good morning — your ${d.showName} sheet`;
      const text =
        `Morning ${d.buyerName} 👋\n\n` +
        `Yesterday you captured ${d.suppliers} suppliers and ${d.products} products at ${d.showName}.\n` +
        `Everything's in your sheet, ready to share with your team:\n${d.sheetUrl}\n\n` +
        `New day, fresh leads. Just send card photos to the bot — same as yesterday.\n\n— DaGama`;
      const html = `<p>Morning ${escapeHtml(d.buyerName)} 👋</p>
<p>Yesterday at <b>${escapeHtml(d.showName)}</b>: <b>${d.suppliers} suppliers</b> · <b>${d.products} products</b>.</p>
<p>Everything is sitting in your sheet, ready to share with your team:</p>
<p><a href="${escapeAttr(d.sheetUrl)}" style="background:#0066ff;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">Open the sheet</a></p>
<p>New day — keep capturing. Just send card photos to the bot.</p>`;
      return { subject, html, text, skipIfEmpty: true };
    }
    case 'midday_2pm': {
      const subject = `Last hours at ${d.showName} — keep capturing`;
      const text =
        `${d.buyerName}, the day's almost done at ${d.showName}.\n\n` +
        `Your snapshot so far: ${d.suppliers} suppliers · ${d.products} products.\n\n` +
        `Most buyers find their best deals in the final hour. Keep snapping cards — every one lands in your sheet:\n${d.sheetUrl}\n\n— DaGama`;
      const html = `<p>${escapeHtml(d.buyerName)}, the day's almost done at <b>${escapeHtml(d.showName)}</b>.</p>
<p>Your snapshot so far: <b>${d.suppliers} suppliers · ${d.products} products</b>.</p>
<p>Most buyers find their best deals in the final hour. <a href="${escapeAttr(d.sheetUrl)}">Open your sheet</a>.</p>`;
      return { subject, html, text };
    }
    case 'post_3d': {
      const subject = `Your ${d.showName} sourcing recap`;
      const text =
        `Hi ${d.buyerName},\n\n` +
        `${d.showName} is wrapped. Here's what you walked away with:\n\n` +
        `• ${d.suppliers} suppliers\n• ${d.products} products\n• ${d.voiceNotes} voice notes\n\n` +
        `Now's the time to follow up with the suppliers worth pursuing. Try /pending on the bot to see who's still waiting on an email, or open the sheet:\n${d.sheetUrl}\n\n` +
        `What did you think of DaGama? Reply to this email — I read every one.\n\n— DaGama`;
      const html = `<p>Hi ${escapeHtml(d.buyerName)},</p>
<p><b>${escapeHtml(d.showName)}</b> is wrapped. You walked away with:</p>
<ul><li><b>${d.suppliers}</b> suppliers</li><li><b>${d.products}</b> products</li><li><b>${d.voiceNotes}</b> voice notes</li></ul>
<p>Now's the time to follow up. <a href="${escapeAttr(d.sheetUrl)}">Open the sheet →</a></p>
<p>How was DaGama for you? Hit reply — I read every one.</p>`;
      return { subject, html, text, skipIfEmpty: true };
    }
    case 'retarget_4w': {
      const subject = `Heading to another show? Bring DaGama`;
      const text =
        `Hi ${d.buyerName},\n\n` +
        `It's been four weeks since ${d.showName}. If you've got another show coming up, you can spin up a fresh DaGama sheet in 30 seconds — just hit /newshow on the bot, or sign up for an additional pass at ${d.origin}.\n\n` +
        `Last show you captured ${d.suppliers} suppliers and ${d.products} products. Imagine doing that for every show you go to.\n\n— DaGama`;
      const html = `<p>Hi ${escapeHtml(d.buyerName)},</p>
<p>It's been four weeks since <b>${escapeHtml(d.showName)}</b>. Got another show coming up?</p>
<p>Spin up a fresh DaGama sheet in 30 seconds — just hit <code>/newshow</code> on the bot, or grab a pass at <a href="${escapeAttr(d.origin)}">${escapeAttr(d.origin)}</a>.</p>
<p>Last show you captured <b>${d.suppliers}</b> suppliers and <b>${d.products}</b> products. Imagine doing that for every show.</p>`;
      return { subject, html, text };
    }
    case 'welcome':
    case 'custom':
    default:
      // welcome is sent at signup via the dedicated path; if scheduled, just no-op.
      return { subject: '', html: '', text: '', skipIfEmpty: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event tracking helper. Keep it cheap (one INSERT) so we can call it freely.
// ─────────────────────────────────────────────────────────────────────────────
export async function trackEvent(env: Env, args: { buyerId: string | null; showId?: string | null; eventName: string; properties?: Record<string, unknown> }): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO events (buyer_id, show_id, event_name, properties_json) VALUES (?, ?, ?, ?)`
    ).bind(
      args.buyerId,
      args.showId ?? null,
      args.eventName,
      args.properties ? JSON.stringify(args.properties) : null,
    ).run();
  } catch (e) { console.error('[events] insert failed:', e); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function startOfLocalDay(unixSec: number, tzMins: number): number {
  // Round down to local midnight. tzMins is the buyer's offset from UTC.
  const localized = unixSec + tzMins * 60;
  const dayStart = localized - (localized % (24 * 3600));
  return dayStart - tzMins * 60;
}
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s: string): string { return escapeHtml(s).replace(/"/g, '&quot;'); }
