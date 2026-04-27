/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import {
  sendWhatsAppText,
  sendWhatsAppButtons,
  sendWhatsAppImage,
  sendWhatsAppList,
  sendWhatsAppReaction,
} from './whatsapp';

// ─────────────────────────────────────────────────────────────────────────────
// Channel adapter — abstracts send-side I/O so the bot brain (BoothBot,
// SourceBot, ExpenseBot, DemoBot) talks to one interface regardless of the
// underlying surface (Telegram, WhatsApp, web chat).
//
// Why: Day-1 architecture is tri-channel. Without this abstraction, every
// brain handler has to know if it's talking to TG vs WA, dispatching to
// different send helpers per call. That gets unmaintainable fast and blocks
// the web channel entirely (which has no equivalent of TG callback_data or
// WA wamid).
//
// Convention: every adapter normalizes return values to { messageId: string }.
// TG message_ids are numbers; we coerce to string. WA wamids are already
// strings. Web message_ids are UUIDs we generate.
// ─────────────────────────────────────────────────────────────────────────────

export type Channel = 'telegram' | 'whatsapp' | 'web';

/** A button presented to the user. Each channel renders it differently:
 *   TG: inline_keyboard with callback_data or url
 *   WA: interactive button (id) or url cta-button
 *   Web: rendered as a clickable chip; data emits a custom event
 */
export interface ChannelButton {
  /** User-visible label (≤ 20 chars on WA — caller responsible) */
  text:  string;
  /** Action identifier for callback. Mutually exclusive with `url`. */
  data?: string;
  /** External URL — TG inline url-button, WA cta-button. */
  url?:  string;
}

export interface SendTextResult {
  messageId: string;
}

export interface SendPhotoArgs {
  url:       string;
  caption?:  string;
  /** 2D array on TG/web (rows of buttons). WA flattens to ≤ 3 buttons. */
  buttons?:  ChannelButton[][];
  markdown?: boolean;
}

export interface SendButtonsArgs {
  text:      string;
  buttons:   ChannelButton[][];
  markdown?: boolean;
}

export interface ChannelAdapter {
  /** Which transport this adapter speaks to. Useful for branch-on-channel logic. */
  readonly channel: Channel;

  /** Address-of-recipient as the channel understands it. TG: chat_id (string).
   *  WA: phone (E.164 no '+'). Web: session_id. */
  readonly recipient: string;

  /** Plain-text message. Markdown supported on TG; stripped on WA. */
  sendText(text: string, opts?: { markdown?: boolean }): Promise<SendTextResult>;

  /** Photo with optional caption + buttons. WA requires the URL to be
   *  publicly fetchable (its servers fetch it). */
  sendPhoto(args: SendPhotoArgs): Promise<SendTextResult>;

  /** Text with inline buttons. TG = inline_keyboard, WA = interactive button list. */
  sendButtons(args: SendButtonsArgs): Promise<SendTextResult>;

  /** Optional: emoji reaction on a target message. WA + TG support; web no-ops. */
  sendReaction?(targetMessageId: string, emoji: string): Promise<void>;

  /** Optional: typing/pending indicator. */
  sendTyping?(): Promise<void>;

  /** Optional: remove inline keyboard from a previously sent message
   *  (TG only — used to lock buttons after a tap). WA + web no-op. */
  removeButtons?(messageId: string): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────
// Pick the right adapter based on which channel the inbound message came from.
// Web adapter lands when the WS/SSE chat surface is built (Sprint 2 phase 2).

export interface ChannelContext {
  channel:   Channel;
  recipient: string;          // chat_id (TG), phone (WA), session_id (web)
  /** TG: which bot token to use. Defaults to BoothBot. */
  botRole?:  'boothbot' | 'sourcebot' | 'demobot';
}

export function getChannelAdapter(ctx: ChannelContext, env: Env): ChannelAdapter {
  switch (ctx.channel) {
    case 'telegram':
      return new TelegramAdapter(ctx.recipient, ctx.botRole ?? 'boothbot', env);
    case 'whatsapp':
      return new WhatsAppAdapter(ctx.recipient, env);
    case 'web':
      return new WebAdapter(ctx.recipient, env);
  }
}

// ── Telegram adapter ─────────────────────────────────────────────────────────

class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram' as const;
  readonly recipient: string;
  private readonly chatId: number;
  private readonly token: string;

