# e-Kassa Outbound Tunnel Setup

The Azerbaijani tax office server (`monitoring.e-kassa.gov.az`) geo-blocks all non-Azerbaijani IP addresses (including VPS/cloud ranges). To fetch receipt images, the gateway must route its calls through a proxy located in Azerbaijan.

Since your local macOS machine is connected in Azerbaijan and has access, we set up a secure **Reverse SSH Tunnel** that forwards the VPS's outbound e-Kassa requests back to a lightweight HTTP/HTTPS proxy running locally on your Mac.

---

## Architecture Overview

```mermaid
sequenceDiagram
    participant PHI Backend
    participant VPS Gateway (Port 3200)
    participant SSH Tunnel (Port 8123)
    participant Local Mac Proxy (Port 8123)
    participant e-Kassa Server

    PHI Backend->>VPS Gateway: POST /phi/ekassa/receipt-image
    VPS Gateway->>SSH Tunnel: Fetch (via 127.0.0.1:8123)
    SSH Tunnel->>Local Mac Proxy: Forward TCP connection
    Local Mac Proxy->>e-Kassa Server: Fetch document (from AZ network)
    e-Kassa Server-->>Local Mac Proxy: 200 OK (JPEG)
    Local Mac Proxy-->>SSH Tunnel: Return binary image
    SSH Tunnel-->>VPS Gateway: Return HTTP response
    VPS Gateway-->>PHI Backend: Return 200 OK (Base64 JPEG)
```

---

## How to Restart the Tunnel (If Local Mac or SSH Closes)

If the local proxy server or the SSH connection is interrupted, e-Kassa requests will fail with `504 Gateway Timeout` or `502 Bad Gateway`. Follow these steps to restore the tunnel:

### Step 1: Start the Local Proxy on macOS
Open your local terminal and start the zero-dependency HTTP proxy:
```bash
node /Users/faignaghiyev/DEV/PHI-backend-vps/scratch/local-proxy.js
```
*(Runs in the foreground. Keep this terminal window open or run in background).*

### Step 2: Establish the Reverse SSH Tunnel
In a new terminal window, connect to the VPS with remote port forwarding:
```bash
ssh -N -R 8123:127.0.0.1:8123 admin@188.245.144.148
```
* `-N`: Do not execute a remote command (just forward ports).
* `-R 8123:127.0.0.1:8123`: Forwards port `8123` on the VPS to `127.0.0.1:8123` on your Mac.

---

## VPS Configuration Reference
The VPS environment file `/opt/phi-gateway/config/phi-gateway.env` is configured with:
```env
EKASSA_PROXY=http://127.0.0.1:8123
```
If the tunnel port is changed, update this variable in `/opt/phi-gateway/config/phi-gateway.env` and run `sudo systemctl restart phi-gateway.service`.
