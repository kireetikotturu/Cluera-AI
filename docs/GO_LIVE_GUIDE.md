# Cluera go-live guide (start here)

One page that takes you from "code on my PC" to "customers can pay with Razorpay and the desktop app answers with Gemini and Deepgram". It replaces the long historical notes in this folder for day-to-day work. Do the steps in order and tick each box.

**The pieces**

| Piece | Where it lives | What it does |
| --- | --- | --- |
| Website + Admin + payments API | **Vercel** project `cluera-ai-staging` (folder `web/`) | Pricing, checkout, Admin panel, Razorpay webhook |
| Relay | **Render** service `cluera-ai-relay-staging` (folder `backend/`) | Talks to Gemini/Deepgram for the desktop app and runs the once-a-minute payment worker |
| Database | **Supabase** project `yhnqlfcgrmckhyjdxegg` | Accounts, balances, orders, encrypted AI keys |
| Desktop app | Windows `.exe` | Signs in to the same website address. **Do not change the website address**: the installed app points to `https://cluera-ai-staging.vercel.app` |

Never paste a secret into chat, Git or a screenshot. Secrets go only into the Vercel, Render or Razorpay dashboards.

---

## Step 1 - Put this code on GitHub and deploy it

This folder is a copy of the repository `https://github.com/kireetikotturu/Cluera-AI` (branch `staging`) but has no history, so link it to the real history first. In PowerShell:

```powershell
cd "C:\Users\kiree\Downloads\sigmaroundAI Copies\products\cluera-ai"
git fetch origin
git reset origin/staging        # keeps your files, only moves Git's pointer
git status                      # should list only the files changed for this guide
git add -A
git commit -m "Simple Admin setup for AI keys, payment checklist, legal pages, go-live guide"
git push origin staging
```

`git status` must **not** show `.env` files, `.local-secrets`, `*.exe`, or `node_modules` (they are ignored). If it does, stop and do not commit.

GitHub Actions (`Cluera verification`) runs the tests on every push. Wait for the green tick. Vercel and Render rebuild from the branch automatically if auto-deploy is on; if not, press **Redeploy** in each dashboard.

- [ ] Pushed and the GitHub check is green
- [ ] Vercel deployment is **Ready**; Render shows **Live**

> **Redeploy Vercel after every environment-variable change.** The page security policy that allows the Razorpay popup is calculated when the site is built.

---

## Step 2 - Razorpay dashboard

You can finish everything with **Test mode** first (no real money) and switch to **Live** after. The steps are identical; Live needs your KYC approved.

1. **Keys:** Dashboard → *Account & Settings → API Keys → Generate key*. You get a **Key Id** (`rzp_test_...` or `rzp_live_...`) and a **Key Secret** (shown once). Keep both private.
2. **Account id:** your Merchant ID with `acc_` in front, for example `acc_AbCdEf123456`. Confirm it later from a webhook delivery: its JSON starts with `"account_id": "acc_..."`. If that differs from what you configured, payments will be refused.
3. **Webhook** (Dashboard → *Account & Settings → Webhooks → Add new webhook*), one for Test mode and one for Live mode:

   | Field | Test mode | Live mode |
   | --- | --- | --- |
   | URL | `https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook` | `https://cluera-ai-staging.vercel.app/api/account/payments/cluera/live/webhook` |
   | Secret | a random string of at least 32 characters you invent (you will reuse it in Vercel) | a different random string (generate with the helper below) |
   | Events | `payment.captured`, `order.paid`, `refund.processed` | same |

   Add the `subscription.*` events (authenticated, activated, charged, pending, halted, cancelled, paused, resumed, completed, updated) only when you later open monthly plans.
4. **Live only:** complete KYC/activation and the website review. Razorpay checks that your site shows **Terms, Privacy and Refund/Cancellation** pages and a contact. They now exist at `/terms`, `/privacy` and `/refunds` and are linked in the footer. **Read them and edit them to match your real business** (`web/app/terms/page.tsx`, `privacy`, `refunds`), then submit the site address `https://cluera-ai-staging.vercel.app` to Razorpay.

