/**
 * rebalance-triangle.ts
 *
 * Use case: kamu masuk LP Meteora DLMM dengan style bid-ask (segitiga).
 *
 *  DIRECTION=ask  (price turun mendekati batas BAWAH range):
 *    Withdraw 100% liquidity DI ATAS active bin, deposit kembali X sebagai
 *    segitiga bid-ask dari price sekarang ke batas atas.
 *
 *  DIRECTION=bid  (price naik mendekati batas ATAS range):
 *    Withdraw 100% liquidity DI BAWAH active bin, deposit kembali Y sebagai
 *    segitiga bid-ask dari price sekarang ke batas bawah.
 *
 * Sisi yang berlawanan TIDAK disentuh. Posisi tetap dibuka.
 *
 * MODE ATOMIC (default): withdraw + re-deposit digabung jadi SATU transaksi,
 * sehingga price tidak mungkin berubah di antara keduanya. Jumlah deposit
 * dihitung dari estimasi on-chain dikurangi buffer (ATOMIC_BUFFER_PCT),
 * karena di dalam 1 tx tidak bisa baca saldo hasil withdraw dulu.
 * Kalau gabungan instruksi tidak muat dalam 1 tx (batas 1232 bytes / 1.4M CU),
 * otomatis fallback ke mode 2 fase.
 *
 * Cara pakai:
 *   export RPC_URL="https://..."           # Helius / QuickNode disarankan
 *   export POOL_ADDRESS="<dlmm pool>"
 *   export WALLET_PATH="$HOME/.config/solana/id.json"
 *   export DIRECTION="ask"                 # "ask" | "bid"  (default "ask")
 *   # opsional:
 *   export POSITION_ADDRESS="<position>"   # default: posisi yg memuat active bin
 *   export UPPER_BIN="12345"               # batas segitiga arah ask (default: upperBinId posisi)
 *   export LOWER_BIN="12300"               # batas segitiga arah bid (default: lowerBinId posisi)
 *   export SLIPPAGE_PCT="1"                # default 1 (%)
 *   export PRIORITY_FEE_MICROLAMPORTS="0"  # default 0 (tidak pakai)
 *   export ATOMIC="true"                   # default true; "false" = selalu 2 fase
 *   export ATOMIC_BUFFER_PCT="0.5"         # buffer estimasi deposit mode atomic (%)
 *   export DRY_RUN="true"                  # default true — hanya simulasi
 *
 *   npx tsx rebalance-triangle.ts
 *
 * Set DRY_RUN="false" untuk eksekusi beneran (ada prompt konfirmasi).
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import DLMM, {
  calculateBidAskDistribution,
  getEstimatedComputeUnitUsageWithBuffer,
} from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT, getAssociatedTokenAddress } from "@solana/spl-token";import * as fs from "fs";
import * as os from "os";
import * as readline from "readline";

// ---------------------------------------------------------------- config

type Direction = "ask" | "bid";

const CFG = {
  rpcUrl: must("RPC_URL"),
  pool: must("POOL_ADDRESS"),
  walletPath: process.env.WALLET_PATH ?? `${os.homedir()}/.config/solana/id.json`,
  direction: ((process.env.DIRECTION ?? "ask").toLowerCase() === "bid"
    ? "bid"
    : "ask") as Direction,
  positionAddress: process.env.POSITION_ADDRESS ?? "",
  upperBin: process.env.UPPER_BIN ? parseInt(process.env.UPPER_BIN, 10) : null,
  lowerBin: process.env.LOWER_BIN ? parseInt(process.env.LOWER_BIN, 10) : null,
  slippagePct: process.env.SLIPPAGE_PCT ? parseFloat(process.env.SLIPPAGE_PCT) : 1,
  priorityFee: process.env.PRIORITY_FEE_MICROLAMPORTS
    ? parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS, 10)
    : 0,
  atomic: (process.env.ATOMIC ?? "true").toLowerCase() !== "false",
  atomicBufferPct: process.env.ATOMIC_BUFFER_PCT
    ? parseFloat(process.env.ATOMIC_BUFFER_PCT)
    : 0.5,
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Env ${name} belum di-set.`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------- helpers

const MAX_TX_BYTES = 1232;
const MAX_CU = 1_400_000;
const SOL_FEE_BUFFER = new BN(5_000_000); // 0.005 SOL

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path.replace(/^~/, os.homedir()), "utf-8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

function fmtAmount(raw: BN, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

async function sendTxs(
  connection: Connection,
  user: Keypair,
  txs: Transaction[],
  label: string
) {
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    tx.feePayer = user.publicKey;
    if (CFG.priorityFee > 0) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: CFG.priorityFee,
        })
      );
    }
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    const sig = await connection.sendTransaction(tx, [user], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
    console.log(
      `  [${label} ${i + 1}/${txs.length}] ✅ ${sig}\n      https://solscan.io/tx/${sig}`
    );
  }
}

// ---------------------------------------------------------------- plan

interface Plan {
  pos: any;
  posData: any;
  activeBinId: number;
  activeBinPrice: string;
  startBin: number;
  endBin: number;
  estAmt: BN;
  binsWithLiq: number;
  binIds: number[];
  dist: { binId: number; xAmountBpsOfTotal: BN; yAmountBpsOfTotal: BN }[];
  depSymbol: string;
  depDecimals: number;
  depMint: PublicKey;
  isDepSol: boolean;
  isAsk: boolean;
}

async function loadPlan(dlmm: any, user: Keypair): Promise<Plan | null> {
  const isAsk = CFG.direction === "ask";
  const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(
    user.publicKey
  );
  if (userPositions.length === 0) {
    console.log("❌ Wallet ini tidak punya posisi di pool tersebut.");
    return null;
  }

  const pos = CFG.positionAddress
    ? userPositions.find((p: any) => p.publicKey.toBase58() === CFG.positionAddress)
    : userPositions.find(
        (p: any) =>
          p.positionData.lowerBinId <= activeBin.binId &&
          activeBin.binId <= p.positionData.upperBinId
      );
  if (!pos) {
    console.log("❌ Posisi tidak ketemu. Posisi yang ada:");
    for (const p of userPositions) {
      console.log(
        `  - ${p.publicKey.toBase58()}  [${p.positionData.lowerBinId} .. ${p.positionData.upperBinId}]`
      );
    }
    return null;
  }
  const posData = pos.positionData;

  const startBin = isAsk ? activeBin.binId + 1 : (CFG.lowerBin ?? posData.lowerBinId);
  const endBin = isAsk ? (CFG.upperBin ?? posData.upperBinId) : activeBin.binId - 1;
  if (startBin > endBin) {
    console.log(
      isAsk
        ? "ℹ️  Tidak ada bin di atas price (price sudah di/past batas atas). Tidak ada yang dikerjakan."
        : "ℹ️  Tidak ada bin di bawah price (price sudah di/past batas bawah). Tidak ada yang dikerjakan."
    );
    return null;
  }

  let estAmt = new BN(0);
  let binsWithLiq = 0;
  for (const b of posData.positionBinData) {
    if (b.binId >= startBin && b.binId <= endBin && b.positionLiquidity !== "0") {
      estAmt = estAmt.add(new BN(isAsk ? b.positionXAmount : b.positionYAmount));
      binsWithLiq++;
    }
  }
  if (estAmt.isZero()) {
    console.log(
      `ℹ️  Tidak ada liquidity di ${isAsk ? "atas" : "bawah"} price. Tidak ada yang dikerjakan.`
    );
    return null;
  }

  const binIds = range(startBin, endBin);
  const dist = calculateBidAskDistribution(activeBin.binId, binIds);
  const depMint: PublicKey = isAsk ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey;

  return {
    pos,
    posData,
    activeBinId: activeBin.binId,
    activeBinPrice: activeBin.price,
    startBin,
    endBin,
    estAmt,
    binsWithLiq,
    binIds,
    dist,
    depSymbol: isAsk ? "X" : "Y",
    depDecimals: isAsk ? dlmm.tokenX.mint.decimals : dlmm.tokenY.mint.decimals,
    depMint,
    isDepSol: depMint.equals(NATIVE_MINT),
    isAsk,
  };
}

function printPlan(plan: Plan) {
  const w = plan.dist.map((d) =>
    (plan.isAsk ? d.xAmountBpsOfTotal : d.yAmountBpsOfTotal).toNumber()
  );
  console.log(`Position: ${plan.pos.publicKey.toBase58()}`);
  console.log(
    `  range posisi : [${plan.posData.lowerBinId} .. ${plan.posData.upperBinId}]`
  );
  console.log(`  active bin   : ${plan.activeBinId}  (price ${plan.activeBinPrice})\n`);
  console.log(
    `Withdraw range: bin [${plan.startBin} .. ${plan.endBin}]  (${plan.endBin - plan.startBin + 1} bins, ${plan.binsWithLiq} berisi liquidity)`
  );
  console.log(
    `Estimasi ${plan.depSymbol} yang akan ditarik: ${fmtAmount(plan.estAmt, plan.depDecimals)}\n`
  );
  console.log("Bentuk segitiga (weight bps per bin):");
  if (plan.isAsk) {
    console.log(
      `  dekat price → ${w.slice(0, 3).join(", ")} ... ${w.slice(-3).join(", ")} ← batas atas`
    );
  } else {
    console.log(
      `  batas bawah → ${w.slice(0, 3).join(", ")} ... ${w.slice(-3).join(", ")} ← dekat price`
    );
  }
  console.log(`  (naik monoton menjauhi price = segitiga bid-ask sisi ${CFG.direction})\n`);
}

// ---------------------------------------------------------------- atomic

interface AtomicResult {
  ok: boolean;
  tx?: Transaction;
  size?: number;
  cu?: number;
  depositAmt?: BN;
  reason?: string;
}

/**
 * Coba gabungkan withdraw + re-deposit jadi SATU transaksi atomic.
 * Return {ok:false} kalau tidak muat (caller fallback ke 2 fase).
 */
