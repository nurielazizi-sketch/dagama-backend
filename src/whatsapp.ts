/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { routeToDemoBot, tryClaimAsDemoBot } from './demobot_wa';
import { handleCardCapture, resolveActiveShow } from './capture';
import {
  captureSupplierFromPhoto,
  attachCardBack,
  attachPersonPhoto,
  attachVoiceNote,
  attachProductFromPhoto,
  updateProductDetails,
  parseProductDetailsText,
} from './sourcebot_core';

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Cloud API integration. Behind a feature flag (isWhatsAppEnabled):
// when secrets are unset, the webhook returns 503 and outbound calls no-op.
// Once Meta approval lands, set the five WHATSAPP_* secrets via
// `wrangler secret put` and the channel goes live without code changes.
//
// Inbound:  GET  /api/whatsapp/webhook  → hub.challenge echo (subscribe handshake)
//           POST /api/whatsapp/webhook  → message + status events
//
// Routing:  wa_user_mappings.bot_role decides BoothBot vs SourceBot. New numbers
//           are 'unassigned' until the user sends a deep-link join token (or we
//           pick a default role). The actual handler hand-off is stubbed —
//           wired up once we have one shared "user message" abstraction.
//
// Out of scope here: building the BoothBot/SourceBot WhatsApp message pipelines
// (those reuse extract.ts, sb_sheets.ts, etc., once the bridge calls land).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_GRAPH_VERSION = 'v21.0';

// ── Feature flag ─────────────────────────────────────────────────────────────

export function isWhatsAppEnabled(env: Env): boolean {
  return !!(
    env.WHATSAPP_VERIFY_TOKEN &&
    env.WHATSAPP_APP_SECRET &&
    env.WHATSAPP_ACCESS_TOKEN &&
    env.WHATSAPP_PHONE_NUMBER_ID &&
    env.WHATSAPP_BUSINESS_ACCOUNT_ID
  );
}

function graphBase(env: Env): string {
  const v = env.WHATSAPP_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  return `https://graph.facebook.com/${v}`;
}

// ── Webhook payload types (subset we use) ────────────────────────────────────

interface WaProfile { name?: string }
interface WaContact { wa_id: string; profile?: WaProfile }

interface WaText { body: string }
interface WaImage { id: string; mime_type?: string; sha256?: string; caption?: string }
interface WaAudio { id: string; mime_type?: string; sha256?: string; voice?: boolean }
interface WaVideo { id: string; mime_type?: string; sha256?: string; caption?: string }
interface WaDocument { id: string; mime_type?: string; sha256?: string; filename?: string; caption?: string }
interface WaInteractiveButtonReply { id: string; title: string }
interface WaInteractiveListReply   { id: string; title: string; description?: string }
interface WaInteractive {
  type: 'button_reply' | 'list_reply';
  button_reply?: WaInteractiveButtonReply;
  list_reply?:   WaInteractiveListReply;
}
interface WaReaction { message_id: string; emoji?: string }

interface WaInboundMessage {
  id:        string;          // wamid.HBgM...
  from:      string;          // E.164 without '+'
  timestamp: string;          // unix epoch as string
  type:      'text' | 'image' | 'audio' | 'video' | 'document' | 'interactive' | 'reaction' | 'location' | 'contacts' | 'button' | 'sticker' | 'unknown';
  text?:        WaText;
  image?:       WaImage;
  audio?:       WaAudio;
  video?:       WaVideo;
  document?:    WaDocument;
  interactive?: WaInteractive;
  reaction?:    WaReaction;
}

