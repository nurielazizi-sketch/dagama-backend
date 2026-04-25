# LIFECYCLE_RULES.md — DaGama lifecycle messaging spec

This is the single source of truth for every automated message DaGama sends.
It's editable by non-engineers — change a template, change timing, change
channel, change the trigger condition, no code change required (the rules
engine in `IMPLEMENTATION_PLAN.md` Phase 4 reads these rules by ID).

Each rule below is a **self-contained block**. Each has the same fields:

- **ID** — the unique key the engine uses (`PRESHOW_5DAY`, `POSTSHOW_24H`, etc.). Don't rename without updating Phase 4 idempotency keys.
- **State** — which user state this rule applies to (`pre_show` / `during_show` / `post_show` / `dormant` / `pre_next_show` / state-agnostic).
- **Trigger condition** — the precise SQL-or-event predicate. The engine evaluates this hourly.
- **Timing** — when the message fires once the trigger is true.
- **Channel** — `email` / `telegram` / `whatsapp` / `in_product` / `ad_audience`. Phase 4's router falls back to email when the preferred channel isn't reachable.
- **Template** — subject + body. Variables in `{{double_braces}}`. Templates ship as separate files in `src/email_templates/` (Phase 5); the body here is the source-of-truth copy.
- **Success metric** — how we'll know the rule works. Tied to a PostHog event.
- **A/B test ideas** — concrete experiments worth running.

> **Editing this file:** copy the **TEMPLATE BLOCK** at the bottom, paste it
> in the right state section, fill it in. Don't reuse an `ID` — it's the
> idempotency key. To retire a rule, set `State: retired` and leave the block
> for history.

---

## Variables (used across templates)

| Variable | Source |
|---|---|
| `{{user_first_name}}` | `users.name` (split on first space) |
| `{{bot_name}}` | `'BoothBot'` or `'SourceBot'` based on user role |
| `{{show_name}}` | `shows.name` for the relevant show |
| `{{show_start_date}}` | `shows.start_date` formatted "Apr 25, 2026" |
| `{{show_city}}` | `shows.city` |
| `{{show_country}}` | `shows.country` |
| `{{days_until_show}}` | computed: `shows.start_date - today` |
| `{{leads_count}}` | count of leads/suppliers user has captured at this show |
| `{{sheet_url}}` | the user's Google Sheet for this show |
| `{{telegram_deep_link}}` | `t.me/<bot>?start=show_<show_id>` |
| `{{whatsapp_deep_link}}` | `wa.me/<phone>?text=join%20<token>` |
| `{{checkout_url}}` | Stripe checkout URL for the suggested upgrade |
| `{{coupon_code}}` | optional coupon, e.g. for retargeting offers |
| `{{cancel_url}}` | unsubscribe / preferences URL |
| `{{prev_show_name}}` | name of the user's most recently `attended` show (PRE_NEXT_SHOW_*) |
| `{{prev_leads_count}}` | lead count from the user's most recently `attended` show |
| `{{next_show_name}}` | name of the user's next `planned` show (UPGRADE_*) |
| `{{referee_first_name}}` | first name of a successful referral signup (REFERRAL_*) |
| `{{referral_link}}` | the user's personal referral URL |
| `{{nps_url}}` | NPS submission URL with score query param |

---

## Pre-show

### `PRESHOW_7DAY`

- **State:** `pre_show`
- **Trigger condition:** `user_upcoming_shows.status = 'planned'` AND `shows.start_date - today` between 5 and 7 days
- **Timing:** at 09:00 in the user's timezone, exactly 7 days before `start_date`
- **Channel:** `email` (primary), `telegram` (fallback if email bounced)
- **Template:**
  - **Subject:** `{{show_name}} is in {{days_until_show}} days — here's your prep list`
  - **Body:**
    ```
    Hi {{user_first_name}},

    {{show_name}} starts {{show_start_date}} in {{show_city}}. We've got your
    Google Sheet ready for the leads you'll capture.

    Three things that'll save you time on the floor:

    1. Save the Telegram link to your home screen now: {{telegram_deep_link}}
    2. Test it with one card — it takes 30 seconds and confirms scanning works at your network speed.
    3. Forward the sheet link to anyone on your team who's also attending: {{sheet_url}}

    Safe travels.
    — DaGama
    ```
- **Success metric:** PostHog `welcome_email_link_clicked` from this email + `bot_first_message` within 7 days
- **A/B test ideas:**
  - Subject line: "in {{days_until_show}} days" vs "next week"
  - CTA prominence: text links vs styled button vs both
  - Copy length: full version vs single-CTA short version

