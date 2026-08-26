# Ticket Reconciler

A live daily dashboard that matches ticket purchases against the credit card
charges that paid for them, and shows you what does not line up.

Drop in today's two exports — your purchases and your card transactions — and
the dashboard tells you, in one screen:

- which purchases are paid for, and how confident that pairing is
- which purchases have **no charge** behind them
- which charges have **no purchase** behind them (money out the door with nothing to show)
- which attempts were **declined** or **reversed**
- where your POS's payment state **disagrees with what the cards actually did**
- your net exposure for the day, in dollars

No build step, no database, no dependencies. Node 20+ and a browser.

There is also a single-file browser build — `ticket-reconciler-standalone.html`
— that needs nothing installed at all: open it and drop the files on the page.

```bash
node server.js          # → http://localhost:4173
```

Then drag both CSVs onto the page.

---

## What you can import

Three exports are recognised, in `.csv` or `.xlsx`, and the file type is worked
out from its column headers — you never say which is which.

| Export | Key columns | What it gives you |
| --- | --- | --- |
| **Purchase orders** (per ticket group) | `pos_po_id`, `payment_instrument_last_four`, `purchase_date` | Event names, seats, and the **card last-four** — the strongest matching signal |
| **Purchased Inventory** (per PO) | `PO Id`, `PO Date`, `Total Cost`, `PO Payment State` | Every PO with its **vendor** and the **payment state your POS believes** |
| **Card transactions** | `Last 4`, `Date (UTC)`, `Authorization Date (UTC)` | What actually happened on the cards |

The two purchase exports describe the same orders — `PO Id` is `pos_po_id`. Import
both and the newer one **replaces** those POs rather than counting them twice.

### If your purchase export has no card numbers

The Purchased Inventory export carries no card digits, so the matcher loses its
strongest signal. Two things take over:

- **Vendor.** A SeatGeek order can never be the TicketMaster charge sitting next
  to it, even at the same amount and the same minute. `Unknown Vendor` constrains
  nothing, so those still match on amount and time alone.
- **PO Payment State.** Your POS's claim, checked against reality. A PO marked
  **Paid** with no charge behind it says so in plain words; a PO marked
  **NotPaid** that *was* charged gets flagged on the matched row.

Matches made without a card top out at **likely** — see the confidence levels
below. Turning on **Require last-4 match** in the rules will refuse them
entirely, which with this export means refusing everything.

## How matching works

A purchase and a charge are paired when **all three** hold:

| Signal | Rule |
| --- | --- |
| Amount | Equal to the cent (a tolerance is configurable) |
| Time | Within the window, default 240 minutes |
| Card | The last four digits must not *contradict* — equal, or missing on one side |
| Vendor | The merchant must not *contradict* — a SeatGeek order is never a TM charge |

Two cards that differ are never paired, no matter how well the amount and time
agree. That single rule does most of the work: on a normal day dozens of
charges share an amount, and the card is what tells them apart.

Candidates are scored (same card ≫ exact amount ≫ closeness in time) and
assigned best-first, so the strongest pairing claims its charge before a weaker
one can. A charge is only ever spent once. The result is deterministic — the
same two files always reconcile the same way, regardless of row order.

Each match carries a confidence you can act on:

- **exact** — same card, same cent amount, minutes apart. Nothing to check.
- **likely** — one signal missing, usually a purchase with no card recorded
  (hard stock, TradeDesk, or the whole Purchased Inventory export). Something
  else still corroborates: a very close time, or an agreeing vendor.
- **review** — the amounts differ, or the only evidence is a coincidental
  amount and time.
- **manual** — you linked it by hand.
- **ambiguous** (a flag, not a level) — more than one charge fit *equally* well.
  The dashboard picks one and says so rather than pretending it knew.

Every unmatched row comes with a plain-English reason, not just a red mark:

> A $80.08 charge on card 3477 was DECLINED (an incorrect CVV was entered) — this purchase may not be paid for.

### Things the matcher gets right that are easy to get wrong

- **Settlements are timed by their authorization.** A settlement posts hours
  after the fact; only its authorization timestamp agrees with the purchase
  feed. Matching on the posting time would miss every settled row.
- **Both clock formats are the same clock.** The purchase feed writes
  `2026-08-26 16:50:13`, the card feed writes `2026-08-26 04:50:16PM`. These are
  read as the same wall-clock reading and are *not* timezone-converted. If your
  two sources ever do drift apart, set a **charge clock offset** in settings
  instead.
- **Declines and reversals never satisfy a purchase.** They are quarantined in
  their own tab — and when a purchase goes unmatched, a declined charge for the
  same amount is surfaced as the reason.