interface WaStatus {
  id:           string;       // outbound wamid we sent
  status:       'sent' | 'delivered' | 'read' | 'failed';
  timestamp:    string;
  recipient_id: string;
  errors?: Array<{ code: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

interface WaChangeValue {
  messaging_product: 'whatsapp';
  metadata?: { display_phone_number: string; phone_number_id: string };
  contacts?: WaContact[];
  messages?: WaInboundMessage[];
  statuses?: WaStatus[];
}
interface WaChange { field: string; value: WaChangeValue }
interface WaEntry  { id: string; changes: WaChange[] }
interface WaWebhookPayload { object: string; entry: WaEntry[] }

// ── Webhook entry point ──────────────────────────────────────────────────────

export async function handleWhatsAppWebhook(request: Request, env: Env): Promise<Response> {
  if (!isWhatsAppEnabled(env)) {
    console.warn('[whatsapp] webhook hit but feature is disabled (secrets unset)');
    return new Response('Service unavailable', { status: 503 });
  }

  if (request.method === 'GET')  return handleVerify(request, env);
  if (request.method === 'POST') return handleEvent(request, env);
  return new Response('Method not allowed', { status: 405 });
}

// ── GET: Meta subscribe handshake ────────────────────────────────────────────
// Meta sends ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... once
// when the webhook URL is registered. Echo the challenge if the token matches.

function handleVerify(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  console.warn('[whatsapp] verify failed', { mode, tokenMatch: token === env.WHATSAPP_VERIFY_TOKEN });
  return new Response('Forbidden', { status: 403 });
}

// ── POST: inbound events (messages + statuses) ───────────────────────────────

async function handleEvent(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('x-hub-signature-256') ?? '';

  const valid = await verifyMetaSignature(rawBody, sigHeader, env.WHATSAPP_APP_SECRET!);
  if (!valid) {
    console.warn('[whatsapp] signature verification failed');
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: WaWebhookPayload;
  try { payload = JSON.parse(rawBody) as WaWebhookPayload; }
  catch { return new Response('Bad request', { status: 400 }); }

  if (payload.object !== 'whatsapp_business_account') {
    return new Response('OK', { status: 200 }); // ignore unrelated events silently
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;

      // Inbound user messages
      for (const msg of value.messages ?? []) {
        try { await handleInboundMessage(msg, value, env); }
        catch (e) { console.error('[whatsapp] inbound handler failed', { wamid: msg.id, error: e instanceof Error ? e.message : String(e) }); }
      }

      // Outbound status callbacks
      for (const status of value.statuses ?? []) {
        try { await recordStatus(status, env); }
        catch (e) { console.error('[whatsapp] status handler failed', { wamid: status.id, error: e instanceof Error ? e.message : String(e) }); }
      }
    }
  }

  // Always 200 — Meta will retry on non-2xx, which we don't want for handler bugs.
  return new Response('OK', { status: 200 });
}

// ── Inbound message processing ───────────────────────────────────────────────

async function handleInboundMessage(msg: WaInboundMessage, value: WaChangeValue, env: Env): Promise<void> {
  // Idempotency: WA delivers webhooks at-least-once.
  const insertResult = await env.DB.prepare(
    `INSERT OR IGNORE INTO wa_inbound_messages (wamid, phone, msg_type, received_at, raw_json)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    msg.id,
    msg.from,
    msg.type,
    parseInt(msg.timestamp, 10) || Math.floor(Date.now() / 1000),
    JSON.stringify(msg).slice(0, 8192),
  ).run();
  if ((insertResult.meta.changes ?? 0) === 0) {
    return; // already processed
  }

  // Upsert sender mapping
  const profileName = value.contacts?.find(c => c.wa_id === msg.from)?.profile?.name ?? null;
  await env.DB.prepare(
    `INSERT INTO wa_user_mappings (phone, display_name)
     VALUES (?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, wa_user_mappings.display_name),
       updated_at   = datetime('now')`
  ).bind(msg.from, profileName).run();

  const mapping = await env.DB.prepare(
    `SELECT id, phone, user_id, buyer_id, bot_role, session, display_name FROM wa_user_mappings WHERE phone = ? LIMIT 1`
  ).bind(msg.from).first<{ id: string; phone: string; user_id: string | null; buyer_id: string | null; bot_role: string; session: string | null; display_name: string | null }>();

  if (!mapping) {
    console.error('[whatsapp] failed to load mapping after upsert', { phone: msg.from });
    return;
  }

  // Route. The actual BoothBot/SourceBot WhatsApp pipelines are not yet wired —
  // for now we acknowledge with a placeholder so flipping the channel on for
  // testing produces visible output. DemoBot is fully wired (demobot_wa.ts).
  try {
    if (mapping.bot_role === 'demobot') {
      await routeToDemoBot(msg, mapping, env);
    } else if (mapping.bot_role === 'sourcebot') {
      await routeToSourceBot(msg, mapping, env);
    } else if (mapping.bot_role === 'boothbot') {
      await routeToBoothBot(msg, mapping, env);
    } else {
      await handleUnassignedMessage(msg, mapping, env);
    }
    await env.DB.prepare(`UPDATE wa_inbound_messages SET processed = 1 WHERE wamid = ?`).bind(msg.id).run();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(`UPDATE wa_inbound_messages SET error = ? WHERE wamid = ?`).bind(errMsg.slice(0, 500), msg.id).run();
    throw e;
  }
}

// BoothBot WhatsApp router. For image messages we call the channel-agnostic
// capture pipeline (capture.ts). All other types get a help nudge for now.
// SourceBot stays stubbed in this phase — its multi-step session needs more
// scaffolding before WhatsApp can carry it.

interface WaMapping {
  phone:    string;
  user_id:  string | null;
  buyer_id: string | null;
  bot_role: string;
  session?: string | null;        // JSON-serialized session state (SourceBot multi-step)
}

// SourceBot multi-step session — parallel to sourcebot.ts SourceBotSession but
// keyed by phone (wa_user_mappings.session) instead of telegram_chat_id.
interface SbWaSession {
  step?:            'awaiting_card_back' | 'awaiting_person_photo' | 'awaiting_voice_note';
  activeCompanyId?: string;
  activeProductId?: string;     // last product captured — used for free-text detail replies
}

function parseSbSession(raw: string | null | undefined): SbWaSession {
  if (!raw) return {};
  try { return JSON.parse(raw) as SbWaSession; } catch { return {}; }
}

async function saveSbSession(phone: string, session: SbWaSession, env: Env): Promise<void> {
  const value = Object.keys(session).length === 0 ? null : JSON.stringify(session);
  await env.DB.prepare(
    `UPDATE wa_user_mappings SET session = ?, updated_at = datetime('now') WHERE phone = ?`
  ).bind(value, phone).run();
}

async function routeToBoothBot(msg: WaInboundMessage, mapping: WaMapping, env: Env): Promise<void> {
  console.log('[whatsapp][boothbot] inbound', { phone: mapping.phone, type: msg.type, wamid: msg.id });

  if (!mapping.user_id) {
    // Mapping should always have user_id when bot_role='boothbot' (set during
    // join-token consumption). Defensive log + nudge.
    console.error('[whatsapp][boothbot] missing user_id on mapping', { phone: mapping.phone });
    await sendWhatsAppText(mapping.phone, `Your account isn't fully linked yet. Please open ${env.ORIGIN} and finish onboarding.`, env);
    return;
  }

  if (msg.type !== 'image') {
    await sendWhatsAppText(
      mapping.phone,
      `📸 Send a photo of a business card and I'll extract the contact details into your sheet.`,
      env,
    );
    return;
  }

  // Resolve which show this capture belongs to. We fall back to a generic
  // bucket if onboarding wasn't completed (rare — user_id implies onboarding).
  const showName = (await resolveActiveShow(mapping.user_id, env)) ?? 'WhatsApp Captures';

  // Pull the media bytes (auth'd graph call, cached in R2 by media_id).
  const mediaId = msg.image?.id;
  if (!mediaId) {
    await sendWhatsAppText(mapping.phone, `Couldn't read that photo. Try sending it again.`, env);
    return;
  }
  const media = await fetchWhatsAppMedia(mediaId, env);
  if (!media) {
    await sendWhatsAppText(mapping.phone, `Couldn't download that photo. Try sending it again.`, env);
    return;
  }

  await handleCardCapture({
    userId:   mapping.user_id,
    showName,
    botRole:  'boothbot',
    channel:  'whatsapp',
    media:    { kind: 'r2_key', key: media.r2Key, mimeType: media.mimeType },
    caption:  msg.image?.caption,
    reply:    { channel: 'whatsapp', phone: mapping.phone },
  }, env);
}

// SourceBot WhatsApp router.
//   Phase 1: front-of-card supplier capture
//   Phase 2: card-back + person-photo extensions (this phase). After a supplier
//            is captured we send a quick-reply button set; tapping a button
//            stores `step` + `activeCompanyId` on wa_user_mappings.session, and
//            the next image is routed to the corresponding attach* helper.
// Subsequent phases (voice, products, email, find/PDF) extend the same pattern.

async function routeToSourceBot(msg: WaInboundMessage, mapping: WaMapping, env: Env): Promise<void> {
  console.log('[whatsapp][sourcebot] inbound', { phone: mapping.phone, type: msg.type, wamid: msg.id });

  if (!mapping.buyer_id) {
    console.error('[whatsapp][sourcebot] missing buyer_id on mapping', { phone: mapping.phone });
    await sendWhatsAppText(
      mapping.phone,
      `Your account isn't fully linked yet. Please open ${env.ORIGIN} and finish onboarding.`,
      env,
    );
    return;
  }

  const session = parseSbSession(mapping.session);

  // 1. Interactive button reply → set step + active company.
  if (msg.type === 'interactive' && msg.interactive?.button_reply) {
    const id = msg.interactive.button_reply.id;
    if (id.startsWith('sb_back:')) {
      await saveSbSession(mapping.phone, { step: 'awaiting_card_back', activeCompanyId: id.slice('sb_back:'.length) }, env);
      await sendWhatsAppText(mapping.phone, `📷 Send the back of the card now.`, env);
      return;
    }
    if (id.startsWith('sb_person:')) {
      await saveSbSession(mapping.phone, { step: 'awaiting_person_photo', activeCompanyId: id.slice('sb_person:'.length) }, env);
      await sendWhatsAppText(mapping.phone, `👤 Send a photo of the person, booth, or signage.`, env);
      return;
    }
    if (id.startsWith('sb_voice:')) {
      await saveSbSession(mapping.phone, { step: 'awaiting_voice_note', activeCompanyId: id.slice('sb_voice:'.length) }, env);
      await sendWhatsAppText(mapping.phone, `🎤 Hold the mic and record a voice note about this supplier — price, MOQ, lead time, anything you want to remember.`, env);
      return;
    }
    if (id === 'sb_done') {
      await saveSbSession(mapping.phone, {}, env);
      await sendWhatsAppText(mapping.phone, `✅ Done. Send another card photo to capture the next supplier.`, env);
      return;
    }
  }

  // 2a. Image during a card-back / person-photo extension flow.
  if (msg.type === 'image' && (session.step === 'awaiting_card_back' || session.step === 'awaiting_person_photo') && session.activeCompanyId) {
    const mediaId = msg.image?.id;
    if (!mediaId) { await sendWhatsAppText(mapping.phone, `Couldn't read that photo. Try sending it again.`, env); return; }
    const media = await fetchWhatsAppMedia(mediaId, env);
    if (!media) { await sendWhatsAppText(mapping.phone, `Couldn't download that photo. Try sending it again.`, env); return; }

    const fn = session.step === 'awaiting_card_back' ? attachCardBack : attachPersonPhoto;
    await fn({
      companyId: session.activeCompanyId,
      buyerId:   mapping.buyer_id,
      channel:   'whatsapp',
      media:     { kind: 'r2_key', key: media.r2Key, mimeType: media.mimeType },
      reply:     { channel: 'whatsapp', phone: mapping.phone },
    }, env);

    // Reset to free state — next image will be a brand-new supplier capture.
    await saveSbSession(mapping.phone, {}, env);
    return;
  }

  // 2b. Voice/audio. Two routes:
  //     - explicit 'awaiting_voice_note' step (the user tapped the 💬 button)
  //     - free-form audio while activeCompanyId is set (the user just sends a
  //       voice note after the supplier capture — natural behaviour on WA).
  if (msg.type === 'audio' && session.activeCompanyId) {
    const mediaId = msg.audio?.id;
    if (!mediaId) { await sendWhatsAppText(mapping.phone, `Couldn't read that audio. Try sending it again.`, env); return; }
    const media = await fetchWhatsAppMedia(mediaId, env);
    if (!media) { await sendWhatsAppText(mapping.phone, `Couldn't download that audio. Try again.`, env); return; }

    await attachVoiceNote({
      companyId:    session.activeCompanyId,
      buyerId:      mapping.buyer_id,
      channel:      'whatsapp',
      media:        { kind: 'r2_key', key: media.r2Key, mimeType: media.mimeType },
      reply:        { channel: 'whatsapp', phone: mapping.phone },
    }, env);

    await saveSbSession(mapping.phone, { activeCompanyId: session.activeCompanyId }, env);
    return;
  }

  // 2c. Free-text reply during a product flow → parse + apply details.
  if (msg.type === 'text' && session.activeProductId && session.activeCompanyId) {
    const text = msg.text?.body?.trim() ?? '';
    if (text) {
      try {
        const parsed = await parseProductDetailsText(text, env);
        await updateProductDetails({
          productId: session.activeProductId,
          buyerId:   mapping.buyer_id,
          price:     parsed.price,
          moq:       parsed.moq,
          leadTime:  parsed.lead_time,
          tone:      parsed.tone,
          notes:     text,
        }, env);
        const extras = [parsed.price, parsed.moq && `MOQ ${parsed.moq}`, parsed.lead_time, parsed.tone].filter(Boolean).join(' · ');
        await sendWhatsAppText(mapping.phone, `✅ Added to product${extras ? ` — ${extras}` : ''}.`, env);
      } catch (e) {
        console.error('[whatsapp][sourcebot] product details parse failed', e);
        await sendWhatsAppText(mapping.phone, `⚠️ Couldn't parse that. Try again with price/MOQ/lead time on separate lines.`, env);
      }
      return;
    }
  }

  // 3. New supplier capture or product photo. If activeCompanyId is set, the
  // image could be a product OR a brand-new business card — let Gemini decide
  // (attachProductFromPhoto returns 'reclassified_as_card' on a card image).
  if (msg.type !== 'image') {
    await sendWhatsAppText(
      mapping.phone,
      `📸 Send a photo of a supplier's business card and I'll log it into your sheet.`,
      env,
    );
    return;
  }

  const mediaId = msg.image?.id;
  if (!mediaId) {
    await sendWhatsAppText(mapping.phone, `Couldn't read that photo. Try sending it again.`, env);
    return;
  }
  const media = await fetchWhatsAppMedia(mediaId, env);
  if (!media) {
    await sendWhatsAppText(mapping.phone, `Couldn't download that photo. Try sending it again.`, env);
    return;
  }

  if (session.activeCompanyId) {
    const productResult = await attachProductFromPhoto({
      companyId: session.activeCompanyId,
      buyerId:   mapping.buyer_id,
      channel:   'whatsapp',
      media:     { kind: 'r2_key', key: media.r2Key, mimeType: media.mimeType },
      reply:     { channel: 'whatsapp', phone: mapping.phone },
    }, env);
    if (productResult.ok && productResult.productId) {
      // Stash the product id so the next text reply attaches details to it.
      await saveSbSession(mapping.phone, { activeCompanyId: session.activeCompanyId, activeProductId: productResult.productId }, env);
      return;
    }
    if (productResult.status !== 'reclassified_as_card') return;
    // Fallthrough: image was a business card → fall into supplier capture.
    await sendWhatsAppText(mapping.phone, `📷 That looks like a business card — capturing as a new supplier.`, env);
  }

  const result = await captureSupplierFromPhoto({
    buyerId:  mapping.buyer_id,
    channel:  'whatsapp',
    media:    { kind: 'r2_key', key: media.r2Key, mimeType: media.mimeType },
    caption:  msg.image?.caption,
    reply:    { channel: 'whatsapp', phone: mapping.phone },
  }, env);

  // 4. On success, prompt for extensions via interactive buttons.
  if (result.ok && result.companyId) {
    await saveSbSession(mapping.phone, { activeCompanyId: result.companyId }, env);
    try {
      // WhatsApp caps interactive buttons at 3. Voice + card back + person
      // photo are the high-leverage extras; the user implicitly "finishes" by
      // sending a brand-new supplier card.
      await sendWhatsAppButtons(
        mapping.phone,
        `Add more for *${result.contact?.company || 'this supplier'}*? Or send a new card to capture the next supplier.`,
        [
          { id: `sb_voice:${result.companyId}`,  title: '💬 Voice note'   },
          { id: `sb_back:${result.companyId}`,   title: '📷 Card back'   },
          { id: `sb_person:${result.companyId}`, title: '👤 Person'      },
        ],
        env,
      );
    } catch (e) {
      console.error('[whatsapp][sourcebot] post-capture buttons failed', e);
    }
  }
}

async function handleUnassignedMessage(msg: WaInboundMessage, mapping: { id: string; phone: string; bot_role: string; user_id: string | null; buyer_id: string | null; session: string | null; display_name: string | null }, env: Env): Promise<void> {
  // Deep-link onboarding: "join <token>" — exact match to onboarding_tokens.token.
  // Telegram uses /start <token>; on WhatsApp the user pastes the join phrase from
  // the registration confirmation page.
  const text = msg.type === 'text' ? msg.text?.body?.trim() ?? '' : '';

  // 1. DemoBot freelancer flow first — magic words ("demo" / "freelancer") or
  //    "join demo_<token>" flip the mapping to bot_role='demobot' and start
  //    self-serve registration. Returns true if claimed.
  if (text && await tryClaimAsDemoBot(text, mapping, env)) return;

  // 2. Buyer/exhibitor "join <token>" — uses onboarding_tokens.bot_role to decide
  //    boothbot vs sourcebot and binds the WA mapping accordingly.
  const joinMatch = text.match(/^join\s+([A-Za-z0-9_-]+)$/i);
  if (joinMatch) {
    const token = joinMatch[1];
    const consumed = await consumeJoinToken(token, mapping.phone, env);
    if (consumed) {
      const role = consumed.bot_role === 'sourcebot' ? 'SourceBot' : 'BoothBot';
      await sendWhatsAppText(
        mapping.phone,
        `✅ Connected to ${role}. Send a card photo${consumed.bot_role === 'sourcebot' ? ' (front of supplier card)' : ''} to begin.`,
        env,
      );
      return;
    }
  }

  await sendWhatsAppText(
    mapping.phone,
    `👋 Welcome to DaGama. To start, sign up at ${env.ORIGIN} — you'll get a join code that activates this chat.\n\nIf you're a freelancer, just reply "demo" to register.`,
    env,
  );
}

// Consume an onboarding_tokens row and bind this phone to the user/role.
async function consumeJoinToken(token: string, phone: string, env: Env): Promise<{ bot_role: 'boothbot' | 'sourcebot'; user_id: string } | null> {
  const row = await env.DB.prepare(
    `SELECT token, user_id, bot_role, expires_at, used_at FROM onboarding_tokens WHERE token = ? LIMIT 1`
  ).bind(token).first<{ token: string; user_id: string; bot_role: string; expires_at: number; used_at: number | null }>();

  if (!row || row.used_at) return null;
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return null;
  if (row.bot_role !== 'boothbot' && row.bot_role !== 'sourcebot') return null;

  // Look up sb_buyers.id for SourceBot users so the mapping is fully linked.
  let buyerId: string | null = null;
  if (row.bot_role === 'sourcebot') {
    const buyer = await env.DB.prepare(
      `SELECT id FROM sb_buyers WHERE user_id = ? LIMIT 1`
    ).bind(row.user_id).first<{ id: string }>();
    buyerId = buyer?.id ?? null;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE wa_user_mappings
         SET user_id = ?, buyer_id = ?, bot_role = ?, updated_at = datetime('now')
       WHERE phone = ?`
    ).bind(row.user_id, buyerId, row.bot_role, phone),
    env.DB.prepare(
      `UPDATE onboarding_tokens SET used_at = ? WHERE token = ?`
    ).bind(Math.floor(Date.now() / 1000), token),
  ]);

  return { bot_role: row.bot_role as 'boothbot' | 'sourcebot', user_id: row.user_id };
}

// ── Status callback recording ────────────────────────────────────────────────

async function recordStatus(status: WaStatus, env: Env): Promise<void> {
  const err = status.errors?.[0];
  await env.DB.prepare(
    `INSERT INTO wa_message_status (wamid, recipient, status, error_code, error_title, error_detail, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    status.id,
    status.recipient_id,
    status.status,
    err?.code ?? null,
    err?.title ?? null,
    err?.error_data?.details ?? err?.message ?? null,
    parseInt(status.timestamp, 10) || Math.floor(Date.now() / 1000),
  ).run();
}

// ── Signature verification (X-Hub-Signature-256) ─────────────────────────────
// Meta signs the raw POST body with HMAC-SHA256 using the App Secret. Header
// format: 'sha256=<hex>'. Constant-time compare.

async function verifyMetaSignature(rawBody: string, header: string, appSecret: string): Promise<boolean> {
  if (!header.startsWith('sha256=')) return false;
  const provided = header.slice(7).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound client
// ─────────────────────────────────────────────────────────────────────────────

interface SendOptions {
  /** which bot is sending (for the outbound log row) */
  sentBy?: 'boothbot' | 'sourcebot' | 'system';
}

interface GraphSendResponse {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string }>;
  error?: { message: string; type: string; code: number; error_data?: { details?: string } };
}

async function postGraphMessage(body: Record<string, unknown>, env: Env, opts: SendOptions = {}): Promise<{ wamid: string | null; httpStatus: number; raw: string }> {
  const recipient = (body['to'] as string) || 'unknown';
  const msgType = (body['type'] as string) || 'unknown';
  const templateName = msgType === 'template' ? ((body['template'] as { name?: string } | undefined)?.name ?? null) : null;

  if (!isWhatsAppEnabled(env)) {
    console.warn('[whatsapp] send skipped (feature disabled)', { recipient, msgType });
    return { wamid: null, httpStatus: 0, raw: '' };
  }

  const url = `${graphBase(env)}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('[whatsapp] graph fetch failed', { recipient, error: e instanceof Error ? e.message : String(e) });
    return { wamid: null, httpStatus: 0, raw: '' };
  }

  const raw = await res.text();
  let parsed: GraphSendResponse | null = null;
  try { parsed = JSON.parse(raw) as GraphSendResponse; } catch { /* keep raw */ }
  const wamid = parsed?.messages?.[0]?.id ?? null;

  if (!res.ok) {
    console.error('[whatsapp] graph send error', { recipient, msgType, status: res.status, error: parsed?.error });
  }

  // Best-effort log; don't block on this.
  try {
    await env.DB.prepare(
      `INSERT INTO wa_outbound_messages (wamid, recipient, msg_type, template_name, payload_json, response_json, http_status, sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      wamid,
      recipient,
      msgType,
      templateName,
      JSON.stringify(body).slice(0, 8192),
      raw.slice(0, 4096),
      res.status,
      opts.sentBy ?? 'system',
      Math.floor(Date.now() / 1000),
    ).run();
  } catch (e) {
    console.error('[whatsapp] outbound log failed', { error: e instanceof Error ? e.message : String(e) });
  }

  return { wamid, httpStatus: res.status, raw };
}

// ── Public send helpers ──────────────────────────────────────────────────────

export async function sendWhatsAppText(to: string, body: string, env: Env, opts: SendOptions = {}): Promise<{ wamid: string | null }> {
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body, preview_url: false },
  }, env, opts);
  return { wamid: r.wamid };
}