---

### `PRESHOW_24H`

- **State:** `pre_show`
- **Trigger condition:** `user_upcoming_shows.status = 'planned'` AND `shows.start_date - today` between 0 and 1 day
- **Timing:** at 17:00 in the user's timezone, the day before `start_date`
- **Channel:** `telegram` (primary — they're more likely to check chat than email at this point), `email` (parallel)
- **Template (Telegram):**
  ```
  ✈️ {{show_name}} kicks off tomorrow.

  Tap any time to scan a card — I'll handle the rest.

  Your sheet: {{sheet_url}}
  ```
- **Template (email):**
  - **Subject:** `Tomorrow: {{show_name}} — quick checklist`
  - **Body:**
    ```
    {{user_first_name}},

    {{show_name}} starts tomorrow. One last check:

    ✅ Telegram open? Tap here to confirm: {{telegram_deep_link}}
    ✅ Phone charged?
    ✅ Business cards on you (yes, still useful)?

    See you on the floor.
    ```
- **Success metric:** % of recipients who scan their first card within 48h
- **A/B test ideas:**
  - Telegram-only vs email + Telegram parallel
  - 17:00 timezone vs 21:00 timezone (catch evening prep)
  - Plain text vs emoji-rich

---

### `PRESHOW_DAYOF`

- **State:** `pre_show` → transitions to `during_show`
- **Trigger condition:** `today === shows.start_date` AND user has `user_upcoming_shows` row for this show
- **Timing:** at 08:00 in the user's timezone on `start_date`
- **Channel:** `telegram`
- **Template:**
  ```
  🌅 Good morning. {{show_name}} starts today.

  Drop me your first business card and I'll show you what I do.

  No tutorial, no setup. Just send a photo.
  ```
- **Success metric:** PostHog `first_card_scanned` within 6 hours of this message
- **A/B test ideas:**
  - "Drop me your first business card" vs "Send me your first card"
  - With or without a tip image attached

---

## During show

### `DURING_FIRST_SCAN`

- **State:** `during_show`
- **Trigger condition:** First `card_scanned` event for this user at this show (any bot)
- **Timing:** immediately, in the same Telegram message thread that confirmed the save
- **Channel:** `telegram` (this is part of the existing capture flow, not a separate trigger — listed here for completeness so the lifecycle calendar shows it)
- **Template:** existing capture-confirmation message + a one-liner appended for the first scan only:
  ```
  🎉 First lead at {{show_name}} captured.
  Send the next card whenever you're ready — I'll keep them in your sheet.
  ```
- **Success metric:** PostHog `card_scanned` count for this user crosses 1 → 5 within Day 1 (activation depth)
- **A/B test ideas:**
  - With vs without "first lead" emoji + congratulation
  - Encouragement phrasing variants ("Send the next card" vs "Want to add their products?")

---

### `DURING_MID_CHECKIN`

- **State:** `during_show`
- **Trigger condition:** User scanned at least one card at this show AND show has been running for ≥1 full day AND user hasn't scanned in the last 4 hours
- **Timing:** at 14:00 in the user's timezone on day 2 (or the show's middle day for 2-day shows)
- **Channel:** `telegram`
- **Template:**
  ```
  📍 You're at {{leads_count}} leads from {{show_name}} so far. How's it going?

  Reminder: voice notes work too — press-hold the mic when typing's hard.
  ```
