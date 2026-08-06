# Base images pinned by digest for reproducible builds. Bump deliberately;
# resolve a new digest with `docker buildx imagetools inspect <image:tag>`.
FROM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS chef
RUN cargo install cargo-chef --locked --version 0.1.77
WORKDIR /app

# The build context is the repository root: clovy-api depends on the shared
# companion wire-protocol crate that lives outside this directory, so the
# workspace and that crate are copied to the exact paths the Cargo path
# dependency (../../../crates/clovy-companion-protocol) resolves to.
FROM chef AS planner
COPY clovy-api/ .
COPY crates/clovy-companion-protocol /crates/clovy-companion-protocol
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
# Deterministic codegen: remap absolute build paths out of the binary and
# disable incremental artifacts. (strip + codegen-units=1 live in Cargo.toml.)
ENV CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/app=. --remap-path-prefix=/usr/local/cargo=/cargo"
COPY --from=planner /app/recipe.json recipe.json
COPY crates/clovy-companion-protocol /crates/clovy-companion-protocol
RUN cargo chef cook --release --locked --recipe-path recipe.json
COPY clovy-api/ .
RUN cargo build --release --locked --bin clovy-api

FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb AS runtime
# CA bundle copied from the pinned builder base instead of apt-installed:
# removes the only build-time network fetch and its version drift.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin clovy
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /app/target/release/clovy-api /usr/local/bin/clovy-api
COPY clovy-api/config.toml /app/config.toml
# Source commit stamped into the runtime env so /verify can report which
# public commit this image was built from. Build-arg only: the same commit
# always passes the same value, so the image digest stays reproducible, and
# the binary itself is unaffected.
ARG GIT_SHA=""
ENV CLOVY__ATTESTATION__SOURCE_COMMIT=${GIT_SHA}
USER clovy
EXPOSE 8080
ENV RUST_LOG=clovy_api=info,clovy_services=info,clovy_providers=info,tower_http=info
ENTRYPOINT ["clovy-api"]
CMD ["serve"]
