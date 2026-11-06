# MEXC Futures Contract API v1 Adapter Reference

## Endpoints & Signing
- **REST Base URL**: `https://contract.mexc.com`
- **Signing Scheme**: MEXC Contract API v1 HMAC-SHA256 hex digest over `apiKey + reqTime + payload`.
- **Key Endpoints**:
  - `GET /api/v1/contract/ping` - Server time & reachability
  - `GET /api/v1/contract/detail` - Contract specifications (`contractSize`, `priceUnit`, `volUnit`)
  - `GET /api/v1/contract/depth/{symbol}` - Public L2 order book
  - `POST /api/v1/private/order/create` - Order placement (subject to runtime capability probe)
  - `POST /api/v1/private/stoporder/create` - Stop order creation

## Capabilities Matrix
| Capability | Supported | Notes |
|---|---|---|
| `trading` | `probe-dependent` | `false` by default until `probeCapability()` confirms order endpoint is online |
| `ioc` | `probe-dependent` | Enabled when `trading=true` |
| `attachedSlTp` | `false` | Uses `/api/v1/private/stoporder/create` when operational |
| `conditionalEndpoint` | `probe-dependent` | `/api/v1/private/stoporder/create` |
| `nativeTrail` | `false` | Not supported |
| `atomicAmend` | `false` | Uses Never-Unprotected `place-new-then-cancel-old` stop sequence |
| `privateWs` | `false` | Polled reconciliation fallback |
| `closePositionStop` | `true` | Supported when order endpoint is operational |
| `testnet` | `false` | No public futures testnet; uses Paper simulator |

## Precision, Multiplier & Stop Rules
- Public market data (`depth`, `ticker`, `detail`) is always available for EQE and Paper simulation.
- Live order execution requires passing `probeCapability()`; if the futures order API is under maintenance, MEXC is automatically excluded from live routing and restricted to Paper mode (`EC-29`).