- **Success metric:** Re-engagement rate (scan within next 4h after this message)
- **A/B test ideas:**
  - Mention voice notes vs not
  - Show count vs hide count
  - Skip if `leads_count > 20` (power users don't need a check-in)

---

### `DURING_END_DAY1`

- **State:** `during_show`
- **Trigger condition:** End of `start_date` AND user has scanned at least one card today
- **Timing:** at 20:00 in the user's timezone on `start_date`
- **Channel:** `telegram`
- **Template:**
  ```
  🌃 Day 1 done. {{leads_count}} leads in your sheet.

  If you want to follow up tonight, just reply with /email <name> and I'll draft it.

  See you tomorrow.
  ```
- **Success metric:** PostHog `email_sent_to_lead` events fired within the same evening
- **A/B test ideas:**
  - "Reply with /email" vs prompt button
  - Skip for free-tier users who'll hit the paywall on Day 2

---

### `DURING_PAYWALL_TRIGGER`

- **State:** `during_show`
- **Trigger condition:** Free-tier user has hit their scan limit (≥10 scans on a 2-day show OR ≥24h since first scan on a 3+ day show)
- **Timing:** immediately, on the scan that crosses the limit
- **Channel:** `telegram` (in-flow, not a separate message — replaces the next confirmation)
- **Template:**
  ```
  ✅ Lead saved.

  You've used your free trial — the next scan unlocks with a Show Pass.

  ▸ {{show_name}} pass — $49 (covers the whole show)
  ▸ 3-show pack — $129 (great if you do quarterly trade events)

  [Get pass] {{checkout_url}}
  ```
- **Success metric:** Conversion rate (`checkout_completed` / paywall trigger fires)
- **A/B test ideas:**
  - $49 single-show vs $49 + $129 3-pack vs all three plans
  - "Trial used" framing vs "ready to upgrade" framing
  - With vs without `{{coupon_code}}` for users who came from a retargeting ad
  - Inline checkout URL vs standalone "Pay now" button

---

## Post-show

### `POSTSHOW_IMMEDIATE`

- **State:** `post_show`
- **Trigger condition:** End of `shows.end_date` AND user scanned at least one card
- **Timing:** at 21:00 in the user's timezone on `end_date`
- **Channel:** `email`
- **Template:**
  - **Subject:** `Your {{show_name}} sheet is ready`
  - **Body:**
    ```
    {{user_first_name}},

    {{show_name}} wraps today. You captured {{leads_count}} leads — they're all in
    your sheet now, nicely organized:

    {{sheet_url}}

    Your follow-up window is short. Most replies come within 7 days of meeting.
    Reply with /email <name> on Telegram and I'll draft a follow-up; or open the sheet
    and grab the email addresses yourself.

    Safe travels home.
    ```
- **Success metric:** Sheet click-through rate; PostHog `first_sheet_view` post-show
- **A/B test ideas:**
  - Lead count in subject vs not
  - Embedded preview (top 3 leads) vs link only

---

### `POSTSHOW_24H`

- **State:** `post_show`
- **Trigger condition:** 24 hours after `end_date` AND user has not sent any follow-up emails yet (`emails_sent` count = 0 OR `sb_emails_sent` count = 0)
- **Timing:** at 09:00 in the user's timezone, exactly 1 day after `end_date`
- **Channel:** `email`
- **Template:**
  - **Subject:** `Don't let your {{show_name}} leads go cold`
  - **Body:**
    ```
    Yesterday's leads are today's pipeline. The single highest-leverage thing you can
    do this morning is send three follow-ups before your inbox fills up.

    Open your sheet: {{sheet_url}}

    Or, on Telegram: /pending shows everyone you haven't emailed yet, and /email <name>
    drafts the follow-up so you don't have to.

    — DaGama
    ```
- **Success metric:** PostHog `email_sent_to_lead` count within 48 hours
- **A/B test ideas:**
  - "Three follow-ups" vs "the most promising five"
  - Personalize subject with `{{leads_count}}`

---

### `POSTSHOW_7D`

- **State:** `post_show`
- **Trigger condition:** 7 days after `end_date` AND user is on a paid plan (excludes free-tier)
- **Timing:** at 10:00 in the user's timezone, day 7 after `end_date`
- **Channel:** `email`, `in_product` (dashboard banner)
- **Template (email):**
  - **Subject:** `Quick favor: how was {{show_name}}?`
  - **Body:** *(see `NPS_7D_POST_SHOW` below — this is the same trigger, different framing.)*
- **Success metric:** NPS response rate
- **A/B test ideas:** see `NPS_7D_POST_SHOW`

---

### `POSTSHOW_30D`

- **State:** `post_show` → transitions to `dormant` if no upcoming show
- **Trigger condition:** 30 days after `end_date` AND no `user_upcoming_shows` row with `status = 'planned'`
- **Timing:** at 09:00 in the user's timezone, day 30 after `end_date`
- **Channel:** `email`
- **Template:**
  - **Subject:** `Where's your next show?`
  - **Body:**
    ```
    {{user_first_name}},

    It's been a month since {{show_name}}. Most attendees go to 4-6 trade events a year —
    if there's another one on your calendar, want to add it now so I can prep your next sheet?

    Reply with /myshows on Telegram, or set it up in 30 seconds: {{checkout_url}}

    No upcoming shows? No problem. I'll be here when there is one.
    ```
- **Success metric:** PostHog `next_show_added` count within 14 days; `subscription_renewed` for the next pass
- **A/B test ideas:**
  - Industry-relevant suggested shows in the email body
  - Shorter subject ("Next show?")

---

## Dormant reactivation

### `DORMANT_30D`

- **State:** `dormant`
- **Trigger condition:** No `card_scanned` for 30 days AND no `user_upcoming_shows` row with `status = 'planned'` for the next 30 days
- **Timing:** at 11:00 in the user's timezone, on the 30th dormant day
- **Channel:** `email`, `ad_audience` (add to `dormant_paid` segment in parallel)
- **Template:**
  - **Subject:** `Anything coming up?`
  - **Body:**
    ```
    Hi {{user_first_name}},

    No shows on the calendar for you right now. If you're planning anything in the
    next quarter — Canton Fair, IFA, CES, regional industry events — let me know
    and I'll get your sheet ready in advance.

    Add a show: /myshows on Telegram

    Or just reply to this email with a date and city and I'll handle the rest.

    — DaGama
    ```
- **Success metric:** PostHog `next_show_added` within 7 days of this email
- **A/B test ideas:**
  - Specific show suggestions based on user's past attendance pattern
  - Single-CTA email vs multi-CTA

---

### `DORMANT_60D`

- **State:** `dormant`
- **Trigger condition:** No `card_scanned` for 60 days AND no `user_upcoming_shows` AND user is on a paid plan
- **Timing:** at 11:00 in the user's timezone, on the 60th dormant day
- **Channel:** `email`
- **Template:**
  - **Subject:** `Pause your DaGama plan?`
  - **Body:**
    ```
    {{user_first_name}},

    It's been 60 days since you scanned a card. If trade events have slowed down
    for you, you can pause your plan — your sheets stay accessible, and you can
    resume anytime a show comes up.

    Pause plan: {{checkout_url}}/pause
    Cancel: {{cancel_url}}

    Or, if you've got a show coming up: /myshows on Telegram.

    — DaGama
    ```
- **Success metric:** Pause rate vs cancel rate; downstream re-activation rate
- **A/B test ideas:**
  - Lead with pause vs lead with re-engagement
  - Add a discount offer for resume

---

### `DORMANT_90D`

- **State:** `dormant`
- **Trigger condition:** No `card_scanned` for 90 days AND no `user_upcoming_shows`
- **Timing:** at 11:00 in the user's timezone, on the 90th dormant day
- **Channel:** `email`, `ad_audience` (add to `dormant_paid` segment for retargeting)
- **Template:**
  - **Subject:** `One last check-in`
  - **Body:**
    ```
    {{user_first_name}},

    Last note from me — if trade events aren't on your calendar right now, I'll stop
    bothering your inbox. Your sheets stay live forever and you can come back any time.

    Got something coming up? /myshows.
    Want to keep getting industry-event roundups? [yes — keep me on the list]({{cancel_url}}?keep=true)
    Want off entirely? [unsubscribe]({{cancel_url}})

    Either way, thanks for trying DaGama.
    ```
- **Success metric:** Re-activation rate over next 6 months (low expectation, high information value)
- **A/B test ideas:**
  - Goodbye framing vs "we'll be here"
  - Offer a coupon (`{{coupon_code}}` for `WINBACK_90D`) for re-subscribing

---

## Pre-next-show (highest leverage)

### `PRE_NEXT_SHOW_7DAY`

- **State:** `pre_next_show`
- **Trigger condition:** User has any `user_upcoming_shows` row with `status = 'planned'` AND `shows.start_date - today` between 5 and 7 days AND user has at least one previous `attended` show in their history
- **Timing:** at 10:00 in the user's timezone, 7 days before `start_date`
- **Channel:** `email`, `telegram`
- **Template (email):**
  - **Subject:** `{{show_name}} in 7 days — your sheet's ready`
  - **Body:**
    ```
    {{user_first_name}},

    Heads up — {{show_name}} starts {{show_start_date}}. I've already created
    your sheet so you can hit the ground running:

    {{sheet_url}}

    Last show ({{prev_show_name}}) you captured {{prev_leads_count}} leads. Want to
    beat that? See you there.

    — DaGama
    ```
- **Success metric:** Day-1 scan rate for the upcoming show vs the user's previous shows
- **A/B test ideas:**
  - Reference last show's lead count vs not (might feel performative)
  - Pre-create the sheet (current default) vs lazy-create on first scan

---

## Upgrade prompts

### `UPGRADE_SINGLE_TO_3PACK`

- **State:** state-agnostic — fires when condition is met
- **Trigger condition:** User has bought a `single_show` plan AND has an `attended` show + 1 `planned` upcoming show
- **Timing:** day after `attended` show ends
- **Channel:** `email`, `in_product`
- **Template (email):**
  - **Subject:** `You did 1 show. Want a discount on the next 3?`
  - **Body:**
    ```
    {{user_first_name}},

    You bought a single-show pass for {{show_name}}, and I see {{next_show_name}} on
    your calendar. Heads up — the 3-show pack is only $129 (vs $147 if bought
    separately). Future-you will thank past-you for budget-locking it now.

    [Upgrade to 3-show pack]({{checkout_url}})
    ```
- **Success metric:** Conversion rate from single-show holders to 3-pack
- **A/B test ideas:**
  - Numerical-savings framing ("$18 off") vs psychological ("good for whole year")
  - Time-limited offer vs evergreen

---

### `UPGRADE_3PACK_TO_TEAM`

- **State:** state-agnostic
- **Trigger condition:** User on `3_show_pack` plan AND has invited a colleague (referral) OR sheet has been opened by ≥2 distinct Google accounts
- **Timing:** within 24 hours of detecting multi-user sheet access
- **Channel:** `email`
- **Template:**
  - **Subject:** `Your team's already using DaGama — make it official?`
  - **Body:**
    ```
    {{user_first_name}},

    Looks like you and a teammate are sharing your DaGama sheets. Smart. Want to
    upgrade to the Team Plan? Unlimited shows, separate logins per teammate so
    everyone gets their own follow-up flows.

    Team Plan: $79/month, cancels anytime.

    [Upgrade]({{checkout_url}})
    ```
- **Success metric:** Conversion rate to team plan
- **A/B test ideas:**
  - Mention specific colleagues by email (privacy-OK since they accessed the sheet voluntarily) vs anonymous

---

### `UPGRADE_INDIVIDUAL_TO_TEAM`

- **State:** state-agnostic
- **Trigger condition:** User has bought ≥3 single-show passes in past 12 months
- **Timing:** day after their 3rd single-show pass purchase
- **Channel:** `email`
- **Template:**
  - **Subject:** `Math: 3 single-show passes vs Team Plan`
  - **Body:**
    ```
    {{user_first_name}},

    You've bought 3 single-show passes ($147 total). The Team Plan is $79/month
    — for two months that's the same money, except you also get unlimited shows
    AND can add up to 5 teammates.

    [Switch to Team Plan]({{checkout_url}})
    ```
- **Success metric:** Conversion to team plan
- **A/B test ideas:**
  - Math-forward subject vs benefit-forward
  - Show prorated savings calculation

---

## Referral mechanics

### `REFERRAL_INVITE_TRIGGER`

- **State:** state-agnostic
- **Trigger condition:** User has scanned ≥10 cards at any show (proxy for "they've found value")
- **Timing:** within 1 hour of the 10th-card scan
- **Channel:** `telegram`, `in_product` (dashboard banner)
- **Template (Telegram):**
  ```
  🎉 You've scanned 10 leads — you're getting your money's worth.

  Know anyone else attending shows? Send them this link and you both get a free pass:

  {{referral_link}}
  ```
- **Success metric:** PostHog event `referral_link_shared`; downstream `signup_completed` with `referrer_id` set
- **A/B test ideas:**
  - "10 leads" vs "10 cards captured" vs "10 conversations recorded"
  - Free pass for both vs free pass for referrer only

---

### `REFERRAL_REWARD_CONFIRMATION`

- **State:** state-agnostic
- **Trigger condition:** A referred user completes their first paid checkout
- **Timing:** within 1 minute of `checkout_completed` for the referee
- **Channel:** `telegram` (referrer), `email` (both)
- **Template (referrer Telegram):**
  ```
  🎁 {{referee_first_name}} just signed up via your link — your free pass is unlocked.

  Use it on your next show: /myshows
  ```
- **Success metric:** Referral-to-paid conversion rate
- **A/B test ideas:**
  - Reveal referee name vs not (privacy preference)
  - Extra reward for X referrals (links to milestone unlocks below)

---

### `REFERRAL_MILESTONE_UNLOCK`

- **State:** state-agnostic
- **Trigger condition:** User reaches 1, 3, 5, or 10 successful referrals
- **Timing:** immediately on milestone
- **Channel:** `telegram`, `email`
- **Template (1 referral):** "🎁 First referral. Free show pass earned."
- **Template (3 referrals):** "🥉 Three referrals — you've covered a year of trade-show passes. Free Team Plan month earned."
- **Template (5 referrals):** "🥈 Five referrals — you're a DaGama power user. Free Team Plan year earned."
- **Template (10 referrals):** "🥇 Ten referrals — let's talk. Reply to this email and we'll set up an Organizer plan for you."
- **Success metric:** Referral curve shape; how many users reach each tier
- **A/B test ideas:**
  - Different reward tiers
  - Public leaderboard (privacy review needed)

---

## NPS and feedback surveys

### `NPS_7D_POST_SHOW`

- **State:** `post_show`
- **Trigger condition:** 7 days after `shows.end_date` AND user scanned ≥3 cards at the show AND user is on a paid plan
- **Timing:** at 10:00 in the user's timezone, day 7 after `end_date`
- **Channel:** `email`
- **Template:**
  - **Subject:** `Quick favor: how was {{show_name}}?`
  - **Body:**
    ```
    {{user_first_name}},

    On a scale of 0-10, how likely are you to recommend DaGama to a colleague who
    attends trade shows?

    [0]({{nps_url}}?score=0) [1]({{nps_url}}?score=1) ... [10]({{nps_url}}?score=10)

    Optional: one sentence on why?

    Thank you — your feedback shapes what I build next.
    ```
- **Success metric:** Response rate (target: ≥25%); NPS score itself; categorize free-text replies into themes
- **A/B test ideas:**
  - In-email score buttons vs link to a form
  - With or without "one sentence on why"
  - Day 7 vs day 14 timing

---

### `EXIT_SURVEY_ON_CANCELLATION`

- **State:** state-agnostic, sub-state `canceling`
- **Trigger condition:** Stripe `customer.subscription.deleted` webhook fired (or one-time pass expired without renewal AND user clicks "cancel" in dashboard)
- **Timing:** immediately
- **Channel:** `in_product` (dashboard modal during cancel flow), `email` (24h after if cancel was via Stripe portal)
- **Template (in-product):**
  ```
  Sorry to see you go. Two questions before you leave?

  1. What's the main reason?
     ◯ Not enough trade shows for me right now
     ◯ Price too high
     ◯ Missing a feature I needed: [text]
     ◯ Switched to a competitor: [text]
     ◯ Other: [text]

  2. Anything that would have changed your mind?
     [text]

  [Submit and cancel] [Actually, never mind]
  ```
- **Success metric:** Survey completion rate (target ≥50%); win-back potential for "missing feature" / "price" segments
- **A/B test ideas:**
  - Two-question vs one-question vs five-question
  - "Actually, never mind" prominence
  - Offer pause as alternative to cancel
  - Discount offer for "price too high" responders

---

## Template block (copy this when adding a new rule)

```markdown
### `RULE_ID_HERE`

- **State:** `pre_show` | `during_show` | `post_show` | `dormant` | `pre_next_show` | state-agnostic
- **Trigger condition:** [precise predicate — what data must be true for this to fire]
- **Timing:** [exact time, including timezone reference]
- **Channel:** `email` | `telegram` | `whatsapp` | `in_product` | `ad_audience`
- **Template:**
  - **Subject:** `...`
  - **Body:**
    ```
    [body with {{variables}}]
    ```
- **Success metric:** [the PostHog event or other measure that confirms the rule worked]
- **A/B test ideas:**
  - [variant 1]
  - [variant 2]
```

---

## Operational notes

- **Idempotency:** Phase 4 stores `(user_id, rule_id, show_id)` after firing. A rule fires at most once per user per show. Recurring rules need a `cooldown_days` field.
- **Channel priority:** `telegram` > `email` for time-sensitive (`PRESHOW_24H`, `DURING_*`); `email` > `telegram` for marketing (`POSTSHOW_*`, `DORMANT_*`, `UPGRADE_*`).
- **Quiet hours:** never fire any rule between 22:00 and 07:00 in the user's local timezone unless it's an immediate response to a user action.
- **Free tier:** rules referring to "paid plan only" exclude users still in trial. Trial users get `DURING_PAYWALL_TRIGGER` instead.
- **GDPR:** rules with `Channel: ad_audience` only fire for users with `consents.ads = true` (Phase 6 §6.4 enforces this).
- **Languages:** all templates are English for now; Phase 4 routing falls back to English when the user's preferred language isn't available. Translated templates ship as `<template_id>.<lang>.ts` files in Phase 5.
