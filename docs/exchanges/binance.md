# Binance USDT-M Futures Adapter Reference

## Endpoints & Signing
- **REST Base URL**: `https://fapi.binance.com` (Testnet: `https://testnet.binancefuture.com`)
- **Signing Scheme**: HMAC-SHA256 hex digest over sorted query string with `timestamp` and `recvWindow`.
- **Key Endpoints**:
  - `GET /fapi/v1/time` - Server time synchronization
  - `GET /fapi/v1/exchangeInfo` - Contract rules, `LOT_SIZE`, `PRICE_FILTER`, `MIN_NOTIONAL`
  - `GET /fapi/v1/depth` - L2 order book snapshot
  - `GET /fapi/v1/premiumIndex` - Mark price, index price, and funding rate
  - `POST /fapi/v1/order` - Market, Limit IOC, Stop-Market (`closePosition=true`), and Reduce-Only Limit orders
  - `GET /fapi/v2/positionRisk` - Active positions and liquidation price

## Capabilities Matrix
| Capability | Supported | Notes |
|---|---|---|
| `trading` | `true` | Full USDT-M linear perpetual execution |
| `ioc` | `true` | `timeInForce=IOC` on `LIMIT` orders |
| `attachedSlTp` | `false` | Separate `STOP_MARKET` conditional order required immediately after entry |
| `conditionalEndpoint` | `true` | `STOP_MARKET` / `TAKE_PROFIT_MARKET` via `/fapi/v1/order` |
| `nativeTrail` | `true` | `TRAILING_STOP_MARKET` supported |
| `atomicAmend` | `false` | Uses Never-Unprotected `place-new-then-cancel-old` stop sequence |
| `privateWs` | `true` | User Data Stream via `listenKey` |
| `closePositionStop` | `true` | `closePosition=true` supported on `STOP_MARKET` |
| `testnet` | `true` | `testnet.binancefuture.com` |

## Precision, Multiplier & Stop Rules
- Quantities are denominated in base asset units (or `1000SHIBUSDT` scaled base units where `symbolMultiplier = 1000`).
- `stepSize` and `tickSize` are enforced via floor-toward-entry for stop losses and integer-step truncation for quantities.
- `STOP_MARKET` orders trigger on `MARK_PRICE` (`workingType=MARK_PRICE`).
