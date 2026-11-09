// Live run on Studionet against real Hyperliquid accounts.
//   node scripts/live_demo.mjs <contractAddress> [resume]
// 1) audit(): past windows of real accounts, each with a mandate in plain words
//    (the same windows the tests use, so the live reports can be compared with them)
// 2) two mandates on an active account for the next whole hour, read from plain
//    text by the validators' LLMs, accepted by the manager; one more cancelled
// 3) waits for the hour to end and settles both
// Allocator, manager and keeper are demo keys. Results go to demo_result.json;
// "resume" continues from it after a failure (or after the wait was interrupted).
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import fs from "node:fs";

const [address, mode] = process.argv.slice(2);
const GEN = 10n ** 18n;
const OUT = "demo_result.json";
const HOUR = 3600;

function key(name) {
  const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const m = env.match(new RegExp(`^${name}=(0x[0-9a-f]+)`, "m"));
  if (m) return m[1];
  const pk = generatePrivateKey();
  fs.appendFileSync(".env", `${name}=${pk}\n`);
  return pk;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

// Studionet sometimes answers with an HTML error page instead of JSON, and allows
// about 30 requests a minute: retry with a growing pause, and pace every call.
async function retry(label, fn, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      console.log(`  ${label} failed (${(e.shortMessage ?? e.message).slice(0, 120)}), retry ${i}`);
      await sleep(15_000 * i);
    }
  }
}
async function fund(addr) {
  await retry("fund", async () => {
    const res = await fetch(studionet.rpcUrls.default.http[0], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sim_fundAccount", params: [addr, Number(1000n * GEN)] }),
    });
    const body = JSON.parse(await res.text());
    if (body.error) throw new Error(JSON.stringify(body.error));
  });
}

const allocator = createAccount(key("DEMO_ALLOCATOR_PK"));
const manager = createAccount(key("DEMO_MANAGER_PK"));
const keeper = createAccount(key("DEMO_KEEPER_PK"));
const gl = createClient({ chain: studionet });

const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x)));
const read = (functionName, args) =>
  retry(`read ${functionName}`, async () =>
    plain(await gl.readContract({ address, functionName, args, transactionHashVariant: "latest-nonfinal" })));

// A write can come back ACCEPTED while the leader errored (validators agreed on the error),
// so keep the leader's execution result and the votes, not just the status, and retry
// when the leader's LLM call was rate limited.
async function write(account, functionName, args, value = 0n) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(6_000);
    const hash = await retry(`send ${functionName}`, () => gl.writeContract({ account, address, functionName, args, value }));
    const r = await retry(`receipt ${hash}`, () =>
      gl.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 150, interval: 8000 }));
    const leader = r?.consensus_data?.leader_receipt?.[0];
    const exec = leader?.execution_result;
    const err = leader?.genvm_result?.error_code;
    const votes = r?.last_round?.validator_votes_name ?? null;
    const payload = leader?.result?.payload;
    const msg = typeof payload === "string" ? payload : JSON.stringify(plain(payload ?? ""));
    console.log(`${functionName} -> ${hash} ${r?.status_name ?? ""} ${exec ?? ""} ${err ?? ""} ${votes ? votes.join(",") : ""}`);
    if (exec !== "ERROR" || err !== "LLM_RATE_LIMITED") {
      return { hash, status: r?.status_name, exec, error: err ?? null, votes,
               rotations_left: r?.last_round?.rotations_left ?? null, message: String(msg).slice(0, 800) };
    }
    await sleep(60_000 * attempt);
  }
  throw new Error(`${functionName} kept failing`);
}