/**
 * Send an approved template message. Required for cold messages outside the
 * 24-hour customer service window. `parameters` are the variables for the body
 * component (positional). Headers/buttons require explicit components — pass a
 * full `components` array instead if you need them.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  language: string,
  env: Env,
  components?: Array<Record<string, unknown>>,
  opts: SendOptions = {},
): Promise<{ wamid: string | null }> {
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  };
  if (components && components.length > 0) template['components'] = components;

  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template,
  }, env, opts);
  return { wamid: r.wamid };
}

/** Reply with up to 3 quick-reply buttons. Each button must have a unique id (max 20 chars) and title (max 20 chars). */
export async function sendWhatsAppButtons(
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
  env: Env,
  opts: SendOptions = {},
): Promise<{ wamid: string | null }> {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new Error('sendWhatsAppButtons: 1-3 buttons required');
  }
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  }, env, opts);
  return { wamid: r.wamid };
}

/** Reply with a single-select list (sectioned). Use when more than 3 options. */
export async function sendWhatsAppList(
  to: string,
  body: string,
  buttonLabel: string,
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
  env: Env,
  opts: SendOptions = {},
): Promise<{ wamid: string | null }> {
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: { button: buttonLabel, sections },
    },
  }, env, opts);
  return { wamid: r.wamid };
}

