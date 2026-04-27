// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for bot-side copy across Telegram, WhatsApp, and Web.
//
// Why this file exists:
//   The user's product rule (locked 2026-04-27) is that messages must look
//   identical across all three channels — same wording, same emoji, same
//   menu structure. Before this file, every entry-point handler wrote its
//   own inline strings; every copy edit had to be repeated 3× and inevitably
//   drifted. This registry collapses all entry-point copy into ONE module.
//
// How to use:
//   Every brain handler should call into this file for its outbound payload,
//   then dispatch via the channel adapter (channel.ts). The adapter knows
//   how to map ChannelButton[][] to TG inline_keyboard, WA interactive
//   button list, or web_chat_messages.buttons_json.
//
//   import { welcomeMessage, dispatchBotMessage } from './bot_copy';
//   const adapter = getChannelAdapter({ channel: 'telegram', recipient: '...', botRole: 'boothbot' }, env);
//   await dispatchBotMessage(adapter, welcomeMessage('boothbot', 'Sarah'));
//
// callback_data convention:
//   Names mirror the existing Telegram routing in telegram.ts / sourcebot.ts:
//     boothbot:  new_lead | view_leads    | view_sheet | get_started_cta
//     sourcebot: new_supplier | view_suppliers | view_sheet | get_started_cta
//   When migrating a TG handler, do NOT rename these — TG routes off them today.
//
// Migration status (2026-04-27):
//   • Web channel    — uses this file (web_chat.ts) ✓
//   • Telegram       — uses this file for entry-points (cmdStart, cmdHelp,
//                      paywall sites). Brain-specific responses (extracted-card
//                      confirmations, error messages) still inline; those
//                      migrate alongside the brain refactor in Sprint 2 phase 6.
//   • WhatsApp       — uses this file for join-success + fallback.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChannelAdapter, ChannelButton } from './channel';

export type BotRole = 'boothbot' | 'sourcebot' | 'expensebot';

export interface BotMessage {
  text:     string;
  /** 2D rows of buttons. Empty / omitted = plain text message. */
  buttons?:  ChannelButton[][];
  markdown?: boolean;
}

export interface WelcomeContext {
  /** First name for personalized greeting. Falls back to "there" if absent. */
  firstName?: string;
  /** "✅ Gmail connected as user@…" string from TG; included verbatim in body. */
  gmailStatus?: string;
  /** Direct deep-link to the user's Google Sheet — surfaced as a tail link. */
  sheetUrl?: string;
}

// ── Welcome ──────────────────────────────────────────────────────────────────
// The canonical "you're in, here's what I do, here's the menu" message.
// Used by /start (TG) for users with active access, by web /api/chat/start,
// and by WA join-success after token redemption.