  constructor(recipient: string, botRole: 'boothbot' | 'sourcebot' | 'demobot', env: Env) {
    this.recipient = recipient;
    this.chatId    = Number(recipient);
    this.token = botRole === 'sourcebot' ? (env.TELEGRAM_BOT_TOKEN_SOURCE ?? env.TELEGRAM_BOT_TOKEN)
              :  botRole === 'demobot'   ? (env.TELEGRAM_BOT_TOKEN_DEMO   ?? env.TELEGRAM_BOT_TOKEN)
              :                            env.TELEGRAM_BOT_TOKEN;
  }

  async sendText(text: string, opts: { markdown?: boolean } = {}): Promise<SendTextResult> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    this.chatId,
        text,
        parse_mode: opts.markdown ? 'Markdown' : undefined,
      }),
    });
    const data = await res.json() as { result?: { message_id?: number } };
    return { messageId: String(data.result?.message_id ?? 0) };
  }

  async sendPhoto(args: SendPhotoArgs): Promise<SendTextResult> {
    const body: Record<string, unknown> = {
      chat_id:    this.chatId,
      photo:      args.url,
      caption:    args.caption,
      parse_mode: args.markdown ? 'Markdown' : undefined,
    };
    if (args.buttons) body.reply_markup = { inline_keyboard: tgButtons(args.buttons) };
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json() as { result?: { message_id?: number } };
    return { messageId: String(data.result?.message_id ?? 0) };
  }

  async sendButtons(args: SendButtonsArgs): Promise<SendTextResult> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:      this.chatId,
        text:         args.text,
        parse_mode:   args.markdown ? 'Markdown' : undefined,
        reply_markup: { inline_keyboard: tgButtons(args.buttons) },
      }),
    });
    const data = await res.json() as { result?: { message_id?: number } };
    return { messageId: String(data.result?.message_id ?? 0) };
  }

  async removeButtons(messageId: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.token}/editMessageReplyMarkup`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:      this.chatId,
        message_id:   Number(messageId),
        reply_markup: { inline_keyboard: [] },
      }),
    }).catch(() => {/* best-effort */});
  }
}

function tgButtons(rows: ChannelButton[][]): Array<Array<{ text: string; callback_data?: string; url?: string }>> {
  return rows.map(row => row.map(b => {
    const out: { text: string; callback_data?: string; url?: string } = { text: b.text };
    if (b.url)  out.url = b.url;
    if (b.data) out.callback_data = b.data;
    return out;
  }));
}

// ── WhatsApp adapter ─────────────────────────────────────────────────────────

class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  readonly recipient: string;        // E.164 no '+'
  private readonly env: Env;

  constructor(recipient: string, env: Env) {
    this.recipient = recipient;
    this.env       = env;
  }

  async sendText(text: string, opts: { markdown?: boolean } = {}): Promise<SendTextResult> {
    // WA doesn't render Markdown — strip the most common artifacts so users
    // don't see literal asterisks / underscores. Keeps brain code channel-agnostic.
    const stripped = opts.markdown ? text.replace(/[*_`]/g, '') : text;
    const r = await sendWhatsAppText(this.recipient, stripped, this.env);
    return { messageId: r.wamid ?? '' };
  }

  async sendPhoto(args: SendPhotoArgs): Promise<SendTextResult> {
    // WA splits caption + buttons across two messages: image first, then a
    // button list referencing it. For simplicity in v1 we send the image
    // with caption and (if buttons present) follow with a separate text+buttons
    // message. Matches the existing whatsapp.ts pattern.
    const stripped = args.markdown && args.caption ? args.caption.replace(/[*_`]/g, '') : args.caption;
    const img = await sendWhatsAppImage(this.recipient, args.url, stripped, this.env);

    if (args.buttons && args.buttons.length > 0) {
      const flat = args.buttons.flat().slice(0, 3);    // WA caps interactive at 3 buttons
      await sendWhatsAppButtons(
        this.recipient,
        '',                                            // empty body — caption already conveyed it
        flat.map(b => ({ id: b.data ?? b.text.slice(0, 32), title: b.text.slice(0, 20) })),
        this.env,
      );
    }
    return { messageId: img.wamid ?? '' };
  }

  async sendButtons(args: SendButtonsArgs): Promise<SendTextResult> {
    const flat = args.buttons.flat();
    if (flat.length <= 3) {
      // Use interactive button-list (WA's max 3 buttons)
      const stripped = args.markdown ? args.text.replace(/[*_`]/g, '') : args.text;
      const r = await sendWhatsAppButtons(
        this.recipient,
        stripped,
        flat.map(b => ({ id: b.data ?? b.text.slice(0, 32), title: b.text.slice(0, 20) })),
        this.env,
      );
      return { messageId: r.wamid ?? '' };
    }
    // Fall through to a list message for >3 options
    const stripped = args.markdown ? args.text.replace(/[*_`]/g, '') : args.text;
    const r = await sendWhatsAppList(
      this.recipient,
      stripped,
      'Choose',
      [{ title: 'Options', rows: flat.map(b => ({ id: b.data ?? b.text.slice(0, 32), title: b.text.slice(0, 24) })) }],
      this.env,
    );
    return { messageId: r.wamid ?? '' };
  }

  async sendReaction(targetMessageId: string, emoji: string): Promise<void> {
    await sendWhatsAppReaction(this.recipient, targetMessageId, emoji, this.env);
  }
}

// ── Web adapter ──────────────────────────────────────────────────────────────
// "Sending" on the web channel = inserting an outbound row into web_chat_messages.
// The frontend long-polls GET /api/chat/poll?since=<id> for new rows since the
// last seen message id. Durable Object WebSocket upgrade is a perf follow-up;
// long-poll is plenty for the email-gated free-tier surface volume.
//
// Recipient = web_chat_sessions.id (the session_id, opaque). WebAdapter never
// needs to know the session_token (that's auth concern, handled at HTTP route).

class WebAdapter implements ChannelAdapter {
  readonly channel = 'web' as const;
  readonly recipient: string;             // web_chat_sessions.id
  private readonly env: Env;

  constructor(sessionId: string, env: Env) {
    this.recipient = sessionId;
    this.env       = env;
  }

  async sendText(text: string, _opts: { markdown?: boolean } = {}): Promise<SendTextResult> {
    // Markdown passes through; the frontend chat renderer handles the formatting
    // (obsidian theme + Inter font already in the website CSS).
    return this.insertOutbound({ kind: 'text', text });
  }

  async sendPhoto(args: SendPhotoArgs): Promise<SendTextResult> {
    // For the web channel, args.url is expected to be a URL the frontend can
    // load directly — typically a `/_r2/<key>` route. We store it under text
    // (URL) and the kind tells the renderer to render an <img>. Buttons (if
    // any) are written as a SECOND outbound row of kind=buttons.
    const photo = await this.insertOutbound({
      kind:    'image',
      text:    args.caption ?? null,
      r2_url:  args.url,
    });
    if (args.buttons && args.buttons.length > 0) {
      await this.insertOutbound({
        kind:         'buttons',
        text:         null,
        buttons_json: JSON.stringify(args.buttons.flat()),
      });
    }
    return photo;
  }

  async sendButtons(args: SendButtonsArgs): Promise<SendTextResult> {
    return this.insertOutbound({
      kind:         'buttons',
      text:         args.text,
      buttons_json: JSON.stringify(args.buttons.flat()),
    });
  }

  // No-op on web: web frontend handles its own typing indicator + reactions
  // are not part of v1. removeButtons is also a no-op (the frontend just
  // disables stale button rows after a tap).

  private async insertOutbound(row: {
    kind:          'text' | 'image' | 'buttons' | 'system';
    text:          string | null;
    r2_url?:       string;          // for kind=image, stored in text alongside metadata
    buttons_json?: string;
  }): Promise<SendTextResult> {
    // Image rows store the URL in text and the R2 key (if it's an internal
    // /_r2/<key> path) in media_r2_key for cleanup later. For external URLs
    // we just leave media_r2_key NULL.
    let mediaR2Key: string | null = null;
    let textValue = row.text;
    if (row.kind === 'image' && row.r2_url) {
      const m = row.r2_url.match(/\/_r2\/([^?]+)/);
      mediaR2Key = m ? decodeURIComponent(m[1]) : null;
      // Embed URL into text JSON so the frontend has both URL + caption together
      textValue = JSON.stringify({ url: row.r2_url, caption: row.text });
    }

    const inserted = await this.env.DB.prepare(`
      INSERT INTO web_chat_messages (
        session_id, direction, kind, text, media_r2_key, buttons_json, produced_by
      ) VALUES (?, 'outbound', ?, ?, ?, ?, 'channel_adapter')
      RETURNING id
    `).bind(
      this.recipient,
      row.kind,
      textValue,
      mediaR2Key,
      row.buttons_json ?? null,
    ).first<{ id: string }>();

    if (!inserted?.id) throw new Error('web_chat_messages insert returned no id');

    // Bump the session's last_outbound_at so the cron / dashboard knows it's alive.
    await this.env.DB
      .prepare(`UPDATE web_chat_sessions SET last_outbound_at = datetime('now') WHERE id = ?`)
      .bind(this.recipient)
      .run();

    return { messageId: inserted.id };
  }
}