Helper that prints the Live digest, the webhook secrets and the exact Vercel/Render lists for you (it contacts nothing and writes nothing):

```powershell
node scripts\payments\razorpay-go-live.cjs secrets
node scripts\payments\razorpay-go-live.cjs plan --key-id rzp_live_XXXX --account-id acc_XXXX
```

- [ ] Keys created, account id noted
- [ ] Webhook created, **Enabled**, with the correct URL, secret and events

---

## Step 3 - Vercel settings

Vercel → project `cluera-ai-staging` → *Settings → Environment Variables* (Production). Mark every secret **Sensitive**. The accounts/Supabase/cookie variables are already set from earlier work; do not change them. Only add the block for the mode you are enabling.

**Already present (leave alone):** `SIGMAROUND_ACCOUNTS_ENABLED=true`, `SIGMAROUND_ACCOUNT_ORIGIN=https://cluera-ai-staging.vercel.app`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64`, `SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64`, the AI vault pair (Step 4).

### 3A. Test mode (try the whole flow with fake money)

| Name | Value |
| --- | --- |
| `CLUERA_BILLING_V2_ENABLED` | `true` |
| `CLUERA_BILLING_UI_MODE` | `test` (or remove it) |
| `RAZORPAY_ENVIRONMENT` | `test` |
| `RAZORPAY_TEST_KEY_ID` / `RAZORPAY_TEST_KEY_SECRET` | Test key pair |
| `RAZORPAY_TEST_ACCOUNT_ID` | `acc_...` |
| `RAZORPAY_TEST_WEBHOOK_SECRET` | the Test webhook secret (32+ characters) |
| `SIGMAROUND_RAZORPAY_TEST_PROJECT_REF` | `yhnqlfcgrmckhyjdxegg` |
| `CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED` | `true` |
| `SIGMAROUND_PAYMENT_PROVIDER` | `razorpay` |
| `SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED` | `false` |
| `SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED` | `true` |
| `SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED` | `true` |
| `SIGMAROUND_PAYMENT_TESTER_IDS` | your Cluera user id (Supabase → Authentication → Users → *User UID*); comma-separate up to 50 |
| `SIGMAROUND_BILLING_WORKER_SECRET` | a random 32+ character secret; the **same** value goes to Render |
| `CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED` | `true` (also on Render) |

Test mode only lets the listed accounts buy.

### 3B. Live mode (real money, every customer)

`node scripts\payments\razorpay-go-live.cjs plan --key-id <live key id> --account-id <acc_...>` prints this block with your digest already filled in. In short:

| Name | Value |
| --- | --- |
| `CLUERA_BILLING_V2_ENABLED` | `true` |
| `CLUERA_BILLING_UI_MODE` | `live` |
| `RAZORPAY_LIVE_KEY_ID`, `RAZORPAY_LIVE_KEY_SECRET`, `RAZORPAY_LIVE_ACCOUNT_ID` | Live key pair and `acc_...` |
| `RAZORPAY_LIVE_WEBHOOK_SECRET` | the Live webhook secret |
| `CLUERA_LIVE_WORKER_SECRET` | a different random secret; same value on Render |
| `CLUERA_LIVE_PROJECT_REF` | `yhnqlfcgrmckhyjdxegg` |
| `CLUERA_LIVE_ACCOUNT_ORIGIN`, `CLUERA_LIVE_APPROVED_ORIGIN` | `https://cluera-ai-staging.vercel.app` |
| `CLUERA_LIVE_MERCHANT_DIGEST` | printed by the helper |
| `CLUERA_LIVE_OWNER_APPROVED`, `CLUERA_LIVE_SECURITY_ACCEPTED`, `CLUERA_LIVE_TEST_ACCEPTED`, `CLUERA_LIVE_RUNTIME_ACCEPTED` | `true` (your written go-ahead) |
| `CLUERA_LIVE_INTAKE_ENABLED`, `CLUERA_LIVE_SCHEDULER_ENABLED`, `CLUERA_LIVE_HISTORY_ENABLED`, `CLUERA_LIVE_ADMIN_ENABLED` | `true` |
| `CLUERA_LIVE_CHECKOUT_ENABLED` | `true` (set it in Step 5, after the database is ready) |
| `CLUERA_LIVE_PURCHASER_IDS` | your own user id for the **first** real payment |
| `CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED` | add `true` only after the first real payment works: then every verified customer can buy |

