# Automatic private model rollout

June supports `open-software/auto` while retaining explicit model selection. Auto persists a
Cost-to-quality preference and forwards it through Hermes and note generation.

The rollout remains reversible. Set `JUNE__UPSTREAMS__VENICE__BASE_URL` to
`https://api.opensoftware.co/v1` and provide the dedicated os-api service key through the existing
`JUNE__UPSTREAMS__VENICE__API_KEY` sealed secret. Then
build the desktop release with `OS_JUNE_AUTO_MODE_DEFAULT=true`. Existing users retain their saved
model. Roll back by restoring the upstream URL and removing the build flag.
