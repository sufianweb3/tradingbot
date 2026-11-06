# Gate.io USDT Futures APIv4 Adapter Reference

## Endpoints & Signing
- **REST Base URL**: `https://fx-api.gateio.ws` (Testnet: `https://fx-api-testnet.gateio.ws`)
- **Signing Scheme**: Gate APIv4 HMAC-SHA512 over `METHOD\nPATH\nQUERY\nSHA512(BODY)\nTIMESTAMP`.
- **Key Endpoints**:
  - `GET /api/v4/spot/time` - Server clock sync
  - `GET /api/v4/futures/usdt/contracts` - Contract multiplier (`quanto_multiplier`), lot size, tick size
  - `GET /api/v4/futures/usdt/order_book` - L2 order book depth (contract sizes multiplied by `quanto_multiplier`)
  - `POST /api/v4/futures/usdt/orders` - Market (`price="0", tif="ioc"`), Limit IOC, and Reduce-Only Limit orders
  - `POST /api/v4/futures/usdt/price_orders` - Conditional stop-loss orders (`close=true`)

## Capabilities Matrix
| Capability | Supported | Notes |
|---|---|---|
| `trading` | `true` | Gate.io USDT-settled perpetual futures |
| `ioc` | `true` | `tif="ioc"` on limit and market orders |
| `attachedSlTp` | `false` | Placed immediately after entry via `/futures/usdt/price_orders` |
| `conditionalEndpoint` | `true` | `/api/v4/futures/usdt/price_orders` |
| `nativeTrail` | `false` | Engine-managed Never-Unprotected stop updates |
| `atomicAmend` | `true` | Order amendment supported |
| `privateWs` | `true` | Gate Futures WebSocket v4 |
| `closePositionStop` | `true` | `initial.close=true` on price-triggered orders |
| `testnet` | `true` | `fx-api-testnet.gateio.ws` |

## Precision, Multiplier & Stop Rules
- Gate.io sizes (`size`) are integer contract counts (negative for short, positive for long).
- Each contract represents `quanto_multiplier` base coins (`canonicalBaseQty = contracts * quanto_multiplier`).
- Client order IDs must be prefixed with `t-` and max 28 bytes (`EC-26`).