export function welcomeMessage(role: BotRole, ctx: WelcomeContext = {}): BotMessage {
  const greet = ctx.firstName ? `, ${ctx.firstName}` : '';
  const gmailLine  = ctx.gmailStatus ? `\n${ctx.gmailStatus}\n` : '';
  const sheetTail  = ctx.sheetUrl ? `\n\n📊 [Open your Sheet](${ctx.sheetUrl})` : '';

  if (role === 'sourcebot') {
    // Wording sourced verbatim from sourcebot.ts cmdStartWithToken (the
    // post-onboarding "Connected" message — the most fleshed-out copy in
    // the codebase pre-unification). Headline switches between "Welcome"
    // and "Connected" depending on whether we have a firstName (first-time
    // post-token) or not (returning user / web fresh start).
    const headline = ctx.firstName
      ? `✅ *Connected, ${ctx.firstName}!* I'm DaGama SourceBot — your trade-show companion.`
      : `👋 *Welcome to DaGama SourceBot.* Your trade-show companion.`;
    return {
      text:
        `${headline}${gmailLine}\n\n` +
        `*What I do:*\n` +
        `📇 *Capture suppliers* — send me a photo of a business card and I'll extract name, title, email, phone, website, LinkedIn, address, and country into your Sheet.\n` +
        `📦 *Capture products* — send a product photo right after a card and I'll attach it to that supplier with an image, name, and AI-written description.\n` +
        `💬 *Voice + text notes* — reply to any photo with text or a voice note and I'll pull out price, MOQ, lead time, colors, materials, and add them to the row.\n` +
        `✏️ *Fix mistakes* — reply to any of my confirmations with a correction (e.g. "phone is +1 415 555 1234") and I'll update the field.\n` +
        `🔥 *Rank interest* — tap Hot / Warm / Cold on a supplier so you remember the best leads.\n` +
        `📧 *AI follow-ups* — /email <supplier> drafts and sends a personal email from your Gmail. /blast sends one to every supplier you haven't contacted.\n` +
        `📑 *PDFs* — /pdf <supplier> for a one-pager, /pdfshow for a full-show recap.\n` +
        `🔍 */find <text>* searches everything · */compare <product>* AI-ranks suppliers · */summary* recaps the show.\n\n` +
        `*Quick start:*\n` +
        `1. Send the next supplier's *business card photo* 📸\n` +
        `2. Send their *product photos* 📦 right after\n` +
        `3. *Reply* with details — by voice or text 🎤\n\n` +
        `Use /help anytime for the full command list.${sheetTail}`,
      buttons: [
        [{ text: '📸 Capture a supplier', data: 'new_supplier' }],
        [{ text: '📋 My suppliers',       data: 'view_suppliers' },
         { text: '📊 Google Sheet',       data: 'view_sheet'    }],
      ],
      markdown: true,
    };
  }

  // boothbot (default)
  return {
    text:
      `👋 *Welcome to DaGama BoothBot${greet}.*\n\n` +
      `I help you capture every buyer that walks past your booth — just photograph their business card and I'll do the rest.${gmailLine}\n` +
      `*What I can do:*\n` +
      `📸 *Capture a lead* — photograph a buyer's business card.\n` +
      `🎤 *Voice + text notes* — reply to any card and I'll pull out interest level, products discussed, and follow-up notes.\n` +
      `📋 /leads — see your recent leads.\n` +
      `📊 /sheet — open your Google Sheet.\n` +
      `🤖 /summary — AI analysis of your leads.\n` +
      `📧 /connectgmail — link Gmail for sending follow-ups.\n` +
      `✉️ /sendemail N — send follow-up to lead #N.\n\n` +
      `Type /help anytime for the full command list.${sheetTail}`,
    buttons: [
      [{ text: '📸 Capture a lead', data: 'new_lead' }],
      [{ text: '📋 My leads',       data: 'view_leads' },
       { text: '📊 Google Sheet',   data: 'view_sheet' }],
    ],
    markdown: true,
  };
}

// ── Help ─────────────────────────────────────────────────────────────────────
// /help command. Shorter than welcome — assumes the user already knows the
// product, just wants the command list.

export function helpMessage(role: BotRole): BotMessage {
  if (role === 'sourcebot') {
    // Wording sourced verbatim from sourcebot.ts cmdHelp (the TG bot was the
    // most detailed pre-unification — preserving that detail across channels).
    return {
      text:
        `*DaGama SourceBot — quick reference*\n\n` +
        `📸 *Send a business card photo* → supplier saved\n` +
        `📦 *Send product photos* → captured under that supplier\n` +
        `💬 *Reply to any photo* with text or voice → details extracted (price, MOQ, lead time, colors)\n` +
        `✏️ *Reply to a confirmation* with corrections → fields fixed automatically\n\n` +
        `*Lookup commands*\n` +
        `/supplier [query] — list captured suppliers\n` +
        `/products [query] — list captured products\n` +
        `/find <query> — search across suppliers, products, voice notes\n` +
        `/compare <product> — AI ranking across your suppliers\n` +
        `/summary — AI summary of this show\n\n` +
        `*Action commands*\n` +
        `/pending — products missing price or MOQ\n` +
        `/followups — suppliers with email but no follow-up sent\n` +
        `/email <supplier> — draft + send a follow-up email\n` +
        `/blast — bulk send follow-ups to all uncontacted suppliers\n` +
        `/pdf <supplier> — one-pager PDF for a supplier\n` +
        `/pdfshow — PDF recap of the whole show\n` +
        `/connectgmail — connect your Gmail (sends from your address)\n\n` +
        `*Shows + billing*\n` +
        `/shows — list your shows · /switch <name> — change active show\n` +
        `/newshow <name> [days] — register another show\n` +
        `/allshows — cross-show summary\n` +
        `/upgrade — unlock unlimited scans (Stripe)\n\n` +
        `*Account*\n` +
        `/share — your referral link · /tutorial — quick walkthrough\n` +
        `/language [code] — set your language preference\n` +
        `/done · /cancel · /clear — exit current step`,
      buttons: [[{ text: '📸 Capture a supplier', data: 'new_supplier' }]],
      markdown: true,
    };
  }

  return {
    text:
      `*DaGama BoothBot — lead capture*\n\n` +
      `📸 Tap *Capture a lead* or send me a *business card photo* — I extract company, name, email, phone, and add it to your Sheet.\n` +
      `🎤 *Reply* (text or voice) — I pull out interest level, products discussed, and follow-up notes.\n\n` +
      `*Commands:*\n` +
      `📋 /leads — see your recent leads\n` +
      `📊 /sheet — open your Google Sheet\n` +
      `🤖 /summary — AI analysis of your leads\n` +
      `📧 /connectgmail — link Gmail to send emails\n` +
      `✉️ /sendemail N — send follow-up to lead #N\n` +
      `✍️ /followup N — draft a follow-up for lead #N\n` +
      `❌ /cancel — cancel current action`,
    buttons: [[{ text: '📸 Capture a lead', data: 'new_lead' }]],
    markdown: true,
  };
}

