# MandateEscrow

A performance fee for someone who trades your Hyperliquid account, paid only if they kept to the rules you agreed on. You write the mandate in plain words ("BTC and ETH only, no shorts, stop at a $2k drawdown"). GenLayer validators each have an LLM turn it into a fixed rule set and must agree on every field. After the window, validators pull the account's public fills and funding payments from Hyperliquid, build the same report in code, and the code checks the rules. Break any rule and the fee pot plus the manager's bond go back to you, even if the account made money.

## Why I built this

I trade Korean stocks and crypto. In the Korean crypto chats I read, "I'll trade your account for a share of the profit" comes up every week, and between friends it's even more common. The agreement is always one message: *"비트·이더만, 숏 금지, 2천불 빠지면 멈춤."* When it goes wrong, the only evidence is screenshots, and screenshots crop out whatever doesn't fit the story.

Hyperliquid is the first venue where this doesn't have to be about trust. Every fill of every account is public, and so is every hourly funding payment. That second part turned out to matter more than I expected. While picking test accounts I found one whose 15 fills in a week were all SOL longs. Its funding history showed it also held a HYPE short, an XMR short and a yen perp the whole week, without a single trade in them. A "SOL only, longs only" check that reads fills alone would have passed it.

What can't be done in code is reading the mandate. People write rules in Korean, in English, with nicknames for coins, and with things that can't be checked at all (leverage, intent). So the split is:
- **the LLM translates** the mandate into a small rule schema, and lists what it couldn't turn into a rule;
- **validators must agree** on every rule field, so an ambiguous mandate fails instead of being enforced the way one model happened to read it;
- **code measures** everything else from published data, and only code moves money.

## How it works

```
propose(account, manager, mandate_text, rules_json, start, end, target_pnl_usd, bond)
    payable: the fee pot
    account        the Hyperliquid address being managed
    manager        the GenLayer address that gets the fee
    mandate_text   plain words, Korean or English (read by the validators' LLMs), or
    rules_json     the rule set directly (code only, no LLM)
    start, end     whole UTC hours, 1 hour to 7 days, starting within 30 days
accept(id, agreed_rules_hash)
    the named manager, before start, posts exactly the bond and quotes the sha256 of
    the stored rule set, so it agrees to what is on chain and nothing else
settle(id)         anyone, 10 min after the window
  ├─ report for (account, start, end): cached if anyone already built it, else
  │    every validator fetches userFillsByTime and userFunding for the window,
  │    pages through them, and builds the report in code; it must be identical
  ├─ code checks the rules against the report
  └─ breach            → allocator gets pot + bond
     no breach         → manager gets pot x min(net PnL, target) / target, plus the bond;
                         the rest of the pot returns to the allocator
audit(account, from, to, mandate_text, rules_json)
                   anyone: report and rule check for any closed past window, no money
cancel(id)         the allocator, before the manager accepts
void(id)           anyone, 30 days after a window that still has no settlement:
                   pot back to the allocator, bond back to the manager
check_rules(rules_json, account, from, to)    view: any rule set against a stored report
```

### The rule schema

| Field | Meaning | Checked against |
|---|---|---|
| `coins_allowed` | only these coins, or null | every coin with a fill **or a funding payment** |
| `coins_forbidden` | never these | same |
| `markets` | subset of `perp` (Hyperliquid crypto perps), `hip3` (builder perps: `xyz:NVDA`, `xyz:GOLD`…), `spot`, `outcome` | coin name format |
| `direction` | `any`, `long_only`, `short_only` | position before/after each fill, and the signed size in each funding payment |
| `max_position_usd` | largest position in one coin | `max(|before|, |after|) x fill price` on every perp fill |
| `max_fills` | most fills in the window | count |
| `max_drawdown_usd` | largest drop of realized PnL from its high | realized PnL curve: closed PnL − fees + funding, in time order |
| `flat_at_end` | nothing open at the end | the latest of last fill or last funding payment per coin |

The LLM also returns `unenforceable`: notes on parts of the mandate it could not turn into a rule (leverage, KRW amounts, time-of-day rules). Those are stored with the mandate so both sides see them before the manager accepts. They are not compared between validators and they never affect money.

### Consensus

**Reading the mandate.** The leader's model returns JSON; code validates it and puts it in canonical form (coins upper-case, `xyz:` dex prefix lower-case, sorted lists, whole-dollar limits). Each validator asks its own model and accepts only if every rule field matches exactly. A leader that drops `long_only`, widens the coin list, or returns non-canonical output is rejected. A mandate two models read differently ends without a decision, which is the honest outcome for a rule nobody can enforce.

**The report.** Settled Hyperliquid fills and funding payments never change, so there is nothing to tolerate: a validator fetches the same pages, builds its own report and compares the whole thing byte for byte (PnL to the micro-dollar, every coin with its first timestamp, every max position, every first short, what was open at the end). Paging is by time: each next page starts on the last row's millisecond and duplicates are dropped by key, so a page boundary inside one millisecond loses nothing. Errors are tagged: `[TRANSIENT]` (HTTP 429, timeouts) agrees only with another transient error and stores nothing; `[EXTERNAL]` (too much activity for 5 pages) must match exactly.