async function tryBuildAtomicTx(
  connection: Connection,
  user: Keypair,
  dlmm: any,
  plan: Plan
): Promise<AtomicResult> {
  // jumlah deposit = estimasi on-chain dikurangi buffer (di 1 tx tidak bisa
  // baca saldo hasil withdraw dulu; buffer menutup selisih rounding/swap kecil)
  const bufferBps = Math.round(CFG.atomicBufferPct * 100);
  let depositAmt = plan.estAmt.muln(10000 - bufferBps).divn(10000);
  if (plan.isDepSol) depositAmt = depositAmt.sub(SOL_FEE_BUFFER);
  if (depositAmt.lten(0)) {
    return { ok: false, reason: "jumlah deposit <= 0 setelah buffer" };
  }

  const removeTxs = await dlmm.removeLiquidity({
    user: user.publicKey,
    position: plan.pos.publicKey,
    fromBinId: plan.startBin,
    toBinId: plan.endBin,
    bps: new BN(10_000),
    shouldClaimAndClose: false,
  });

  const addRes = await dlmm.addLiquidityByWeight({
    positionPubKey: plan.pos.publicKey,
    totalXAmount: plan.isAsk ? depositAmt : new BN(0),
    totalYAmount: plan.isAsk ? new BN(0) : depositAmt,
    xYAmountDistribution: plan.dist,
    user: user.publicKey,
    slippage: CFG.slippagePct,
  });
  const addTxs: Transaction[] = Array.isArray(addRes) ? addRes : [addRes];

  // gabungkan semua instruksi: withdraw dulu, baru deposit
  let ixs: TransactionInstruction[] = [];
  for (const t of [...removeTxs, ...addTxs]) ixs.push(...t.instructions);

  // buang compute-budget bawaan SDK (nanti diganti hasil simulasi gabungan).
  // NB: semua instruksi lain dipertahankan apa adanya — termasuk create-ATA
  // yang duplikat (idempotent, aman) dan urutan close/re-create wSOL ATA,
  // karena wrapSOLInstruction butuh ATA-nya sudah ada.
  const CU_PROG = ComputeBudgetProgram.programId;
  ixs = ixs.filter((ix) => !ix.programId.equals(CU_PROG));

  // simulasi kebutuhan compute unit untuk gabungan instruksi
  let cu: number;
  try {
    cu = await getEstimatedComputeUnitUsageWithBuffer(connection, ixs, user.publicKey);
  } catch (e: any) {
    return { ok: false, reason: `simulasi CU gagal: ${e?.message ?? e}` };
  }
  if (cu >= MAX_CU) {
    return { ok: false, reason: `butuh ~${cu} CU, melebihi batas 1.4M per tx` };
  }

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  if (CFG.priorityFee > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CFG.priorityFee }));
  }
  tx.add(...ixs);
  tx.feePayer = user.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  if (size > MAX_TX_BYTES) {
    return { ok: false, reason: `ukuran tx ${size} bytes > batas ${MAX_TX_BYTES}` };
  }
  return { ok: true, tx, size, cu, depositAmt };
}

