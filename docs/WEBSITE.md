# Website — pages, copy, design system

The marketing site + dashboard are served by the same worker as the bots. All five HTML pages are inline string constants in [src/index.ts](../src/index.ts).

> Status: **landing is in "coming soon" mode**. Login, register, dashboard, and onboard-complete are functional but unreleased. The full marketing site is a roadmap item — see [ROADMAP.md](ROADMAP.md).

Domain: **heydagama.com** (and `api.heydagama.com` for `/api/*`).

---

## Pages

### `/` — Landing (`LANDING_PAGE`)

Coming-soon page only. No nav, no signup CTA. Single email contact and a footer.

**Copy (verbatim, current):**
- Logo: **DaGama**
- Eyebrow: `COMING SOON`
- H1: **Trade show intelligence, reimagined.**
- Tagline: *"We're building the platform exhibitors and organizers will rely on to capture, qualify, and follow up on every lead. Launching soon."*
- CTA: ✉️ `hello@heydagama.com`
- Footer: `© <year> DaGama. All rights reserved.`

**Visual elements:**
- Pulsing gold dot next to the logo (CSS `pulse` animation, 2.4s loop)
- Two soft radial gradients in the background (gold at 20%/30% and 80%/80%) for atmosphere
- Centered card layout, max-width on tagline (38rem)
- Gradient text fill on H1 (white → gold)
- Glass-morphism contact pill (1px gold border, 10px backdrop blur)

---

### `/login` — Sign in (`LOGIN_PAGE`)

**Copy:**
- H1: **Log In**
- Inputs: Email address · Password
- Primary: **Log In** (gold gradient button)
- Footer link: *No account? **Sign up*** → `/register`

**Behavior:**
- POSTs `{email, password}` to `/api/auth/login`.
- On success: stores `dagama_token` + `dagama_user` in `localStorage`, redirects to `/dashboard`.
- Inline red error block on failure.
- Enter key triggers submit.

**Glass card** with fade-in-up animation (0.8s).

---

### `/register` — Sign up (`REGISTER_PAGE`)

Same surface as login. Email + password (+ name) → `POST /api/auth/register` → JWT → `/dashboard`.

---

### `/dashboard` — Authenticated dashboard (`DASHBOARD_PAGE`)

**Loaded data** (parallel `fetch`):
- `GET /api/stats` — lead counts, recent activity
- `GET /api/stripe/status` — current plan + `shows_remaining`
- `GET /api/me/onboarding-status` — has the user linked Telegram?

**Sections** (visible once data resolves):
- Plan banner — current plan + "Connect via /api/telegram/setup" if Telegram not linked yet
- Stats cards — total leads / active shows / pending follow-ups
- Sheet links — one row per `google_sheets` row from `GET /api/google/sheets`
- Subscription actions — **Manage billing** (POST `/api/stripe/portal`) / **Upgrade plan** (POST `/api/stripe/checkout`)
- Bot connect CTA — `t.me/<bot>?start=<onboarding_token>` deeplinks for BoothBot, SourceBot, DemoBot

Auth guard: if `localStorage.dagama_token` is missing, redirect to `/login`.

---

### `/onboard-complete` — Post-Stripe handoff (`ONBOARD_COMPLETE_PAGE`)

The Stripe success URL or Google OAuth landing page. Animated checkmark, single CTA: **Open Telegram** → `t.me/<bot>?start=<onboarding_token>`. Used when the user just paid or just signed up — pushes them straight to Telegram so the funnel doesn't lose them.

---

## Design system

### Brand identity
- **Name** — DaGama
- **Voice** — confident, understated, business-grade. Avoids hype words ("revolutionary", "AI-powered" as a hero phrase). Uses "*reimagined*", "*intelligence*", "*platform*" for the marketing layer; functional and warm in the bot copy.
- **No emojis in marketing copy.** Bot copy uses emojis as functional icons (📸 📦 ✅).

