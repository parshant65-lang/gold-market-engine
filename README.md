# Gold Market Engine 🏆

Dedicated autonomous 24×7 cloud scraper engine engineered for institutional-grade **Gold & Precious Metals** intelligence.

## 🏛️ Decoupled Architecture

| Role | Repository | Visibility | Quota / Minutes |
| :--- | :--- | :--- | :--- |
| **Engine Runner** | [`parshant65-lang/gold-market-engine`](https://github.com/parshant65-lang/gold-market-engine) | **Public** | **100% Free & Unlimited** |
| **Data Vault** | [`parshant65-lang/gold-data-vault`](https://github.com/parshant65-lang/gold-data-vault) | **Private** | **0% Actions Quota Used** |

## 🌐 Connected Sources

1. **Kitco News** (Global Gold Benchmark: central banks, spot prices, macroeconomic analysis)
2. **BullionVault** (Physical Bullion demand, LBMA London gold index)
3. **The Economic Times (Gold Hub)** (Domestic Indian bullion rates, MCX contracts, festive demand)
4. **Business Standard (Commodities & Gold)** (Technical analysis, price resistance/support, ETF flows)
5. **GoodReturns (India Gold Rates)** (Live daily 24K and 22K prices per 10g/100g across Indian cities)

## 📁 Storage Hierarchy in Vault

All extracted intelligence is organized chronologically in [`parshant65-lang/gold-data-vault`](https://github.com/parshant65-lang/gold-data-vault):
```text
Data/
├── Kitco_News/YYYY/MM/DD.json
├── BullionVault/YYYY/MM/DD.json
├── Economic_Times_Gold/YYYY/MM/DD.json
├── Business_Standard_Gold/YYYY/MM/DD.json
└── GoodReturns_Gold/YYYY/MM/DD.json
```

## ⚡ Autonomous 24×7 Handover Relay

- Continuous execution with 5.5-hour relays.
- Handover trigger dispatches next GitHub Actions workflow before termination.
- 15-minute periodic push to private storage vault.
- Zero local PC hardware, memory, or disk usage (100% cloud executed).
