# Base images pinned by digest for reproducible builds. Bump deliberately;
# resolve a new digest with `docker buildx imagetools inspect <image:tag>`.
FROM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS chef
RUN cargo install cargo-chef --locked --version 0.1.77
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
# Deterministic codegen: remap absolute build paths out of the binary and
# disable incremental artifacts. (strip + codegen-units=1 live in Cargo.toml.)
ENV CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/app=. --remap-path-prefix=/usr/local/cargo=/cargo"
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --locked --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked --bin scribe

FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb AS runtime
# CA bundle copied from the pinned builder base instead of apt-installed:
# removes the only build-time network fetch and its version drift.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin scribe
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /app/target/release/scribe /usr/local/bin/scribe
COPY config.toml /app/config.toml
USER scribe
EXPOSE 8080
ENV RUST_LOG=scribe=info,scribe_api=info,scribe_services=info,scribe_providers=info,tower_http=info
ENTRYPOINT ["scribe"]
CMD ["serve"]