### Color tokens
```css
:root {
  --navy:        #0F1419;   /* primary background */
  --navy-light:  #1a2235;   /* alt panels */
  --navy-end:    #1a2844;   /* gradient stop for body */
  --gold:        #D4AF37;   /* accent + CTA primary */
  --gold-light:  #E8C547;   /* CTA hover + gradient end */
  --slate-400:   #94A3B8;   /* muted text */
  --slate-500:   #64748B;   /* footer / fine-print text */
  --white:       #F5F5F5;   /* primary text */
}
```

Body background is always `linear-gradient(135deg, var(--navy) 0%, var(--navy-end) 100%)`.

### Typography

| Use | Font | Weights |
|---|---|---|
| Headlines (H1) | **Playfair Display** (serif) | 700, 900 |
| Everything else | **Outfit** (sans) | 300, 400, 500, 600, 700 |

Fonts are loaded from Google Fonts with `preconnect` warmup.

### Components

#### Glass card surface
```css
background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
border: 1px solid rgba(212, 175, 55, 0.15);
border-radius: 16px;
backdrop-filter: blur(20px);
box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
```

#### Primary button (gold)
```css
background: linear-gradient(135deg, #D4AF37, #E8C547);
color: #0F1419;
font-weight: 600;
border-radius: 8px;
box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
/* hover: translateY(-3px); shadow grows */
```

#### Input field
```css
background: rgba(51, 65, 85, 0.5);
border: 1px solid rgba(212, 175, 55, 0.15);
border-radius: 8px;
color: #F5F5F5;
/* focus: gold border alpha 0.4, glow shadow */
```

#### Gradient text
```css
background: linear-gradient(135deg, #ffffff 0%, #E8C547 60%, #D4AF37 100%);
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
```

#### Pulsing dot
```css
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold);
       box-shadow: 0 0 16px rgba(212,175,55,0.7);
       animation: pulse 2.4s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.85); }
}
```

#### Background ambience
Two radial gradients on `body::before`:
```css
radial-gradient(circle at 20% 30%, rgba(212,175,55,0.10) 0%, transparent 55%),
radial-gradient(circle at 80% 80%, rgba(212,175,55,0.05) 0%, transparent 55%);
```

#### Animation tokens
- `fadeInUp 0.8s ease-out` — card mount
- `pulse 2.4s ease-in-out infinite` — logo dot
- Hover: `translateY(-3px)` + intensified shadow
- Transitions: `all 0.3s ease` (most), `0.25s ease` (contact pill)

### Spacing
- Container width: 420px (auth pages) / 38rem (landing tagline)
- Padding inside cards: 2rem
- Margin between form fields: 1.2rem
- H1 margin-bottom: 2rem (auth) / 1.5rem (landing)

### Responsive
Single breakpoint at 540px on landing — tightens logo margin and reduces letter-spacing on H1. Auth pages are fluid.

---

## Stack

- Plain HTML in template literals — no framework, no build step.
- Vanilla JS for the auth flow (`fetch`, `localStorage`).
- Google Fonts for type.
- No client-side routing — everything is a worker route.
- Cloudflare image transforms can fetch private R2 objects via `/_r2/<key>`.

---

## What needs building (vs. coming-soon)

⏳ Landing redesign with full marketing sections (hero / how it works / for sellers (BoothBot) / for buyers (SourceBot) / for freelancers (DemoBot) / pricing / testimonials / signup CTAs).
⏳ Per-product landing pages (one URL per bot — `/sellers`, `/buyers`, `/freelancers`).
⏳ Pricing page wired to `STRIPE_PRICE_*` IDs.
⏳ Signup → onboarding → Telegram deeplink flow accessible from landing (today it lives only behind the dashboard).
⏳ Localized copy for the 10 SourceBot languages.
⏳ Static assets (logo SVG, OG images, hero illustrations) — currently only `assets/photo-tip.png` lives in R2.
⏳ Public dashboard preview / demo video.

See [MARKETING.md](MARKETING.md) for positioning and copy direction once the spec-derived content lands.
