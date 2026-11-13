# Go-live, final steps (for the owner)

Do these six steps in order. Tick each box as you go. Nothing here needs coding. If a step does not say what you expect, stop and read "If something looks wrong" at the end of that step.

**Before you start, have these open:** the Supabase SQL editor for project `yhnqlfcgrmckhyjdxegg`, Vercel (project `cluera-ai-staging`), GitHub, the Razorpay dashboard (you will switch between **Test** and **Live** mode), and your Cluera Admin sign-in with your authenticator app.

**Never change the website address** `https://cluera-ai-staging.vercel.app`: the installed Windows app points to it. Nothing below changes it.

**Never edit or delete payment records by hand.** Every database change below is a prepared file you review first.

> The code changes made with this guide are saved on your computer on branch `staging` but are **not committed or pushed**. Step 2 explains how to publish them. The two SQL files in `docs/proposals/` were tested only on a throw-away copy; nobody has run them on your real database.

---

## 1. Close the two stuck Test orders, then run the "promote" SQL

Why: the "promote" SQL refuses to switch to real money while any Test order is unfinished. Two Test orders are stuck:

| Order | Intent id |
| --- | --- |
| `order_TpRplT79SeFnTp` | `f103baee-119c-49f9-b218-ee8e2fcc3a60` |
| `order_Trd46ZnYqCmuLp` | `4952c441-894e-4055-801d-3c8a702bc4e4` |

There was no existing way to close an unpaid order. The prepared file [proposals/cluera-test-intent-closeout.sql](proposals/cluera-test-intent-closeout.sql) closes **only these two**, changes nothing else, and leaves a permanent audit record for each. The "promote" check accepts every state except `CREATING`, `BOUND` and `UNCERTAIN`; after the close-out these two are `REJECTED`, which it accepts. The promote SQL itself is not changed.

- [ ] **1a. Read the file** `docs/proposals/cluera-test-intent-closeout.sql` (the top comments explain exactly what it does).
- [ ] **1b. Check Razorpay.** In the Razorpay dashboard switch to **Test mode**, open Transactions > Orders, search each order id above. Each must show **no captured payment**. (If one was actually paid, stop: the normal payment flow will finish it by itself and you do not need the close-out for that order.)
- [ ] **1c. Look at the problem first.** In the Supabase SQL editor run:
  ```sql
  select id, state, order_id from cluera_billing_private.intents where state in ('CREATING','BOUND','UNCERTAIN');
  select count(*) from cluera_billing_private.events where state = 'PENDING';
  ```
  Expect exactly the two intents above and a count of `0`. If you see anything else, stop and ask for help.
- [ ] **1d. Run the close-out.** Paste the whole content of `cluera-test-intent-closeout.sql` and press Run. It must say success. If it shows an error message starting with "Intent ... stop and review", nothing was changed; send me the message.
- [ ] **1e. Check it worked.** Run the first query from 1c again: expect **no rows**. Then run:
  ```sql
  select operation_id, created_at, reason from cluera_billing_private.cutover_audit where before_row->>'kind' = 'TEST_INTENT_CLOSEOUT';
  ```
  Expect two rows (the permanent record).
- [ ] **1f. Plan-management file (needed for step 3).** Read and then run [proposals/cluera-live-plan-management.sql](proposals/cluera-live-plan-management.sql) once. It adds the Plans screen's database support and repairs the Live catalog so the pack can be bought. It does not change any existing order, payment or price. (It also contains a safe rollback at the bottom.)
- [ ] **1g. Make the promote SQL.** In PowerShell, in the project folder (your real key and account ids go where shown; they are not secret):
  ```powershell
  node scripts\payments\razorpay-go-live.cjs sql --phase promote --key-id <rzp_live_...> --account-id <acc_...> --epoch 2 --acceptance <the 64-character value you used for the intake step, if you gave one>
  ```
  If you ran the intake step without `--acceptance`, leave that part out.
- [ ] **1h. Run it.** Paste the printed SQL into the Supabase SQL editor and Run. Run it when nobody is using the app.