const ts = (iso) => Math.floor(Date.parse(iso + ":00Z") / 1000);
// [label, account, from, to, mandate text]
const AUDITS = [
  ["sol-only", "0xfb8c34145bdea190693325d0ab01e81120909b3f", ts("2026-11-02T00:00"), ts("2026-11-09T00:00"),
    "솔라나만 거래하고 롱만 하기로 했습니다. 레버리지는 3배 이하로 유지."],
  ["crypto-only", "0x45552df9027f5cdacf3bc48b9cebd75d10583deb", ts("2026-11-02T00:00"), ts("2026-11-09T00:00"),
    "Crypto perps only. No stock or commodity perps. Long or short is fine."],
  ["no-shorts", "0xe65123c903700a65068f6a85c6f98519303bae41", ts("2026-11-04T00:00"), ts("2026-11-05T00:00"),
    "비트, 이더, 솔만. 숏은 금지."],
  ["no-shorts-next-day", "0xe65123c903700a65068f6a85c6f98519303bae41", ts("2026-11-05T00:00"), ts("2026-11-06T00:00"),
    "비트, 이더, 솔만. 숏은 금지."],
  ["drawdown", "0x7fdb5021d8e2d5ed85b7f66cb742d496af32259c", ts("2026-11-02T00:00"), ts("2026-11-09T00:00"),
    "Any coin except HYPE. Stop trading if realized losses reach $5,000 from the high."],
];

// the live mandates: an account that trades BTC/ETH around the clock
const LIVE_ACCOUNT = "0x418aa6bf98a2b2bc93779f810330d88cde488888";
const LIVE = [
  ["perps-no-stocks", "Hyperliquid crypto perps only, no stock or commodity perps, no spot.", 500],
  ["btc-eth-only", "BTC와 ETH만 거래. 다른 코인은 안 됨.", 500],
  ["cancelled", "BTC only, long only.", 500],
];

const resume = mode === "resume";
const out = resume ? JSON.parse(fs.readFileSync(OUT, "utf8"))
  : { contract: address, network: "studionet", created: now(), audits: [], mandates: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
if (!resume) for (const a of [allocator, manager, keeper]) await fund(a.address);

// 1) audits of real past windows
for (const [label, account, from, to, text] of AUDITS) {
  if (out.audits.some((a) => a.label === label && a.tx.exec === "SUCCESS")) continue;
  out.audits = out.audits.filter((a) => a.label !== label);
  const before = Number((await read("get_counts", [])).audits);
  const tx = await write(keeper, "audit", [account, from, to, text, ""]);
  const after = Number((await read("get_counts", [])).audits);
  const stored = after > before ? await read("get_audit", [after - 1]) : null;
  const report = await read("get_report", [account, from, to]);
  console.log(`  ${label}: net ${report.net_pnl ?? "-"} breaches ${JSON.stringify(stored?.breaches ?? tx.message).slice(0, 300)}`);
  out.audits.push({ label, account, from, to, text, tx, stored, report });
  save();
}

// 2) mandates for the next whole hour
if (!out.mandates.length) {
  const start = Math.ceil((now() + 1200) / HOUR) * HOUR;
  out.start = start;
  out.end = start + HOUR;
  for (const [label, text, target] of LIVE) {
    const id = Number((await read("get_counts", [])).mandates);
    const tx = await write(allocator, "propose",
      [LIVE_ACCOUNT, manager.address, text, "", start, start + HOUR, target, 5n * GEN], 10n * GEN);
    out.mandates.push({ label, id, text, target, propose: tx });
    save();
  }
}
for (const m of out.mandates) {
  if (!m.state) { m.state = await read("get_mandate", [m.id]); save(); }
  console.log(`  ${m.label}: ${JSON.stringify(m.state.rules)} ${m.state.rules_hash}`);
}
for (const m of out.mandates.filter((x) => x.label !== "cancelled")) {
  if (!m.accept) { m.accept = await write(manager, "accept", [m.id, m.state.rules_hash], 5n * GEN); save(); }
}
const c = out.mandates.find((x) => x.label === "cancelled");
if (!c.cancel) { c.cancel = await write(allocator, "cancel", [c.id]); save(); }

// 3) settle after the hour
const due = out.end + 660;
for (const m of out.mandates.filter((x) => x.label !== "cancelled")) {
  if (m.settle && m.settle.exec === "SUCCESS") continue;
  if (now() < due) { console.log(`waiting ${due - now()} s for the window to end`); await sleep((due - now()) * 1000); }
  m.settle = await write(keeper, "settle", [m.id]);
  m.result = await read("get_result", [m.id]);
  m.final = await read("get_mandate", [m.id]);
  console.log(`  ${m.label}: ${JSON.stringify(m.result).slice(0, 400)}`);
  save();
}
out.live_report = await read("get_report", [LIVE_ACCOUNT, out.start, out.end]);
c.final = await read("get_mandate", [c.id]);
save();
console.log("done");