Do **not** change `RAZORPAY_ENVIRONMENT` for Live; Live uses its own variables.

After saving, **Redeploy**. Then open Admin → *Cluera billing* → **Check payment setup**. It lists each missing item in plain words and which variable fixes it. Repeat until it says **Ready**.

- [ ] Variables saved, site redeployed
- [ ] Checklist items for Website and Razorpay are green

---

## Step 4 - Render settings (relay: AI and payment worker)

Render → `cluera-ai-relay-staging` → *Environment*. Values for `backend/.env.example` are listed there.

**AI (needed for the desktop app):**

| Name | Value |
| --- | --- |
| `SIGMAROUND_ACCOUNT_RELAY_ENABLED`, `SIGMAROUND_ACCOUNTS_ENABLED` | `true` |
| `SIGMAROUND_ACCOUNT_ORIGIN` / `NEXT_PUBLIC_SUPABASE_URL` | same as Vercel |
| `SUPABASE_SERVICE_ROLE_KEY`, `SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64` | same as Vercel |
| `CLUERA_AI_BOOTSTRAP_MODE` | `admin-vault` |
| `CLUERA_PROVIDER_VAULT_KEYRING_BASE64` | **identical** to the same variable in Vercel |
| `CLUERA_PROVIDER_TELEMETRY_ENABLED` | `true` (optional usage figures in Admin) |

And in **Vercel**: `CLUERA_PROVIDER_VAULT_ENABLED=true` and the same `CLUERA_PROVIDER_VAULT_KEYRING_BASE64`.

If the keyring does not exist yet, create it once (prints one line; paste it into both dashboards; never reuse the cookie or rate secrets):

```powershell
node -e "const k=require('crypto').randomBytes(32).toString('base64');console.log(Buffer.from(JSON.stringify({active:'cluera-1',keys:{'cluera-1':k}})).toString('base64'))"
```

Earlier notes say this was already configured; if so, skip it. The Admin screen tells you if it is missing.

**Payment worker (credits are granted by a once-a-minute job on Render):** add this only when payments are on, all values filled, otherwise the relay refuses to start:

- Test: `CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED=true`, `SIGMAROUND_BILLING_WORKER_SECRET=<same as Vercel>`
- Live: `CLUERA_LIVE_OWNER_APPROVED=true`, `CLUERA_LIVE_RUNTIME_ACCEPTED=true`, `CLUERA_LIVE_SCHEDULER_ENABLED=true`, `CLUERA_LIVE_WORKER_EPOCH=<number from Step 5>`, `CLUERA_LIVE_WORKER_SECRET=<same as Vercel>`, `CLUERA_LIVE_ACCOUNT_ORIGIN`, `CLUERA_LIVE_APPROVED_ORIGIN`, `CLUERA_LIVE_MERCHANT_DIGEST`, `NEXT_PUBLIC_SUPABASE_URL`

Open `https://cluera-ai-relay-staging.onrender.com/healthz` after the deploy; it should answer `{"ok":true}`. (A free Render plan sleeps; if credits arrive slowly after a payment, use a paid always-on instance.)

- [ ] Relay deployed and healthy

---

## Step 5 - Database for Live payments (skip for Test mode)

The database keeps Test and Live money in separate ledgers. Moving to Live is three small SQL steps that you **review and paste yourself** into Supabase → *SQL Editor*. The helper writes them; it never runs them.