**If promote still says "Acceptance or Test reconciliation incomplete":** run the two queries in 1c again. Something other than the two orders is still open; send me the rows. Do not edit them.

**Rollback:** each file has its rollback in comments at the bottom. The close-out rollback re-opens the two orders only if they still have no payment.

---

## 2. Switch on Live checkout and publish it

The Buy button only works when `CLUERA_LIVE_CHECKOUT_ENABLED` is `true` **and** the database promote (step 1) is done. Vercel Production builds from `main` and does not publish automatically, so you must publish by hand.

- [ ] **2a. Set the switch.** Vercel > project `cluera-ai-staging` > Settings > Environment Variables. Set `CLUERA_LIVE_CHECKOUT_ENABLED` = `true` for the **Production** environment only. Also confirm `CLUERA_LIVE_PURCHASER_IDS` contains **your own** Cluera account id (Admin > Customers: open your account, the id is shown as "Account: ..."). Leave `CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED` unset for now.
- [ ] **2b. Save the code.** In PowerShell in the project folder:
  ```powershell
  git status
  git add -A
  git commit -m "Plans screen, simpler Admin, billing fixes"
  git push origin staging
  ```
  Wait until the GitHub **Cluera verification** checks on `staging` are green (GitHub > Actions). If a check is red, do not continue; send me the failing step.
- [ ] **2c. Push to main.** On GitHub open a **Pull request** from `staging` into `main`, wait for green checks, then press **Merge**. This is the "push to main" that makes Vercel build a Production deployment.
- [ ] **2d. Publish.** Vercel > Deployments. Open the newest deployment built from `main` (it will say Production but not "Current"). Press **⋯ > Promote to Production** and confirm. The address stays `cluera-ai-staging.vercel.app`.
- [ ] **2e. Check.** Open `https://cluera-ai-staging.vercel.app/account/admin`, press **Check if payments are ready**. Every line should have a green tick. A red line says what to do next.

**If a variable is wrong:** change it in Vercel, press **⋯ > Redeploy** on the newest deployment, then **Promote to Production** again (a redeploy is not published automatically).

---

## 3. Add or edit your plans in Admin

Plans here are one-time packs of time (price in rupees, time in hours). Only plans that are **On** appear on the pricing page and checkout.

- [ ] **3a.** Admin (`/account/admin`) > **Payments and plans** > **Refresh plans**. The original "Cluera 3 Hours, ₹549" plan is listed and is **Off**.
- [ ] **3b. Add a plan:** **+ Add a plan**, type name, price (rupees) and hours, keep "Turn it On straight away" ticked if you want it on sale, **Review the change**. An **Are you sure?** box shows the values. Press **Yes, make this change**.
- [ ] **3c. Edit:** **Edit** on a plan, change name, price or hours. The confirm box shows **old and new** values. A new price or hours applies to **future purchases only**; anything already paid, and time already added, never changes.
- [ ] **3d. Turn On / Off:** **Turn On** or **Turn Off**. Off means customers cannot see or buy it.
- [ ] **3e. Remove:** **Remove** hides a plan (turns it Off and archives it). Nothing is deleted. Open **Removed plans** and press **Restore** to bring one back (it returns Off).
- [ ] **3f. Check the website.** Open `/pricing`: only plans that are On are shown, with the same prices.

No authenticator code is asked for each change; you stay protected by your normal Admin sign-in (it requires your authenticator), a confirm box on every change, and an automatic record of who changed what and when (shown under **Recent changes** on the Plans screen, and kept permanently in the database). A reason is optional.

**Careful when editing or removing:** if the confirm box says some customers have an unpaid checkout open for that plan, those customers will not be able to finish it. Prefer to change a plan when nobody is paying.

**Monthly plans:** not sold. They stay hidden and Off. Razorpay does not allow a monthly plan to be edited, so a price change would need a brand-new Razorpay plan; that is not part of this launch.

---

## 4. Make the first real payment, check it, and refund it