/** Send an image by public URL. For private/auth'd assets, upload first via uploadWhatsAppMedia and pass the returned id with sendWhatsAppImageById. */
export async function sendWhatsAppImage(to: string, imageUrl: string, caption: string | undefined, env: Env, opts: SendOptions = {}): Promise<{ wamid: string | null }> {
  const image: Record<string, unknown> = { link: imageUrl };
  if (caption) image['caption'] = caption;
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image,
  }, env, opts);
  return { wamid: r.wamid };
}

export async function sendWhatsAppImageById(to: string, mediaId: string, caption: string | undefined, env: Env, opts: SendOptions = {}): Promise<{ wamid: string | null }> {
  const image: Record<string, unknown> = { id: mediaId };
  if (caption) image['caption'] = caption;
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image,
  }, env, opts);
  return { wamid: r.wamid };
}

export async function sendWhatsAppDocument(
  to: string,
  documentUrl: string,
  filename: string,
  caption: string | undefined,
  env: Env,
  opts: SendOptions = {},
): Promise<{ wamid: string | null }> {
  const doc: Record<string, unknown> = { link: documentUrl, filename };
  if (caption) doc['caption'] = caption;
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: doc,
  }, env, opts);
  return { wamid: r.wamid };
}

export async function sendWhatsAppReaction(to: string, targetWamid: string, emoji: string, env: Env, opts: SendOptions = {}): Promise<{ wamid: string | null }> {
  const r = await postGraphMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'reaction',
    reaction: { message_id: targetWamid, emoji },
  }, env, opts);
  return { wamid: r.wamid };
}

