# syntax=docker/dockerfile:1
#
# Multi-stage build for agent-eval-harness.
#
#   docker build --target test -t agent-eval-harness:test . \
#     && docker run --rm agent-eval-harness:test npm test       # 104 offline tests
#   docker build -t agent-eval-harness .                         # lean runtime
#   docker run --rm -e ANTHROPIC_API_KEY agent-eval-harness      # live calibration
#
# Base: node:22, matching .github/workflows/ci.yml. The -slim variant is used
# because the suite and the typecheck were run on it and pass; nothing here needs
# the compilers, git, or python that the full image carries.
#
# KEYS. src/calibrate-cli.ts is the only file in the project that reads
# process.env; every other module takes its key as a parameter. This Dockerfile
# keeps that discipline: there is no ARG or ENV for ANTHROPIC_API_KEY, no default,
# nothing copied in (.env is excluded from the build context by .dockerignore),
# and no layer that could hold one. The key exists only in the container's
# environment at run time, supplied by `docker run -e ANTHROPIC_API_KEY`, and is
# read by the same single line of code CI uses. Without it the CLI exits 2 with
# its own setup message — the image adds no second route in.

ARG NODE_IMAGE=node:22-slim

# ---------------------------------------------------------------------------
# deps: full install (dev included), cached on the lockfile alone. Source edits
# do not invalidate this layer; only package.json / package-lock.json do.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# test: everything the suite and the typecheck need. test/golden.test.ts loads
# the real cases/ directory, so cases/ is required here, not just in runtime.
# ---------------------------------------------------------------------------
FROM deps AS test
WORKDIR /app
COPY tsconfig.json ./
COPY src/ src/
COPY test/ test/
COPY cases/ cases/
# Typecheck at build time so a `--target test` build that succeeds already
# proves `tsc --noEmit` — the same gate ci.yml runs before vitest.
RUN npx tsc --noEmit
CMD ["npm", "test"]

# ---------------------------------------------------------------------------
# build: compile TypeScript to JavaScript. The runtime cannot execute src/*.ts
# directly: tsx is a devDependency and is absent under --omit=dev, and Node's
# built-in type stripping cannot resolve the `./calibrate.js` import specifiers
# the source uses (verified: it fails with ERR_MODULE_NOT_FOUND). tsc emits
# dist/ with real .js files that plain `node` runs.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# ---------------------------------------------------------------------------
# runtime: only what the CLI needs. Production dependencies (the Anthropic SDK),
# the compiled dist/, the golden set, and the committed receipts.
#
# Test tooling (vitest, tsx, typescript, @types/node) is deliberately absent:
# `npm ci --omit=dev` installs only `dependencies`. The runtime's job is to run
# one calibration and exit with a gate verdict; a test runner in the image would
# be ~60MB of attack surface and cache churn that never executes.
#
# cases/ IS shipped: the CLI defaults to `cases` relative to the working
# directory, and a harness image that could not run its own calibration because
# the golden set was left out would build cleanly and then be useless.
#
# Layout mirrors the repository — dist/, cases/, results/ as siblings under
# /app, with WORKDIR /app — so the CLI's relative `cases` and `results` paths
# resolve exactly as they do in a checkout.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && find node_modules -type d -empty -delete
COPY --from=build /app/dist/ dist/
COPY --chown=node:node cases/ cases/
COPY --chown=node:node results/ results/
# Non-root: the only write the CLI performs is a new results/*.json, and `node`
# owns results/ (copied with --chown above). Mount a host results/ over it with
# -v "$PWD/results:/app/results" to keep run artifacts outside the container.
USER node
ENTRYPOINT ["node", "dist/calibrate-cli.js"]