For safety only the account(s) in `CLUERA_LIVE_PURCHASER_IDS` can buy right now (that is you).

- [ ] **4a. Optional low-cost check:** in Admin add a plan "Payment check" for **₹1** and **0.1 hours**, On. (Razorpay's minimum is ₹1.) You can use your real plan instead.
- [ ] **4b.** Sign in on the website with your account, open `/pricing` or `/account/checkout`, press **Buy Now** on the plan, and pay with your own card or UPI in the Razorpay window.
- [ ] **4c. Check the website:** within about two minutes the page says **Payment verified** and your available time goes up by the plan's hours.
- [ ] **4d. Check Razorpay:** switch the dashboard to **Live mode** > Transactions > Payments: the payment is **Captured** for the exact amount. Settings > Webhooks > your Live webhook > recent deliveries show **200**.
- [ ] **4e. Check the Windows app:** it shows the same available time.
- [ ] **4f. Refund it:** Razorpay (Live mode) > the payment > **Refund** > full refund. After a couple of minutes the time from that payment is taken back (only unused time can be taken back). Check your balance went down by the same amount.
- [ ] **4g.** If you made a temporary plan, **Turn Off** or **Remove** it.

**If you pressed Buy and nothing happened,** or the page says payments are paused: run **Check if payments are ready** in Admin and follow the red line.

---

## 5. Open checkout to everyone

Do this only after step 4 worked and the refund came back.

- [ ] **5a.** Vercel > Settings > Environment Variables: set `CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED` = `true` for **Production**.
- [ ] **5b.** Vercel > Deployments > newest Production deployment > **⋯ > Redeploy**, then **⋯ > Promote to Production**.
- [ ] **5c.** Admin > **Check if payments are ready**: it should say "Payments are ready. Real payments are open to every verified customer." Also sign in with a second, ordinary test account and confirm it can open checkout.

---

## 6. Pausing sales quickly, and what to do when a payment does not credit

**Pause sales in seconds (no deploy):** Admin > Payments and plans > **Turn Off** every plan (confirm each). No new purchase can start. Someone already inside the Razorpay window can still finish and will still be credited. To resume, **Turn On** again.

**Hard stop (a minute or two):** Vercel > set `CLUERA_LIVE_CHECKOUT_ENABLED` = `false` > Redeploy > Promote to Production. Or Vercel > Deployments > an earlier good deployment > **⋯ > Promote**.

**Never switch off the payment confirmations** (`CLUERA_LIVE_INTAKE_ENABLED`) or the Razorpay webhook: paid orders must still be recorded.

**A customer paid but has no time (work down this list; stop when it is fixed):**
1. Wait 2-3 minutes. Credits are added by a worker that runs every minute.
2. Wake the worker: open `https://cluera-ai-relay-staging.onrender.com/healthz`; it should answer `{"ok":true}`. A free Render plan can sleep; wait another 2 minutes.
3. Razorpay (Live) > the payment: is it **Captured**? If it is *Failed* or *Authorized* only, nothing was taken and they must pay again.
4. Razorpay > Settings > Webhooks > Live webhook > recent deliveries for that payment: you want **200**. If it failed, press **Resend**.
5. Admin > Customers > search their email > check their allowances.
6. If it is still missing, do **not** create a second order for them and do not edit records. Send me the Razorpay payment id (`pay_...`) and the order id (`order_...`).
7. As a last resort for goodwill you can use Admin > Customers > **Add manual no-expiry minutes** with a clear reason; it is recorded as *not a purchase*. If they were charged and you cannot credit them, refund the payment in Razorpay.

**A customer says they cannot buy again ("payment pending"):** they have an unpaid checkout that is still open. Ask them to finish it, or to check their payment status. There is no one-click close-out for a real (Live) order; send me the account email and I will prepare a reviewed, audited close-out like the one in step 1.

**A foreign (international) card payment:** keep international payments switched off in Razorpay. Such a payment cannot be credited automatically; refund it.
