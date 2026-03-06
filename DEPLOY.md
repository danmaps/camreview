# CamReview deploy (Docker, Tailscale-only)

## Defaults
- Port: **3510**
- Bind: **100.87.16.33:3510** (Tailscale IP)
- Media root inside container: `/data/trailcam`
- Host media path (edit as needed): `/mnt/usb/trailcam`

## One-time setup
- Update `docker-compose.yml` volume if your USB path differs.
- Update `config.local.json` if you want different options.

## Run
```bash
cd /home/openclaw/.openclaw/workspace/camreview
bash deploy-pull.sh
```

## Access
`http://100.87.16.33:3510`

If your Tailscale IP changes, update `docker-compose.yml` or bind to `0.0.0.0`.
