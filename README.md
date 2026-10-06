# Meteora DLMM — Rebalance Segitiga (ask & bid)

Script untuk skenario: kamu masuk LP Meteora DLMM dengan style **bid-ask (segitiga)**,
lalu price bergerak mendekati salah satu batas range.

- `DIRECTION=ask` — **price turun** mendekati batas bawah:
  withdraw 100% liquidity **di atas** price (`activeBin+1 .. upperBinId`),
  deposit kembali **X** sebagai segitiga yang dimulai dari price sekarang
  (weight kecil di dekat price, membesar ke batas atas).
- `DIRECTION=bid` — **price naik** mendekati batas atas:
  withdraw 100% liquidity **di bawah** price (`lowerBinId .. activeBin-1`),
  deposit kembali **Y** sebagai segitiga yang dimulai dari price sekarang
  (weight kecil di dekat price, membesar ke batas bawah).

Sisi yang berlawanan TIDAK disentuh. Posisi tetap dibuka (tidak di-close).

## Yang dibutuhkan

- Node.js 18+
- RPC Solana (Helius / QuickNode disarankan — RPC publik sering rate-limit)
- Keypair wallet dalam format JSON (punya LP di pool tersebut)
- Alamat DLMM pool

## Setup

```bash
cd meteora-lp-triangle
npm install
```

## Konfigurasi (env vars)

| Var | Wajib | Default | Keterangan |
|---|---|---|---|
| `RPC_URL` | ✅ | — | Endpoint RPC Solana |
| `POOL_ADDRESS` | ✅ | — | Alamat DLMM pool |
| `WALLET_PATH` | — | `~/.config/solana/id.json` | Path keypair |
| `DIRECTION` | — | `ask` | `ask` (price turun) atau `bid` (price naik) |
| `POSITION_ADDRESS` | — | otomatis | Posisi yang dipakai (default: posisi yang memuat active bin) |
| `UPPER_BIN` | — | `upperBinId` posisi | Batas segitiga arah `ask` |
| `LOWER_BIN` | — | `lowerBinId` posisi | Batas segitiga arah `bid` |
| `SLIPPAGE_PCT` | — | `1` | Toleransi slippage deposit (%) |
| `PRIORITY_FEE_MICROLAMPORTS` | — | `0` | Priority fee (microlamports) |
| `DRY_RUN` | — | `true` | `true` = simulasi saja, tidak kirim tx |

## Cara pakai

```bash
export RPC_URL="https://..."
export POOL_ADDRESS="<alamat pool>"

# --- price turun ke batas bawah: rapikan sisi atas ---
export DIRECTION="ask"
npx tsx rebalance-triangle.ts        # dry run dulu, cek rencana

export DRY_RUN="false"
npx tsx rebalance-triangle.ts        # eksekusi → ketik REBALANCE saat diminta

# --- price naik ke batas atas: rapikan sisi bawah ---
export DIRECTION="bid" DRY_RUN="true"
npx tsx rebalance-triangle.ts        # dry run dulu
```

## Alur eksekusi (mode live)

1. Baca posisi + active bin saat ini.
2. **Fase 1 — withdraw:** hapus semua liquidity di range sisi yang dipilih.
   Posisi tetap dibuka (`shouldClaimAndClose: false`).
3. **Refresh state** — kalau price bergeser di antara fase, segitiga dihitung ulang
   dari active bin yang baru. Kalau price malah bergerak melewati batas range,
   script berhenti dan token tetap di wallet.
4. **Fase 2 — deposit:** token yang ditarik dipasang kembali sebagai segitiga
   bid-ask satu sisi (pakai helper resmi SDK `calculateBidAskDistribution`),
   dalam posisi yang sama.

Jumlah yang di-deposit = min(estimasi dari data posisi on-chain, token yang
benar-benar diterima), dikurangi buffer fee 0.005 SOL kalau token deposit adalah SOL.

## Catatan

- Setiap fase mengirim 1+ transaksi — siapkan SOL untuk fee.
- Kalau token deposit adalah SOL, withdraw otomatis unwrap wSOL → SOL, lalu
  deposit wrap lagi.
- Selalu jalankan `DRY_RUN` dulu setiap mau pakai — kondisi on-chain berubah terus.