// ── Paywall ──────────────────────────────────────────────────────────────────
// Emitted when a user without an active pass tries to use a gated action
// (capture a lead, view leads, etc.) OR when their 24h trial expires mid-chat.
// `reason` lets the UI show a different first line for "no plan yet" vs
// "your trial just ended" while keeping the CTAs identical.

export type PaywallReason = 'no_plan' | 'trial_expired' | 'pass_expired';

export function paywallMessage(role: BotRole, reason: PaywallReason = 'no_plan'): BotMessage {
  const headline =
    reason === 'trial_expired' ? `🔒 *Your 24-hour free trial ended.*`
  : reason === 'pass_expired'  ? `⚫ *Your show pass expired.*`
  :                              `🔒 *No active plan.*`;

  return {
    text:
      `${headline}\n\n` +
      `Grab a 96-hour show pass to keep capturing — ExpenseBot stays included. Or browse our plans.`,
    buttons: [
      [{ text: '🎟  Get 96-hour show pass', url: `https://heydagama.com/pricing?role=${role}` }],
      [{ text: '🌐  All plans',             url: `https://heydagama.com/pricing` }],
    ],
    markdown: true,
  };
}

// ── Welcome (no-account / pre-onboarding state) ──────────────────────────────
// User opened TG/WA but hasn't activated yet. Direct them back to the email
// they got from /api/auth/register — that link binds their channel to their
// account.

export function pendingActivationMessage(role: BotRole, firstName?: string): BotMessage {
  const productName = role === 'sourcebot' ? 'SourceBot' : 'BoothBot';
  const greet = firstName ? `, ${firstName}` : '';
  return {
    text:
      `👋 *Welcome to DaGama ${productName}${greet}.*\n\n` +
      `To get started, open the welcome email we sent you and tap the link for this channel. ` +
      `That activates your 24-hour free trial and connects this chat to your account.`,
    buttons: [[{ text: '🌐 Get started at heydagama.com', url: 'https://heydagama.com/register' }]],
    markdown: true,
  };
}

// WhatsApp-only: a user messaged WA without ever signing up. Different from
// pendingActivationMessage because they don't have an email/token at all yet.
export function whatsappOnboardingHint(): BotMessage {
  return {
    text:
      `👋 *Welcome to DaGama.*\n\n` +
      `Sign up at heydagama.com — you'll get a join code that activates this chat. ` +
      `If you're a freelancer, just reply *demo* to register.`,
    buttons: [[{ text: '🌐 Sign up', url: 'https://heydagama.com/register' }]],
    markdown: true,
  };
}