**Money.** Amounts in the report are integers in micro-USD (positions in 1e-8 units), parsed from Hyperliquid's decimal strings without floats.

## Live results (Studionet)

Contract: [`0x8FcE3984717067A50562fF8ab300f636BAF7A905`](https://explorer-studio.genlayer.com/address/0x8FcE3984717067A50562fF8ab300f636BAF7A905) · `glcheck`: deployed source matches `contracts/mandate_escrow.py` (sha256 `eb0ea569b1345180163c527f11090619285f9b80836fced7d086a5141dccf578, CRLF normalized`).

**Live mandates.** Both read from plain text by the validators' LLMs, on the same active account (`0x418a…8888`) for the same hour, 2026-11-09 02:00–03:00 UTC. Pot 10 GEN and bond 5 GEN each, target $500. The manager accepted each by quoting the stored `rules_hash`.

| Mandate (as written) | Rules the validators agreed on | Live report for the hour | Outcome |
|---|---|---|---|
| "Hyperliquid crypto perps only, no stock or commodity perps, no spot." | `markets: [perp]` | 5 fills, 3 funding payments; BTC, ETH, ENA, all perps; net PnL **$1,603.47** (closed 1,743.19 − fees 7.76 − funding 131.96) | **full_fee**: manager got 15 GEN (pot + bond) |
| "BTC와 ETH만 거래. 다른 코인은 안 됨." | `coins_allowed: [BTC, ETH]` | same report (cached, not fetched again) | **breach**: ENA long at `1794189946991`; allocator got 15 GEN although the account made $1,603 |
| "BTC only, long only." | `coins_allowed: [BTC]`, `direction: long_only` | — | cancelled before accept, pot of 10 GEN returned |

The same hour of trading paid one manager in full and cost the other its bond, and the only difference was what the mandate said.

**Audits of past windows** (same windows as the test fixtures; every number equals the independent `Decimal` reading in the tests):

| Account / window (UTC) | Mandate | Rules read | Net PnL | Breaches found | Votes |
|---|---|---|---|---|---|
| `0xfb8c…` 11-02 → 11-09 | "솔라나만 거래하고 롱만 하기로 했습니다. 레버리지는 3배 이하로 유지." | `coins_allowed: [SOL]`, `long_only`; unenforceable: *"Leverage limit cannot be verified from public fills"* | $2,704.07 | HYPE, XMR, xyz:JPY not allowed; HYPE and XMR short. All five seen only in funding payments: every fill was a SOL long | A,A,D,I,A |
| `0x4555…` 11-02 → 11-09 | "Crypto perps only. No stock or commodity perps. Long or short is fine." | `markets: [perp]` | $3,393.75 | xyz:INTC, xyz:GOOGL, xyz:NVDA (hip3) | A,I,A,I,A |
| `0xe651…` 11-04 | "비트, 이더, 솔만. 숏은 금지." | `coins_allowed: [BTC, ETH, SOL]`, `long_only` | $14,610.22 | SOL went short at `1793805295019` | A,I,I,A,A |
| `0xe651…` 11-05 | same | same | −$2,406.73 | none | A,I,I,A,A |
| `0x7fdb…` 11-02 → 11-09 | "Any coin except HYPE. Stop trading if realized losses reach $5,000 from the high." | `coins_forbidden: [HYPE]`, `max_drawdown_usd: 5000` | −$21,968.59 | HYPE traded; drawdown $22,962.56 | A,A,I,A,I |

A = AGREE, D = DISAGREE, I = IDLE. Every transaction above was `ACCEPTED` with leader `execution_result` `SUCCESS`; 13 transactions in all (5 audits, 3 proposes, 2 accepts, 1 cancel, 2 settles).

Every number comes from `demo_result.json` (written by `scripts/live_demo.mjs`) and only transactions whose leader `execution_result` was `SUCCESS` are listed.

## API

Writes: `propose`, `accept`, `cancel`, `settle`, `void`, `audit` (signatures above).

Views:
- `get_mandate(id)`: parties, account, mandate text, canonical rules, `rules_hash`, `unenforceable`, window, target, pot, bond, status (`open | active | settled | cancelled | void`), outcome (`breach | full_fee | partial_fee | no_fee | void`), amounts paid.
- `get_result(id)`: the settlement: outcome, net PnL, the list of breaches with evidence, amounts.
- `get_report(account, from, to)`: a stored report.
- `get_audit(n)`, `get_counts()`.
- `check_rules(rules_json, account, from, to)`: code-only check of any rule set against a stored report, no network.

A report (`audit` / `get_report`), shortened:

```json
{"account": "0xfb8c34145bdea190693325d0ab01e81120909b3f", "from": 1793577600, "to": 1794182400,
 "fills": 15, "funding_payments": 468,
 "closed_pnl": "196.674850", "fees": "33.123805", "funding": "2540.519749", "net_pnl": "2704.070794",
 "max_drawdown": "22.581543",
 "coins": {"HYPE": 1793577600062, "SOL": 1793641587337, "XMR": 1793577600062, "xyz:JPY": 1793577600062},
 "markets": ["perp", "hip3"], "max_position": {"SOL": ["61392.877520", 1793645461742]},
 "first_short": {"HYPE": 1793577600062, "XMR": 1793577600062},
 "first_long": {"SOL": 1793641587337, "xyz:JPY": 1793577600062},
 "open_at_end": ["HYPE", "XMR", "xyz:JPY"], "non_usdc_fee_fills": 0}
```

A breach: `{"rule": "direction", "coin": "SOL", "went": "short", "time": 1793805295019}` (time in ms, so anyone can find the fill).

Deploy and run:

```bash
npm install
node scripts/deploy.mjs contracts/mandate_escrow.py        # DEPLOYER_PK in .env, created and funded if missing
node scripts/live_demo.mjs <contract address>
python scripts/capture_fixture.py sol_hype 0xfb8c34145bdea190693325d0ab01e81120909b3f 2026-11-02T00:00 2026-11-09T00:00
py -3.12 glcheck.py manifest deployments.json             # https://github.com/zldqms6/glcheck
```

`deployments.json` lists the deployed address; `examples/glcheck.yml` (also active in `.github/workflows/`) fails CI if that address stops running the committed source.

## Tests

```bash
py -3.12 -m venv .venv && .venv/Scripts/pip install genlayer-test
.venv/Scripts/python -X utf8 -m pytest tests -q
```

22 direct-mode tests on **real Hyperliquid answers** saved in `tests/fixtures/` (captured 2026-11-09 with the contract's exact requests, page by page: 7 real accounts plus one empty address). Expected PnL comes from a separate reading of the fixtures in the test file (Python `Decimal`), not from the contract.
- **Report:** net PnL and fill counts match the independent reading on every fixture. Two pages of fills (2,000 + 902, one duplicate across the boundary) and of funding (500 + 93). An account with zero fills and 504 funding payments still shows seven held positions, three of them on builder perps. An address that never traded breaks nothing.
- **Rules on real accounts:** SOL-only account caught holding HYPE/XMR shorts and a yen perp (funding only). Long-only catches the day an account flipped SOL short, passes the next day, and `flat_at_end` catches the three positions left open. Crypto-only rejects `xyz:` stock perps. Position, drawdown ($22,962 real) and fill limits, both broken and not.
- **LLM:** a Korean mandate read into rules and checked in code. A validator rejects a leader that drops `long_only`, widens the coin list or returns non-canonical coins, and a validator whose own model reads an extra limit disagrees, while different `unenforceable` notes still agree. Invalid model output (empty coin list, unknown direction, negative limit, unknown market, no JSON) is refused and nothing is stored. A mandate that tries to close its `<mandate>` block reaches the model with the tags stripped.
- **Money:** full fee, partial fee (pot x 3,393.75 / 10,000), no fee on a loss, and a breach that sends pot + bond to the allocator although the account made $2,704. Accept needs the named manager, the exact rules hash, the exact bond, and must come before start. Propose input checks, cancel, settle timing, void after 30 days.
- **Consensus:** a validator rejects a report that hides the HYPE/XMR shorts, adds $100 of PnL, or claims nothing was open at the end. HTTP 429 on funding → `[TRANSIENT]`, nothing stored, mandate still active, settles normally afterwards.

Replacing the report comparison or the reading comparison in the validator with `return True` makes a test fail; I checked both.

On Windows, `tests/conftest.py` patches a temp-file unlink in gltest's loader.

## Limits

- **Realized PnL only.** The fee is on closed PnL minus fees plus funding inside the window. A manager can delay a loss by holding a losing position past the end. `flat_at_end` is the guard; there is no mark-to-market, because a mark price at an exact past second is not something every validator can fetch and agree on.
- **Positions without fills are seen hourly.** Funding payments reveal held positions once an hour. A position opened and closed within one hour shows up through its fills; a position held across the window without fills shows up through funding. A position held before the window and never touched shows up only if funding was paid on it inside the window (it always is, unless the funding rate was exactly zero).
- **Hyperliquid keeps only the 10,000 most recent fills per account** for `userFillsByTime`. A very active account (thousands of fills a day) must be settled soon after the window, or older fills fall off and the report would be built from less. The contract refuses windows that need more than 5 pages (10,000 fills or 2,500 funding rows).
- **No leverage or equity rules.** Account equity at a past time isn't in the public history the contract reads; the LLM lists such clauses as `unenforceable`. `max_position_usd` is the usable proxy.
- **Spot fees paid in tokens** are counted (`non_usdc_fee_fills`) but not converted to USD.
- **The account must be the managed one.** The contract can't know the account belongs to the allocator; that is agreed off chain like the mandate itself. It also can't stop the manager from trading — it only decides who gets the fee and the bond.
- **LLM agreement is strict on purpose.** A vague mandate ("mostly majors, be careful") will not reach agreement. Write numbers, or pass `rules_json`.
- **Studionet only.** Hyperliquid answered from Studionet's validators in every run; two of the 13 transactions had one DISAGREE vote each (the sol-only audit and the cancelled mandate's propose); the other active validators agreed both times. Rotation and IDLE votes are normal there.