// ---------------------------------------------------------------- 2 fase (fallback)

async function runTwoPhase(
  connection: Connection,
  user: Keypair,
  dlmm: any,
  plan: Plan
) {
  const depBalance = async (): Promise<BN> => {
    if (plan.isDepSol) {
      const native = new BN((await connection.getBalance(user.publicKey)).toString());
      const ata = await getAssociatedTokenAddress(NATIVE_MINT, user.publicKey);
      let wsol = new BN(0);
      try {
        const acc = await connection.getTokenAccountBalance(ata);
        wsol = new BN(acc.value.amount);
      } catch {
        /* ATA tidak ada */
      }
      return native.add(wsol);
    }
    const ata = await getAssociatedTokenAddress(plan.depMint, user.publicKey);
    try {
      const acc = await connection.getTokenAccountBalance(ata);
      return new BN(acc.value.amount);
    } catch {
      return new BN(0);
    }
  };

  console.log(`\n[Fase 1] Withdraw liquidity di ${plan.isAsk ? "atas" : "bawah"} price...`);
  const balBefore = await depBalance();
  const removeTxs = await dlmm.removeLiquidity({
    user: user.publicKey,
    position: plan.pos.publicKey,
    fromBinId: plan.startBin,
    toBinId: plan.endBin,
    bps: new BN(10_000),
    shouldClaimAndClose: false,
  });
  await sendTxs(connection, user, removeTxs, "withdraw");
  const received = (await depBalance()).sub(balBefore);
  console.log(
    `  ${plan.depSymbol} diterima: ${fmtAmount(received, plan.depDecimals)} (estimasi ${fmtAmount(plan.estAmt, plan.depDecimals)})`
  );

  await dlmm.refetchStates();
  const freshActive = (await dlmm.getActiveBin()).binId;
  const startBin2 = plan.isAsk ? freshActive + 1 : plan.startBin;
  const endBin2 = plan.isAsk ? plan.endBin : freshActive - 1;
  if (startBin2 > endBin2) {
    console.log(
      "⚠️  Price bergerak melewati batas range saat withdraw. " +
        "Token tetap di wallet — tidak ada re-deposit yang dilakukan."
    );
    return;
  }
  if (freshActive !== plan.activeBinId) {
    console.log(`  ℹ️  Active bin bergeser ${plan.activeBinId} → ${freshActive}, segitiga disesuaikan.`);
  }

  console.log(`\n[Fase 2] Re-deposit sebagai segitiga bid-ask (sisi ${CFG.direction})...`);
  let depositAmt2 = BN.min(plan.estAmt, received);
  if (plan.isDepSol) depositAmt2 = depositAmt2.sub(SOL_FEE_BUFFER);
  if (depositAmt2.lten(0)) {
    console.log("❌ Jumlah token tidak cukup setelah buffer fee. Token tetap di wallet.");
    return;
  }
  console.log(`  Deposit ${plan.depSymbol}: ${fmtAmount(depositAmt2, plan.depDecimals)}`);

  const binIds2 = range(startBin2, endBin2);
  const dist2 = calculateBidAskDistribution(freshActive, binIds2);
  const addRes = await dlmm.addLiquidityByWeight({
    positionPubKey: plan.pos.publicKey,
    totalXAmount: plan.isAsk ? depositAmt2 : new BN(0),
    totalYAmount: plan.isAsk ? new BN(0) : depositAmt2,
    xYAmountDistribution: dist2,
    user: user.publicKey,
    slippage: CFG.slippagePct,
  });
  await sendTxs(connection, user, Array.isArray(addRes) ? addRes : [addRes], "deposit");

  console.log("\n✅ Selesai (2 fase).");
  printDone(plan, startBin2, endBin2);
}