// Confirmation after WA `join <token>` succeeds — user is bound to their
// account and the channel is live. Same wording as the welcome sent on
// /start in TG, just shorter (WA users hit this immediately after binding,
// the rich welcome lives in the email they came from).
export function joinSuccessMessage(role: BotRole): BotMessage {
  if (role === 'sourcebot') {
    return {
      text:
        `✅ *Connected to SourceBot.*\n\n` +
        `Send a supplier's business card photo to begin. Reply with text or a voice note for price, MOQ, and lead-time.`,
      markdown: true,
    };
  }
  return {
    text:
      `✅ *Connected to BoothBot.*\n\n` +
      `Photograph a buyer's business card to begin. Reply with text or a voice note to capture context.`,
    markdown: true,
  };
}

// ── Acknowledgments (web-only stop-gap; TG/WA have real brain replies) ───────
// On the web channel we don't have a real brain yet (Sprint 2 phase 6), so
// these stand in until the LLM extraction lands. TG/WA still emit their
// own brain-side confirmations (extracted card → "Saved: ACME · Sarah Lee").

export function textReceivedAck(role: BotRole): BotMessage {
  if (role === 'sourcebot') {
    return {
      text:
        `Got it.\n\n` +
        `📸 Drop a photo of a supplier card or product and I'll pull out company, contact, MOQ, and pricing.\n` +
        `🎤 Send a voice note for extra context (lead time, terms, samples).\n\n` +
        `_Full extraction lands in the next sprint — your trial clock is running._`,
      buttons: defaultActionMenu(role),
      markdown: true,
    };
  }
  return {
    text:
      `Got it.\n\n` +
      `📸 Snap a buyer's business card and I'll pull company, name, email, and phone.\n` +
      `🎤 Send a voice note with context (interest level, follow-up notes).\n\n` +
      `_Full extraction lands in the next sprint — your trial clock is running._`,
    buttons: defaultActionMenu(role),
    markdown: true,
  };
}

export function imageReceivedAck(role: BotRole): BotMessage {
  if (role === 'sourcebot') {
    return {
      text:
        `📸 *Got your photo.*\n\n` +
        `SourceBot will extract supplier name, contact, MOQ, and pricing once the brain ships next sprint. Trial clock is running.`,
      buttons: defaultActionMenu(role),
      markdown: true,
    };
  }
  return {
    text:
      `📸 *Got your photo.*\n\n` +
      `BoothBot will extract company, name, email, and phone once the brain ships next sprint. Trial clock is running.`,
    buttons: defaultActionMenu(role),
    markdown: true,
  };
}

export function voiceReceivedAck(role: BotRole): BotMessage {
  const productName = role === 'sourcebot' ? 'SourceBot' : 'BoothBot';
  return {
    text:
      `🎤 *Got your voice note.*\n\n` +
      `${productName} will transcribe and tag it once the brain ships next sprint. Trial clock is running.`,
    buttons: defaultActionMenu(role),
    markdown: true,
  };
}

// Alias kept for source compatibility with the previous bot_copy.ts shape.
export const trialExpiredMessage = (role: BotRole): BotMessage => paywallMessage(role, 'trial_expired');

// ── Adapter dispatch helper ──────────────────────────────────────────────────
// Walks a BotMessage onto a ChannelAdapter — text + optional buttons in a
// single call. Centralized here so the SAME 2-shape contract holds across
// TG / WA / web; the adapter implementation handles per-channel rendering.

export async function dispatchBotMessage(adapter: ChannelAdapter, msg: BotMessage): Promise<void> {
  if (msg.buttons && msg.buttons.length > 0) {
    await adapter.sendButtons({ text: msg.text, buttons: msg.buttons, markdown: msg.markdown });
    return;
  }
  await adapter.sendText(msg.text, { markdown: msg.markdown });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultActionMenu(role: BotRole): ChannelButton[][] {
  if (role === 'sourcebot') {
    return [
      [{ text: '📸 Capture a supplier', data: 'new_supplier' }],
      [{ text: '📋 My suppliers',       data: 'view_suppliers' },
       { text: '📊 Google Sheet',       data: 'view_sheet'    }],
    ];
  }
  return [
    [{ text: '📸 Capture a lead', data: 'new_lead' }],
    [{ text: '📋 My leads',       data: 'view_leads' },
     { text: '📊 Google Sheet',   data: 'view_sheet'    }],
  ];
}
