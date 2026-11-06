# Bybit V5 Linear Futures Adapter Reference

## Endpoints & Signing
- **REST Base URL**: `https://api.bybit.com` (Testnet: `https://api-testnet.bybit.com`)
- **Signing Scheme**: Bybit V5 `X-BAPI-SIGN` HMAC-SHA256 hex digest over `timestamp + apiKey + recvWindow + payload`.
- **Key Endpoints**:
  - `GET /v5/market/time` - Server time synchronization
  - `GET /v5/market/instruments-info?category=linear` - Tick size, lot size, min notional, leverage bounds
  - `GET /v5/market/orderbook?category=linear` - L2 order book depth
  - `POST /v5/order/create` - Market, Limit IOC, attached SL/TP, and conditional orders
  - `POST /v5/position/trading-stop` - Atomic stop-loss and trailing-stop updates
  - `GET /v5/position/list?category=linear` - Active linear positions

## Capabilities Matrix
| Capability | Supported | Notes |
|---|---|---|
| `trading` | `true` | Unified Trading Account V5 Linear |
| `ioc` | `true` | `timeInForce="IOC"` |
| `attachedSlTp` | `true` | `stopLoss` and `slTriggerBy="MarkPrice"` attached on entry order |
| `conditionalEndpoint` | `true` | `/v5/order/create` with `triggerPrice` and `triggerDirection` |
| `nativeTrail` | `true` | `/v5/position/trading-stop` |
| `atomicAmend` | `true` | `/v5/order/amend` and `/v5/position/trading-stop` |
| `privateWs` | `true` | V5 Private WebSocket `position` / `order` / `execution` topics |
| `closePositionStop` | `true` | `reduceOnly=true` and `closeOnTrigger=true` |
| `testnet` | `true` | `api-testnet.bybit.com` |

## Precision, Multiplier & Stop Rules
- Supports `1000PEPEUSDT`, `1000BONKUSDT` multiplier contracts (`symbolMultiplier` parsed and normalized to canonical base).
- Attached `stopLoss` triggers on `MarkPrice` (`slTriggerBy="MarkPrice"`), eliminating unprotected entry windows.
