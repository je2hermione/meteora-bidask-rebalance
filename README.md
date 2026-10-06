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
| `ATOMIC` | — | `true` | `true` = coba gabung withdraw+deposit jadi 1 tx atomic (fallback otomatis ke 2 fase kalau tidak muat); `false` = selalu 2 fase |
| `ATOMIC_BUFFER_PCT` | — | `0.5` | Buffer estimasi jumlah deposit di mode atomic (%) — menutup selisih rounding/swap kecil antara baca state & eksekusi |
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

**Mode atomic (default):** instruksi withdraw + re-deposit digabung menjadi
**satu transaksi** — price tidak mungkin berubah di antaranya, dan tidak ada
status setengah jalan (gagal = semua batal, dana aman). Jumlah deposit dihitung
dari estimasi on-chain dikurangi buffer `ATOMIC_BUFFER_PCT` (default 0.5%),
karena dalam 1 tx tidak bisa membaca saldo hasil withdraw dulu; sisa dust
kecil tertinggal di wallet.

Atomic hanya dipakai kalau gabungan instruksi muat dalam batas Solana
(1232 bytes / 1.4M CU) — dicek otomatis via simulasi + ukur ukuran tx.
Untuk range besar (>~20 bins), otomatis **fallback ke mode 2 fase**:

1. **Fase 1 — withdraw:** hapus semua liquidity di range sisi yang dipilih.
   Posisi tetap dibuka (`shouldClaimAndClose: false`).
2. **Refresh state** — kalau price bergeser di antara fase, segitiga dihitung ulang
   dari active bin yang baru. Kalau price malah bergerak melewati batas range,
   script berhenti dan token tetap di wallet.
3. **Fase 2 — deposit:** token yang ditarik (diukur dari saldo aktual yang
   diterima) dipasang kembali sebagai segitiga bid-ask satu sisi
   (pakai helper resmi SDK `calculateBidAskDistribution`), dalam posisi yang sama.

Jumlah yang di-deposit (2 fase) = min(estimasi dari data posisi on-chain, token
yang benar-benar diterima), dikurangi buffer fee 0.005 SOL kalau token deposit
adalah SOL. Mode atomic selalu ditawarkan dulu; dry-run melaporkan jalur mana
yang akan dipakai beserta ukuran tx & estimasi CU.

## Catatan

- Setiap fase mengirim 1+ transaksi — siapkan SOL untuk fee.
- Kalau token deposit adalah SOL, withdraw otomatis unwrap wSOL → SOL, lalu
  deposit wrap lagi.
- Selalu jalankan `DRY_RUN` dulu setiap mau pakai — kondisi on-chain berubah terus.