function printDone(plan: Plan, startBin: number, endBin: number) {
  console.log("   Sisi posisi sekarang berbentuk segitiga bid-ask");
  console.log(
    `   dari bin ${plan.isAsk ? startBin : endBin} (price) s/d bin ${plan.isAsk ? endBin : startBin} (batas ${plan.isAsk ? "atas" : "bawah"}).`
  );
  console.log(`   Sisi ${plan.isAsk ? "bawah" : "atas"} posisi tidak diubah.`);
}

// ---------------------------------------------------------------- main

async function main() {
  const user = loadKeypair(CFG.walletPath);
  const connection = new Connection(CFG.rpcUrl, "confirmed");
  const poolKey = new PublicKey(CFG.pool);

  console.log("=== Meteora DLMM — rebalance segitiga ===");
  console.log(
    `Arah   : ${CFG.direction === "ask" ? "ASK (rapikan sisi atas, price turun)" : "BID (rapikan sisi bawah, price naik)"}`
  );
  console.log(`Wallet : ${user.publicKey.toBase58()}`);
  console.log(`Pool   : ${poolKey.toBase58()}`);
  console.log(`Mode   : ${CFG.dryRun ? "DRY RUN (tidak kirim tx)" : "LIVE"} | ${CFG.atomic ? "ATOMIC (fallback 2 fase)" : "2 FASE"}\n`);

  const dlmm = await DLMM.create(connection, poolKey);
  const plan = await loadPlan(dlmm, user);
  if (!plan) return;
  printPlan(plan);

  // ---- dry run: sekalian cek kelayakan atomic
  if (CFG.dryRun) {
    if (CFG.atomic) {
      console.log("🔍 Cek kelayakan atomic...");
      const r = await tryBuildAtomicTx(connection, user, dlmm, plan);
      if (r.ok) {
        console.log(
          `   ✅ Atomic BISA: 1 tx, ${r.size} bytes, ~${r.cu} CU, deposit ${fmtAmount(r.depositAmt!, plan.depDecimals)} ${plan.depSymbol} (buffer ${CFG.atomicBufferPct}%)`
        );
      } else {
        console.log(`   ⚠️  Atomic TIDAK bisa (${r.reason}) → akan fallback ke 2 fase.`);
      }
    }
    console.log(
      '\n🔍 DRY RUN selesai — tidak ada transaksi yang dikirim.\nSet DRY_RUN="false" untuk eksekusi beneran.'
    );
    return;
  }

  const confirm = await ask('Ketik "REBALANCE" untuk lanjut: ');
  if (confirm !== "REBALANCE") {
    console.log("Dibatalkan.");
    return;
  }

  // state fresh setelah konfirmasi (user bisa jeda lama sebelum ketik)
  const dlmm2 = await DLMM.create(connection, poolKey);
  const plan2 = await loadPlan(dlmm2, user);
  if (!plan2) return;

  if (CFG.atomic) {
    console.log("\n[Atomic] Menggabungkan withdraw + deposit jadi 1 tx...");
    const r = await tryBuildAtomicTx(connection, user, dlmm2, plan2);
    if (r.ok) {
      console.log(
        `  1 tx atomic: ${r.size} bytes, ~${r.cu} CU, deposit ${fmtAmount(r.depositAmt!, plan2.depDecimals)} ${plan2.depSymbol}`
      );
      await sendTxs(connection, user, [r.tx!], "atomic");
      console.log("\n✅ Selesai (atomic, 1 tx).");
      printDone(plan2, plan2.startBin, plan2.endBin);
      return;
    }
    console.log(`  ⚠️  Atomic tidak bisa (${r.reason}) → fallback ke 2 fase.`);
  }

  await runTwoPhase(connection, user, dlmm2, plan2);
}

main().catch((e) => {
  console.error("❌ Error:", e?.message ?? e);
  process.exit(1);
});
