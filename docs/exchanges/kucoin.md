# KuCoin Futures Adapter Reference

## Endpoints & Signing
- **REST Base URL**: `https://api-futures.kucoin.com` (Sandbox: `https://api-sandbox-futures.kucoin.com`)
- **Signing Scheme**: KuCoin v2 HMAC-SHA256 Base64 signature over `timestamp + method + endpoint + body` plus HMAC-SHA256 Base64 passphrase (`KC-API-KEY-VERSION: 2`).
- **Key Endpoints**:
  - `GET /api/v1/timestamp` - Server time synchronization
  - `GET /api/v1/contracts/active` - Contract `multiplier`, `lotSize`, `tickSize`, `maxLeverage`
  - `GET /api/v1/level2/depth20` - L2 order book snapshot
  - `POST /api/v1/orders` - Market, Limit IOC, Stop (`stop="down"|"up"`, `stopPriceType="MP"`), and Reduce-Only Limit orders

## Capabilities Matrix
| Capability | Supported | Notes |
|---|---|---|
| `trading` | `true` | KuCoin USDT-margined perpetual futures |
| `ioc` | `true` | `timeInForce="IOC"` |
| `attachedSlTp` | `false` | Placed immediately via `/api/v1/orders` with `stop` fields |
| `conditionalEndpoint` | `true` | Stop parameters on `/api/v1/orders` |
| `nativeTrail` | `false` | Uses Never-Unprotected `place-new-then-cancel-old` stop sequence |
| `atomicAmend` | `false` | Uses Never-Unprotected `place-new-then-cancel-old` stop sequence |
| `privateWs` | `true` | Bullet-private token WebSocket |
| `closePositionStop` | `true` | `closeOrder=true` and `reduceOnly=true` |
| `testnet` | `true` | `api-sandbox-futures.kucoin.com` |

## Precision, Multiplier & Stop Rules
- Bitcoin is mapped to `XBTUSDTM`.
- Order `size` is integer lots where each lot equals `multiplier` base coins (e.g., `0.001 BTC` per lot).
- Stop orders use `stopPriceType="MP"` (Mark Price) to prevent last-price wick stop-outs.
