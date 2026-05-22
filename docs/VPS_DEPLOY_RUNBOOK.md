# VPS Deploy Runbook Draft

## Known VPS

- SSH: `admin@188.245.144.148`
- Public IP to whitelist from PHI shared hosting: `188.245.144.148`

Use existing SSH agent/keychain/config. Do not search for or print private keys.

## Recommended Server Layout

```text
/opt/phi-gateway/
  app/
  config/
  logs/
  releases/
```

Do not install the PHI gateway under:

```text
/opt/logitaka
```

## Suggested Service

Name:

```text
phi-gateway.service
```

Suggested internal port:

```text
3200
```

Suggested systemd shape:

```ini
[Unit]
Description=PHI Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/phi-gateway/app
EnvironmentFile=/opt/phi-gateway/config/phi-gateway.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=admin

[Install]
WantedBy=multi-user.target
```

Adapt `ExecStart` after choosing the actual framework/build output.

## Suggested Nginx Shape

Use a separate host when DNS is ready:

```text
phi-gateway.logitaka.com
```

Proxy to:

```text
http://127.0.0.1:3200
```

Keep Logitaka's `app.logitaka.com` and `ops.logitaka.com` configs untouched unless explicitly needed.

## Config Files

Example:

```text
/opt/phi-gateway/config/phi-gateway.env
/opt/phi-gateway/config/clients.json
/opt/phi-gateway/config/providers.json
/opt/phi-gateway/config/model-aliases.json
```

Secrets:

- Provider API keys may live in env or root-protected config.
- PHI client bearer key should be stored as a hash in `clients.json`.
- Show generated raw PHI key only once to the user, then keep only the hash/hint.

## Smoke Tests

```bash
curl -sS https://phi-gateway.logitaka.com/health
curl -sS https://phi-gateway.logitaka.com/v1/models -H "Authorization: Bearer $PHI_GATEWAY_API_KEY"
curl -sS https://phi-gateway.logitaka.com/phi/ekassa/receipt-image \
  -H "Authorization: Bearer $PHI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fiscal_id":"<SAFE_TEST_FISCAL_ID>"}'
```

## Deployment Principle

First version can be deployed manually over SSH. After the repo is created, prefer Git-based deploy into `/opt/phi-gateway/app`, separate from Logitaka's GitHub Actions deployment.

