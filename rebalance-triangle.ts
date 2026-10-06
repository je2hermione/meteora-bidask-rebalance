/**
 * rebalance-triangle.ts
 *
 * Use case: kamu masuk LP Meteora DLMM dengan style bid-ask (segitiga).
 *
 *  DIRECTION=ask  (price turun mendekati batas BAWAH range):
 *    1. Withdraw 100% liquidity yang ada DI ATAS active bin
 *       (activeBin+1 s/d upperBinId posisi).
 *    2. Deposit kembali X sebagai segitiga bid-ask yang DIMULAI dari price
 *       sekarang (weight kecil di dekat price, membesar ke batas atas).
 *
 *  DIRECTION=bid  (price naik mendekati batas ATAS range):
 *    1. Withdraw 100% liquidity yang ada DI BAWAH active bin
 *       (lowerBinId posisi s/d activeBin-1).
 *    2. Deposit kembali Y sebagai segitiga bid-ask yang DIMULAI dari price
 *       sekarang (weight kecil di dekat price, membesar ke batas bawah).
 *
 * Sisi yang berlawanan TIDAK disentuh. Posisi tetap dibuka.
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
} from "@solana/web3.js";
import DLMM, { calculateBidAskDistribution } from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT, getAssociatedTokenAddress } from "@solana/spl-token";
import * as fs from "fs";
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

// ---------------------------------------------------------------- main

async function main() {
  const user = loadKeypair(CFG.walletPath);
  const connection = new Connection(CFG.rpcUrl, "confirmed");
  const poolKey = new PublicKey(CFG.pool);
  const dir = CFG.direction;
  const isAsk = dir === "ask";

  console.log("=== Meteora DLMM — rebalance segitiga ===");
  console.log(`Arah   : ${isAsk ? "ASK (rapikan sisi atas, price turun)" : "BID (rapikan sisi bawah, price naik)"}`);
  console.log(`Wallet : ${user.publicKey.toBase58()}`);
  console.log(`Pool   : ${poolKey.toBase58()}`);
  console.log(`Mode   : ${CFG.dryRun ? "DRY RUN (tidak kirim tx)" : "LIVE"}\n`);

  const dlmm = await DLMM.create(connection, poolKey);

  // token yang di-withdraw & di-deposit ulang: ask -> X, bid -> Y
  const depMint = isAsk ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey;
  const depDecimals = isAsk ? dlmm.tokenX.mint.decimals : dlmm.tokenY.mint.decimals;
  const depSymbol = isAsk ? "X" : "Y";
  const isDepSol = depMint.equals(NATIVE_MINT);

  const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(
    user.publicKey
  );
  if (userPositions.length === 0) {
    console.log("❌ Wallet ini tidak punya posisi di pool tersebut.");
    return;
  }

  // pilih posisi
  let pos = CFG.positionAddress
    ? userPositions.find((p) => p.publicKey.toBase58() === CFG.positionAddress)
    : userPositions.find(
        (p) =>
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
    return;
  }
  const posData = pos.positionData;
  console.log(`Position: ${pos.publicKey.toBase58()}`);
  console.log(`  range posisi : [${posData.lowerBinId} .. ${posData.upperBinId}]`);
  console.log(`  active bin   : ${activeBin.binId}  (price ${activeBin.price})\n`);

  // range withdraw & segitiga, tergantung arah
  const startBin = isAsk ? activeBin.binId + 1 : (CFG.lowerBin ?? posData.lowerBinId);
  const endBin = isAsk ? (CFG.upperBin ?? posData.upperBinId) : activeBin.binId - 1;
  if (startBin > endBin) {
    console.log(
      isAsk
        ? "ℹ️  Tidak ada bin di atas price (price sudah di/past batas atas). Tidak ada yang dikerjakan."
        : "ℹ️  Tidak ada bin di bawah price (price sudah di/past batas bawah). Tidak ada yang dikerjakan."
    );
    return;
  }

  // estimasi token yang ada di range tersebut (dari data posisi on-chain)
  let estAmt = new BN(0);
  let binsWithLiq = 0;
  for (const b of posData.positionBinData) {
    if (b.binId >= startBin && b.binId <= endBin && b.positionLiquidity !== "0") {
      estAmt = estAmt.add(new BN(isAsk ? b.positionXAmount : b.positionYAmount));
      binsWithLiq++;
    }
  }
  console.log(
    `Withdraw range: bin [${startBin} .. ${endBin}]  (${endBin - startBin + 1} bins, ${binsWithLiq} berisi liquidity)`
  );
  console.log(`Estimasi ${depSymbol} yang akan ditarik: ${fmtAmount(estAmt, depDecimals)}\n`);

  if (estAmt.isZero()) {
    console.log(
      `ℹ️  Tidak ada liquidity di ${isAsk ? "atas" : "bawah"} price. Tidak ada yang dikerjakan.`
    );
    return;
  }

  // bentuk segitiga bid-ask satu sisi: weight kecil di dekat price, membesar ke batas range
  const binIds = range(startBin, endBin);
  const dist = calculateBidAskDistribution(activeBin.binId, binIds);
  const w = dist.map((d) =>
    (isAsk ? d.xAmountBpsOfTotal : d.yAmountBpsOfTotal).toNumber()
  );
  console.log("Bentuk segitiga (weight bps per bin):");
  if (isAsk) {
    console.log(
      `  dekat price → ${w.slice(0, 3).join(", ")} ... ${w.slice(-3).join(", ")} ← batas atas`
    );
  } else {
    console.log(
      `  batas bawah → ${w.slice(0, 3).join(", ")} ... ${w.slice(-3).join(", ")} ← dekat price`
    );
  }
  console.log(
    `  (naik monoton menjauhi price = segitiga bid-ask sisi ${dir})\n`
  );

  if (CFG.dryRun) {
    console.log(
      "🔍 DRY RUN selesai — tidak ada transaksi yang dikirim.\n" +
        'Set DRY_RUN="false" untuk eksekusi beneran.'
    );
    return;
  }

  const confirm = await ask('Ketik "REBALANCE" untuk lanjut withdraw + re-deposit: ');
  if (confirm !== "REBALANCE") {
    console.log("Dibatalkan.");
    return;
  }

  // snapshot saldo token deposit (untuk hitung jumlah aktual yang diterima)
  const depBalance = async (): Promise<BN> => {
    if (isDepSol) {
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
    const ata = await getAssociatedTokenAddress(depMint, user.publicKey);
    try {
      const acc = await connection.getTokenAccountBalance(ata);
      return new BN(acc.value.amount);
    } catch {
      return new BN(0);
    }
  };

  // ---- fase 1: withdraw semua liquidity di range
  console.log(`\n[Fase 1] Withdraw liquidity di ${isAsk ? "atas" : "bawah"} price...`);
  const balBefore = await depBalance();
  const removeTxs = await dlmm.removeLiquidity({
    user: user.publicKey,
    position: pos.publicKey,
    fromBinId: startBin,
    toBinId: endBin,
    bps: new BN(10_000), // 100%
    shouldClaimAndClose: false, // posisi tetap dibuka, sisi lain tidak disentuh
  });
  await sendTxs(connection, user, removeTxs, "withdraw");
  const balAfter = await depBalance();
  const received = balAfter.sub(balBefore);
  console.log(
    `  ${depSymbol} diterima: ${fmtAmount(received, depDecimals)} (estimasi ${fmtAmount(estAmt, depDecimals)})`
  );

  // refresh state — active bin bisa bergeser di antara fase
  await dlmm.refetchStates();
  const freshActive = (await dlmm.getActiveBin()).binId;
  const startBin2 = isAsk ? freshActive + 1 : startBin;
  const endBin2 = isAsk ? endBin : freshActive - 1;
  if (startBin2 > endBin2) {
    console.log(
      "⚠️  Price bergerak melewati batas range saat withdraw. " +
        `Token tetap di wallet — tidak ada re-deposit yang dilakukan.`
    );
    return;
  }
  if (freshActive !== activeBin.binId) {
    console.log(
      `  ℹ️  Active bin bergeser ${activeBin.binId} → ${freshActive}, segitiga disesuaikan.`
    );
  }

  // ---- fase 2: re-deposit sebagai segitiga dari price ke batas range
  console.log(`\n[Fase 2] Re-deposit sebagai segitiga bid-ask (sisi ${dir})...`);
  const FEE_BUFFER = isDepSol ? new BN(5_000_000) : new BN(0); // 0.005 SOL buat fee
  let depositAmt = BN.min(estAmt, received);
  if (isDepSol) depositAmt = depositAmt.sub(FEE_BUFFER);
  if (depositAmt.lte(new BN(0))) {
    console.log("❌ Jumlah token tidak cukup setelah buffer fee. Token tetap di wallet.");
    return;
  }
  console.log(`  Deposit ${depSymbol}: ${fmtAmount(depositAmt, depDecimals)}`);

  const binIds2 = range(startBin2, endBin2);
  const dist2 = calculateBidAskDistribution(freshActive, binIds2);
  const addRes = await dlmm.addLiquidityByWeight({
    positionPubKey: pos.publicKey,
    totalXAmount: isAsk ? depositAmt : new BN(0),
    totalYAmount: isAsk ? new BN(0) : depositAmt,
    xYAmountDistribution: dist2,
    user: user.publicKey,
    slippage: CFG.slippagePct,
  });
  const addTxs = Array.isArray(addRes) ? addRes : [addRes];
  await sendTxs(connection, user, addTxs, "deposit");

  console.log("\n✅ Selesai. Sisi posisi sekarang berbentuk segitiga bid-ask");
  console.log(
    `   dari bin ${isAsk ? startBin2 : endBin2} (price sekarang) s/d bin ${isAsk ? endBin : startBin2} (batas ${isAsk ? "atas" : "bawah"}).`
  );
  console.log(`   Sisi ${isAsk ? "bawah" : "atas"} posisi tidak diubah.`);
}

main().catch((e) => {
  console.error("❌ Error:", e?.message ?? e);
  process.exit(1);
});