1. **Profile** (epoch is 1 at the start):

   ```powershell
   node scripts\payments\razorpay-go-live.cjs sql --phase profile --key-id <live key id> --account-id <acc_...> --epoch 1
   ```

   Paste the output into the SQL Editor and run it. Then read the new epoch:

   ```sql
   select owner, epoch from cluera_live_billing_private.processing_owner;
   ```

   Expected: owner `cluera`. Use that epoch number everywhere below and as `CLUERA_LIVE_WORKER_EPOCH` on Render.
2. **Intake** (lets the Live webhook store paid events): same command with `--phase intake --epoch <epoch>`. Run it after the Step 3B variables, the Live webhook and the Step 4 worker are saved and deployed.
3. **Promote** (the switch to real charging): `--phase promote --epoch <epoch>`. Run it only when no one is using the app and you are ready for real customers. It refuses unless the Live webhook is working and **no unfinished Test purchase exists**.

   If promote says *Acceptance or Test reconciliation incomplete*, find the blocker:

   ```sql
   select id, user_id, state, order_id, created_at from cluera_billing_private.intents where state in ('CREATING','BOUND','UNCERTAIN');
   select count(*) from cluera_billing_private.events where state = 'PENDING';
   ```

   An old Test order still sitting in `BOUND` (for example the support account's retained ₹549 order that Razorpay marked *Attempted/failed*) blocks the switch on purpose. **Do not edit or delete these rows by hand**; the ledger is audited. Ask for a reviewed close-out of that single Test order, or finish a Test payment for a fresh test account first so nothing is left unresolved.

After promote, set `CLUERA_LIVE_CHECKOUT_ENABLED=true` in Vercel (Step 3B) and redeploy.

- [ ] Profile, intake and promote SQL ran with no error
- [ ] Admin checklist shows the database item green

---

## Step 6 - Admin panel (the simple way)

Open `https://cluera-ai-staging.vercel.app/account/admin`, sign in and enter your authenticator code. The top of the page now lists the first-time order: **Turn on AI, Turn on payments, Look after customers**.

**Turn on payments**

1. *Cluera billing → Payment setup checklist → Check payment setup.* Fix any red line (each says which variable to set).
2. In the **Test** (or **Live**) billing plans card press **Refresh billing catalog**, then **Load billing authenticators**.
3. On the **3-hour pack** card choose *Set current catalog availability*, tick **Enabled**, write a reason (10+ characters), choose your authenticator, enter the fresh 6-digit code, **Confirm**.
4. Run **Check payment setup** again. It should say *Ready*.

**Turn on AI (Gemini and Deepgram)** - *Providers → AI setup in one step*

1. Press **Check status**. If it says the vault is not switched on, finish Step 4 (keyring) first.
2. Under **Google Gemini** paste your Gemini API key, enter the current 6-digit code, press **Save and enable**. It encrypts the key, checks it with Google, switches it on and approves the model (`gemini-3.5-flash`) for the desktop app, all with that one code.
3. Do the same for **Deepgram** with its own key and a fresh code (model `flux-general-en`).
4. Each card should say **Ready**. If a card says the provider does not list the model, use a key from an account that can use that model.

The old multi-step form is still there under *Advanced*; you do not need it.

Set a spending limit/alert in the Google and Deepgram dashboards: these are shared keys and real usage costs money.

- [ ] Pack enabled, checklist says Ready
- [ ] Gemini card Ready, Deepgram card Ready

---

## Step 7 - Prove it works

**Payment (do this once in Test mode, then once in Live):**

1. Sign in on the website with the account you listed (`SIGMAROUND_PAYMENT_TESTER_IDS` or `CLUERA_LIVE_PURCHASER_IDS`).
2. Open `/pricing` → **Buy Now** on the 3-hour pack. Razorpay's popup opens.
   - Test mode: use Razorpay's test card/UPI from <https://razorpay.com/docs/payments/payments/test-card-details/>.
   - Live: pay the real ₹549 with your own method (you can refund it afterwards in the Razorpay dashboard).
3. Wait up to about 2 minutes. The page shows *Payment verified* and your available time rises by **3 hours**. Billing history shows the payment as verified.
4. If the page stays on *awaiting confirmation*: do **not** pay again. In Razorpay → Webhooks check the delivery log for your URL (should be `200`). A `400` means a wrong secret or `account_id`; a `404` means intake is not switched on. Then see the table below.

**Desktop app (no change to the app is needed):**

1. Install/restart the Windows app, sign in with the same account.
2. **Start session**, create or pick your context, and speak: you should see a live transcript (Deepgram) and answers (Gemini).
3. The balance shown in the app drops and matches the website.

**Open to everyone (Live):** after the first real payment works end to end, add `CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED=true` in Vercel, redeploy, then test with a second, ordinary account.

---

## If something does not work

| What you see | Cause | Fix |
| --- | --- | --- |
| Buy buttons greyed, "Presentation only" / "Not yet purchasable" | The server cannot read an approved catalog | Admin → **Check payment setup** and fix the red lines; make sure `CLUERA_BILLING_V2_ENABLED=true` and you redeployed |
| Buy button greyed after signing in | Your account is not in the buyer list, or the pack is not enabled | Add your user id to the buyer variable (Step 3) or enable the pack (Step 6) |
| "You are signed in, but this account is not an approved purchaser" | Test mode with an unlisted account | List the user id, or go Live |
| Razorpay popup does not open / blocked by the browser | The site was built before payments were switched on | Redeploy Vercel |
| Paid, but no time added | Webhook not reaching the site, or no worker running | Check the Razorpay delivery log (above), the Render worker variables and `CLUERA_*_INTAKE_ENABLED` |
| Admin → Providers says the vault is not switched on | Keyring/enable flag missing | Step 4 AI table |
| Admin checklist: database profile red | Step 5 not finished, or digest does not match the Live keys | Re-run the helper `plan` and compare the digest; run the missing SQL phase |
| Relay will not start after editing Render variables | A Live worker variable is half filled | Fill them all or remove the whole block |

**Pause sales quickly:** set `CLUERA_LIVE_CHECKOUT_ENABLED=false` (or Test: `SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED=true`) and redeploy. Leave intake, the worker and history on so payments already made are still credited. Never delete ledger rows.

---

## What changed in the code (no desktop `.exe` changes)

- **Admin → Providers:** new one-step *AI setup* ([AiQuickSetup.tsx](../web/app/account/admin/AiQuickSetup.tsx), server action `SETUP` in [admin.ts](../web/lib/aiProviders/admin.ts) and [quickSetup.ts](../web/lib/aiProviders/quickSetup.ts)). It runs the same audited database steps as the old form, with the same safety checks, using a single authenticator code. The old form is kept under *Advanced*.
- **Admin → Cluera billing:** new read-only *Payment setup checklist* ([PaymentReadiness.tsx](../web/app/account/admin/PaymentReadiness.tsx), [readiness.ts](../web/lib/payments/cluera/readiness.ts), `?readiness=1` on the existing admin billing endpoint). It never prints a secret and never changes anything.
- **Admin home:** a short "first-time setup order" under the section links.
- **Website:** Terms, Privacy and Refund pages (required by Razorpay), footer links, sitemap, and removal of the "Staging TEST software" footer text.
- **Tools:** [razorpay-go-live.cjs](../scripts/payments/razorpay-go-live.cjs) for digest, secrets, env lists and reviewable SQL; [backend/.env.example](../backend/.env.example) now matches the real Render settings.
- **Tests added:** `providerQuickSetup`, `aiQuickSetupUi`, `paymentReadiness`, extra cases in `clueraBillingRoutes`, and `razorpayGoLiveHelper`.

Payment security rules (signed webhooks, one order per purchase, exact-amount checks, audited ledger, Test/Live separation) are unchanged on purpose.
