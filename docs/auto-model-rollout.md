# Automatic private model rollout

June supports `open-software/auto` while retaining explicit model selection. Auto persists a
Cost-to-quality preference and forwards it through Hermes and note generation.

The rollout remains reversible. Production compose pins
`JUNE__UPSTREAMS__VENICE__BASE_URL` to `https://api.opensoftware.co/v1`; Phala's sealed
`JUNE__UPSTREAMS__VENICE__API_KEY` contains June's dedicated os-api service key.

Build the desktop release with `OS_JUNE_AUTO_MODE_DEFAULT=true`. Existing users retain their saved
model. Roll back by restoring the Venice URL in production compose and removing the build flag.