- **Zero-amount purchases** (transfers in, comped inventory) are bucketed as
  "no charge expected" rather than reported as missing money.
- **Refunds and credits** — positive amounts on the card feed — are separated
  from spend so they never masquerade as a payment.
- **Cross-midnight pairs survive the day filter.** Reconciliation always runs
  over the whole dataset; the day filter is applied to the *results*. A purchase
  at 23:58 whose authorization lands at 00:02 stays one transaction.
- **Leading zeros in card digits are preserved** — `0680` is not `680`.
- **Three timestamp formats, one clock.** `2026-08-26 16:50:13`,
  `2026-08-26 04:50:16PM` and `8/26/2026 4:50:13 PM +00:00` all mean the same
  moment. A real UTC offset is applied when one is present.
- **A totals row is not a purchase.** The Purchased Inventory export ends with a
  blank-PO summary line; it is skipped rather than imported as a $13,613.26 order.
- **Mismatched export windows are called out, not counted as loss.** Pull
  purchases up to 03:24 against card activity running to 17:49 and the afternoon's
  orders would look unpaid. The dashboard names both windows and how many rows
  fall outside the other file.

---

## Daily use

**1. Import.** Three ways, all equivalent:

- Drag CSVs anywhere onto the page
- **Import CSV** button
- Drop files into `./inbox/` — the server picks them up within seconds and
  moves them to `inbox/processed/`. Point your browser's download folder here
  and the dashboard keeps itself current.

The file type is detected from its headers; you never have to say which is which.

**2. Watch it live.** Every connected browser updates the moment new data
lands — no refreshing. The dot in the header turns red if the connection drops
and recovers on its own.

**3. Re-import as often as you like.** Rows are keyed by their source id, so
re-importing a fuller export of the same day updates rows in place. Nothing
duplicates. This is the intended rhythm: pull a fresh export every hour and drop
it in.

**4. Work the exceptions.** On any unmatched row, **Find charge** / **Find
purchase** opens the ranked candidates with the amount and time difference
spelled out — one click to link. **Ignore** parks a row you have decided is not
a reconciliation item. Manual links survive re-imports.

**5. Export.** The **Export** button produces one CSV containing every bucket —
matched, unpaid, unexplained, declined — for the selected day or all days.

---

## Settings

| Setting | Default | When to change it |
| --- | --- | --- |
| Amount tolerance | `$0.00` | If a processor adds fees, so the charge is a few cents off |
| Time window | `240` min | Shorten it on a heavy day to cut false pairings; lengthen it if authorizations lag |
| Charge clock offset | `0` min | If your two feeds are genuinely in different timezones |
| Require last-4 match | off | Turn on to refuse every guess where the purchase has no card recorded |

Changing a setting re-runs the reconciliation immediately across all data.

---

## Layout

```
server.js              HTTP server, imports, inbox watcher, SSE
src/csv.js             RFC 4180 parser and writer
src/xlsx.js            Minimal .xlsx reader (no dependencies)
src/normalize.js       Both exports → one canonical shape
src/match.js           The reconciliation engine (pure, no I/O)
src/report.js          Day scoping and totals
src/store.js           Atomic JSON persistence
public/                The dashboard (vanilla JS, no build)
samples/               Synthetic exports covering every case
test/                  84 tests: unit, engine, and full HTTP
```

`src/match.js` is pure and has no I/O, so it can be lifted into a script or a
cron job without the server.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | Port to listen on |
| `HOST` | `127.0.0.1` | Bind address — loopback only by default |
| `STORE_FILE` | `data/store.json` | Where imported data lives |
| `INBOX_DIR` | `./inbox` | Watched import folder |

### Data and privacy

Everything stays on the machine you run it on. `data/` and `inbox/` are
gitignored because imports contain card and account details; the `samples/`
files are synthetic. The server binds to loopback by default — set `HOST` only
if you intend to expose it, and put it behind auth if you do.

## Tests

```bash
npm test
```

84 tests: the CSV and XLSX parsers, all three timestamp formats, and the
matching rules — card conflicts, declines, reversals, manual
links, ambiguity, ordering stability — plus an end-to-end pass that boots the
server and drives the real HTTP API.

## Try it without your own data

```bash
node server.js
# then drop samples/sample-purchases.csv and samples/sample-transactions.csv on the page
```

The samples are built to exercise every bucket: exact matches, a settlement
matched by its authorization time, two purchases with no card recorded, a
decline, a reversal, a refund, orphan charges, and a same-amount-different-card
decoy that must *not* match.