/** Mark an inbound message as read (typing indicators / read receipts). */
export async function markWhatsAppRead(wamid: string, env: Env): Promise<void> {
  if (!isWhatsAppEnabled(env)) return;
  const url = `${graphBase(env)}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: wamid }),
    });
  } catch (e) {
    console.error('[whatsapp] mark read failed', { wamid, error: e instanceof Error ? e.message : String(e) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Media handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a WhatsApp media id to a temporary URL, fetch the bytes (auth'd) and
 * return them. Caches in R2 so re-deliveries don't re-download. Two graph calls:
 *   1. GET /{media_id}                       → { url, mime_type, sha256, file_size }
 *   2. GET <url>  (Bearer access token)      → bytes
 */
export async function fetchWhatsAppMedia(mediaId: string, env: Env): Promise<{ bytes: Uint8Array; mimeType: string; r2Key: string } | null> {
  if (!isWhatsAppEnabled(env)) return null;

  // Cache hit?
  const cached = await env.DB.prepare(
    `SELECT r2_key, mime_type FROM wa_media_cache WHERE media_id = ? LIMIT 1`
  ).bind(mediaId).first<{ r2_key: string; mime_type: string | null }>();
  if (cached) {
    const obj = await env.R2_BUCKET.get(cached.r2_key);
    if (obj) {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      return { bytes, mimeType: cached.mime_type ?? obj.httpMetadata?.contentType ?? 'application/octet-stream', r2Key: cached.r2_key };
    }
  }

  // Step 1: resolve media id → URL
  const metaRes = await fetch(`${graphBase(env)}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) {
    console.error('[whatsapp] media metadata fetch failed', { mediaId, status: metaRes.status });
    return null;
  }
  const meta = await metaRes.json() as { url?: string; mime_type?: string; sha256?: string; file_size?: number };
  if (!meta.url) return null;

  // Step 2: fetch bytes (URL is short-lived, requires Bearer auth)
  const bytesRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!bytesRes.ok) {
    console.error('[whatsapp] media bytes fetch failed', { mediaId, status: bytesRes.status });
    return null;
  }
  const bytes = new Uint8Array(await bytesRes.arrayBuffer());

  const mimeType = meta.mime_type ?? bytesRes.headers.get('content-type') ?? 'application/octet-stream';
  const ext = mimeToExt(mimeType);
  const r2Key = `wa-media/${mediaId}${ext ? '.' + ext : ''}`;

  await env.R2_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO wa_media_cache (media_id, r2_key, mime_type, sha256, size_bytes, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(mediaId, r2Key, mimeType, meta.sha256 ?? null, meta.file_size ?? bytes.byteLength, Math.floor(Date.now() / 1000)).run();

  return { bytes, mimeType, r2Key };
}

/**
 * Upload bytes to Meta and get a media id back. Use when you want to send the
 * same asset to many recipients without exposing a public URL.
 */
export async function uploadWhatsAppMedia(bytes: Uint8Array, mimeType: string, filename: string, env: Env): Promise<string | null> {
  if (!isWhatsAppEnabled(env)) return null;
  const url = `${graphBase(env)}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([bytes], { type: mimeType }), filename);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
  });
  if (!res.ok) {
    console.error('[whatsapp] media upload failed', { status: res.status, body: await res.text() });
    return null;
  }
  const json = await res.json() as { id?: string };
  return json.id ?? null;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'audio/ogg':  return 'ogg';
    case 'audio/mpeg': return 'mp3';
    case 'audio/mp4':  return 'm4a';
    case 'audio/aac':  return 'aac';
    case 'video/mp4':  return 'mp4';
    case 'video/3gpp': return '3gp';
    case 'application/pdf': return 'pdf';
    default: return '';
  }
}
